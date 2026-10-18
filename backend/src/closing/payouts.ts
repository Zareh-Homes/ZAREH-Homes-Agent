/**
 * Agent payouts after a closing. The payer (lawyer or listing brokerage) pays
 * the brokerage only; the brokerage then pays each agent. Three separate
 * steps, each recorded append-only and re-checked by the database (migration 006):
 *
 *   1. Commission received  admin / managing broker records the incoming payment
 *      (then matched to the operating account's bank statement, see bank/service.ts)
 *   2. Payout approved      managing broker, only once the commission is in full and matched to the bank
 *   3. Payout paid          admin / managing broker, with the payment reference
 *
 * A closing paid entirely from the deposit in trust has nothing to receive,
 * so its payouts can be approved as soon as it's finalized.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { requireRole, TRUST_AUTHORIZERS, TRUST_VIEWERS, type Actor } from "../auth.ts";
import { ConflictError, DomainError, fromDatabaseError, NotFoundError, RuleViolationError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { formatCents, numericToCents, type Cents } from "../lib/money.ts";
import { Reader } from "../lib/reader.ts";
import type { ClosingComputation } from "./calculate.ts";

const PAYMENT_RECORDERS = ["ADMIN", "MANAGING_BROKER"] as const;

export type PayoutStatus = "AWAITING_COMMISSION" | "AWAITING_BANK_MATCH" | "READY_FOR_APPROVAL" | "APPROVED" | "PAID";

export interface PayoutView {
  id: string;
  userId: string;
  payeeName: string;
  netPayout: string;
  status: PayoutStatus;
  approvedAt: string | null;
  paidAt: string | null;
  paymentReference: string | null;
}

export interface PayoutsView {
  closingId: string;
  cdaNumber: string;
  commissionDue: string;
  commissionReceived: string;
  receipts: { id: string; amount: string; receivedDate: string; reference: string; bankMatched: boolean }[];
  payouts: PayoutView[];
}

interface Deps {
  prisma: PrismaClient;
  today?: () => string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const centsOf = (d: Prisma.Decimal) => numericToCents(d.toFixed(2));

async function statementFor(prisma: PrismaClient | Prisma.TransactionClient, dealId: string) {
  const statement = await prisma.closingStatement.findUnique({
    where: { transactionId: dealId },
    include: {
      receipts: { orderBy: { recordedAt: "asc" }, include: { bankMatch: { select: { id: true } } } },
      payouts: { orderBy: { payeeName: "asc" }, include: { events: true } },
    },
  });
  if (!statement) throw new NotFoundError("Finalized closing for deal", dealId);
  return statement;
}

export async function getPayouts(deps: Deps, actor: Actor, dealId: string): Promise<PayoutsView> {
  requireRole(actor, TRUST_VIEWERS, "Viewing agent payouts");
  const s = await statementFor(deps.prisma, dealId);
  const due: Cents = (s.computation as unknown as ClosingComputation).wiresTotal;
  const received = s.receipts.reduce((sum, r) => sum + centsOf(r.amount), 0);
  const allMatched = s.receipts.every((r) => r.bankMatch !== null);
  return {
    closingId: s.id,
    cdaNumber: s.cdaNumber,
    commissionDue: formatCents(due),
    commissionReceived: formatCents(received),
    receipts: s.receipts.map((r) => ({
      id: r.id, amount: r.amount.toFixed(2), receivedDate: iso(r.receivedDate), reference: r.reference, bankMatched: r.bankMatch !== null,
    })),
    payouts: s.payouts.map((p) => {
      const approved = p.events.find((e) => e.kind === "APPROVED");
      const paid = p.events.find((e) => e.kind === "PAID");
      const status: PayoutStatus = paid ? "PAID" : approved ? "APPROVED"
        : received < due ? "AWAITING_COMMISSION" : allMatched ? "READY_FOR_APPROVAL" : "AWAITING_BANK_MATCH";
      return {
        id: p.id,
        userId: p.userId,
        payeeName: p.payeeName,
        netPayout: p.netPayout.toFixed(2),
        status,
        approvedAt: approved ? iso(approved.eventDate) : null,
        paidAt: paid ? iso(paid.eventDate) : null,
        paymentReference: paid?.reference ?? null,
      };
    }),
  };
}

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  const code = (err as { meta?: { code?: string } })?.meta?.code;
  if (code === "23505") throw new ConflictError("PAYOUT_ALREADY_RECORDED", "That step has already been recorded for this payout");
  throw fromDatabaseError(err) ?? err;
}

export async function recordCommissionReceived(deps: Deps, actor: Actor, dealId: string, body: unknown): Promise<PayoutsView> {
  requireRole(actor, PAYMENT_RECORDERS, "Recording commission received");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body, ["amount", "receivedDate", "reference"]);
  const input = { amount: r.amount("amount"), receivedDate: r.pastDate("receivedDate", today), reference: r.text("reference", 100) };
  r.done();

  const s = await statementFor(deps.prisma, dealId);
  const due: Cents = (s.computation as unknown as ClosingComputation).wiresTotal;
  const received = s.receipts.reduce((sum, x) => sum + centsOf(x.amount), 0);
  if (received + input.amount > due) {
    throw new RuleViolationError(
      "COMMISSION_OVER_RECEIVED",
      `This closing is owed $${formatCents(due)}; $${formatCents(received)} is already recorded`,
    );
  }
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO "CommissionReceipt" (id, "closingId", amount, "receivedDate", reference, "recordedById")
      VALUES (gen_random_uuid(), ${s.id}::uuid, ${formatCents(input.amount)}::numeric, ${input.receivedDate}::date,
              ${input.reference}, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return getPayouts(deps, actor, dealId);
}

async function payoutOf(deps: Deps, payoutId: string) {
  const payout = await deps.prisma.closingAgentPayout.findUnique({
    where: { id: payoutId }, select: { id: true, closing: { select: { transactionId: true } } },
  });
  if (!payout) throw new NotFoundError("Payout", payoutId);
  return payout;
}

export async function approvePayout(deps: Deps, actor: Actor, payoutId: string, body: unknown): Promise<PayoutsView> {
  requireRole(actor, TRUST_AUTHORIZERS, "Approving an agent payout");
  const r = new Reader(body ?? {}, ["note"]);
  const note = r.optionalText("note", 1000);
  r.done();
  const payout = await payoutOf(deps, payoutId);
  const view = await getPayouts(deps, actor, payout.closing.transactionId);
  const current = view.payouts.find((p) => p.id === payoutId)!;
  if (current.status === "AWAITING_COMMISSION") {
    throw new RuleViolationError(
      "COMMISSION_NOT_RECEIVED",
      `The commission for ${view.cdaNumber} hasn't been received in full ($${view.commissionReceived} of $${view.commissionDue})`,
    );
  }
  if (current.status === "AWAITING_BANK_MATCH") {
    throw new RuleViolationError(
      "COMMISSION_NOT_CLEARED",
      `The commission for ${view.cdaNumber} is recorded but not yet matched to the operating account's bank statement`,
    );
  }
  if (current.status !== "READY_FOR_APPROVAL") throw new ConflictError("PAYOUT_ALREADY_APPROVED", "This payout is already approved");
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO "AgentPayoutEvent" (id, "payoutId", kind, "actorId", "eventDate", note)
      VALUES (gen_random_uuid(), ${payoutId}::uuid, 'APPROVED', ${actor.id}::uuid, ${deps.today?.() ?? todayInToronto()}::date, ${note})`;
  } catch (err) {
    rethrow(err);
  }
  return getPayouts(deps, actor, payout.closing.transactionId);
}

export async function markPayoutPaid(deps: Deps, actor: Actor, payoutId: string, body: unknown): Promise<PayoutsView> {
  requireRole(actor, PAYMENT_RECORDERS, "Recording an agent payment");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body, ["paidDate", "reference"]);
  const input = { paidDate: r.pastDate("paidDate", today), reference: r.text("reference", 100) };
  r.done();
  const payout = await payoutOf(deps, payoutId);
  const view = await getPayouts(deps, actor, payout.closing.transactionId);
  const current = view.payouts.find((p) => p.id === payoutId)!;
  if (current.status === "PAID") throw new ConflictError("PAYOUT_ALREADY_PAID", "This payout is already marked paid");
  if (current.status !== "APPROVED") {
    throw new RuleViolationError("PAYOUT_NOT_APPROVED", "A managing broker must approve this payout before it's paid");
  }
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO "AgentPayoutEvent" (id, "payoutId", kind, "actorId", "eventDate", reference)
      VALUES (gen_random_uuid(), ${payoutId}::uuid, 'PAID', ${actor.id}::uuid, ${input.paidDate}::date, ${input.reference})`;
  } catch (err) {
    rethrow(err);
  }
  return getPayouts(deps, actor, payout.closing.transactionId);
}
