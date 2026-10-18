/**
 * Paying out a closing. The payer (lawyer or listing brokerage) pays the
 * brokerage only; the brokerage then pays each agent, and any co-op brokerage
 * or referral it owes. Every step is an append-only record, re-checked by the
 * database (migrations 006, 009):
 *
 *   1. Commission received   admin / broker records the payment and which account it landed in
 *                            (operating or commission trust). A receipt can be reversed.
 *   2. Verified at the bank  matched to a line of a bank file that a second person verified
 *                            (a same-day interim file is enough; see bank/service.ts)
 *   3. Approved              managing broker who didn't record or match the commission, with a
 *                            fresh verified balance showing the money is actually available
 *   4. Paid                  someone other than the approver, with the payment reference
 *   (5. Payment reversed     a returned EFT; it can then be paid again, or the approval cancelled)
 *
 * Co-op and referral payables can't be approved until the THIRD_PARTY_PAYABLES
 * policy has counsel / accountant sign-off. No money is moved by this code.
 */

import type { PrismaClient } from "@prisma/client";
import { requireRole, TRUST_VIEWERS, type Actor } from "../auth.ts";
import { ConflictError, DomainError, fromDatabaseError, NotFoundError, RuleViolationError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { formatCents, numericToCents, type Cents } from "../lib/money.ts";
import { Reader } from "../lib/reader.ts";
import type { ClosingComputation } from "./calculate.ts";

const PAYMENT_RECORDERS = ["ADMIN", "MANAGING_BROKER"] as const;

export type PayoutStatus =
  | "AWAITING_COMMISSION"
  | "AWAITING_BANK_VERIFICATION"
  | "AWAITING_POLICY_APPROVAL"
  | "READY_FOR_APPROVAL"
  | "APPROVED"
  | "PAID"
  | "PAYMENT_RETURNED"
  | "NOTHING_OWED";

export interface PayoutLine {
  id: string;
  kind: "AGENT" | "COOP_BROKERAGE" | "REFERRAL";
  userId: string | null;
  payeeName: string;
  amount: string; // full entitlement under this CDA
  carriedForward: string; // already paid under a voided CDA
  remaining: string; // what this CDA still pays (negative = overpaid, to be recovered)
  status: PayoutStatus;
  approvedAt: string | null;
  paidAt: string | null;
  paymentReference: string | null;
  recoveryRequired: boolean; // paid, but the commission behind it was later reversed
  history: { kind: string; eventDate: string; amount: string | null; reference: string | null; note: string | null; by: string }[];
}

export interface PayoutsView {
  closingId: string;
  cdaNumber: string;
  revision: number;
  commissionDue: string;
  commissionReceived: string;
  receipts: {
    id: string; amount: string; receivedDate: string; reference: string; account: { type: "OPERATING" | "COMMISSION_TRUST"; id: string } | null;
    bankVerified: boolean; reversed: boolean;
  }[];
  payouts: PayoutLine[];
}

interface Deps {
  prisma: PrismaClient;
  today?: () => string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  throw fromDatabaseError(err) ?? err;
}

/** The deal's CDA in force: the latest revision, unless it was voided and not yet reissued. */
export async function activeClosing(prisma: PrismaClient, dealId: string) {
  const latest = await prisma.closingStatement.findFirst({
    where: { transactionId: dealId }, orderBy: { revision: "desc" }, include: { void: true },
  });
  if (!latest || latest.void) throw new NotFoundError("Finalized CDA in force for deal", dealId);
  return latest;
}

export async function getPayouts(deps: Deps, actor: Actor, dealId: string): Promise<PayoutsView> {
  requireRole(actor, TRUST_VIEWERS, "Viewing payouts");
  const s = await activeClosing(deps.prisma, dealId);
  const due: Cents = (s.computation as unknown as ClosingComputation).wiresTotal;

  const receipts = await deps.prisma.$queryRaw<{
    id: string; amount: string; receivedDate: string; reference: string; trustAccountId: string | null; operatingAccountId: string | null;
    verified: boolean; reversed: boolean;
  }[]>`
    SELECT r.id::text, r.amount::text, to_char(r."receivedDate", 'YYYY-MM-DD') AS "receivedDate", r.reference,
           r."trustAccountId"::text, r."operatingAccountId"::text, receipt_cleared(r.id) AS verified,
           EXISTS (SELECT 1 FROM "CommissionReceiptReversal" x WHERE x."receiptId" = r.id) AS reversed
      FROM "CommissionReceipt" r JOIN "ClosingStatement" c ON c.id = r."closingId"
     WHERE c."transactionId" = ${dealId}::uuid ORDER BY r."recordedAt"`;
  const received = receipts.filter((r) => !r.reversed).reduce((sum, r) => sum + numericToCents(r.amount), 0);
  const allVerified = receipts.filter((r) => !r.reversed).every((r) => r.verified);
  const [{ enabled: thirdPartyEnabled }] = await deps.prisma.$queryRaw<{ enabled: boolean }[]>`
    SELECT policy_enabled('THIRD_PARTY_PAYABLES') AS enabled`;

  const [agents, payables] = await Promise.all([
    deps.prisma.closingAgentPayout.findMany({
      where: { closingId: s.id }, orderBy: { payeeName: "asc" },
      include: { events: { orderBy: { seq: "asc" }, include: { actor: { select: { firstName: true, lastName: true } } } } },
    }),
    deps.prisma.closingPayable.findMany({
      where: { closingId: s.id }, orderBy: [{ payeeType: "asc" }, { payeeName: "asc" }],
      include: { events: { orderBy: { seq: "asc" }, include: { actor: { select: { firstName: true, lastName: true } } } } },
    }),
  ]);

  type Ev = (typeof agents)[number]["events"][number];
  const line = (
    p: { id: string; payeeName: string; carriedForward: { toFixed(n: number): string } },
    kind: PayoutLine["kind"], userId: string | null, amount: Cents, events: Ev[],
  ): PayoutLine => {
    const carried = numericToCents(p.carriedForward.toFixed(2));
    const remaining = amount - carried;
    const last = events.at(-1);
    const approved = [...events].reverse().find((e) => e.kind === "APPROVED");
    const paid = last?.kind === "PAID" ? last : null;
    const status: PayoutStatus =
      last?.kind === "APPROVED" ? "APPROVED"
      : last?.kind === "PAID" ? "PAID"
      : last?.kind === "PAYMENT_REVERSED" ? "PAYMENT_RETURNED"
      : remaining <= 0 ? "NOTHING_OWED"
      : received < due ? "AWAITING_COMMISSION"
      : !allVerified ? "AWAITING_BANK_VERIFICATION"
      : kind !== "AGENT" && !thirdPartyEnabled ? "AWAITING_POLICY_APPROVAL"
      : "READY_FOR_APPROVAL";
    return {
      id: p.id, kind, userId, payeeName: p.payeeName,
      amount: formatCents(amount), carriedForward: formatCents(carried), remaining: formatCents(remaining),
      status,
      approvedAt: approved && last?.kind !== "CANCELLED" ? iso(approved.eventDate) : null,
      paidAt: paid ? iso(paid.eventDate) : null,
      paymentReference: paid?.reference ?? null,
      recoveryRequired: status === "PAID" && received < due,
      history: events.map((e) => ({
        kind: e.kind, eventDate: iso(e.eventDate), amount: e.amount?.toFixed(2) ?? null, reference: e.reference, note: e.note,
        by: `${e.actor.firstName} ${e.actor.lastName}`,
      })),
    };
  };

  return {
    closingId: s.id,
    cdaNumber: s.cdaNumber,
    revision: s.revision,
    commissionDue: formatCents(due),
    commissionReceived: formatCents(received),
    receipts: receipts.map((r) => ({
      id: r.id, amount: r.amount, receivedDate: r.receivedDate, reference: r.reference,
      account: r.operatingAccountId ? { type: "OPERATING", id: r.operatingAccountId }
        : r.trustAccountId ? { type: "COMMISSION_TRUST", id: r.trustAccountId } : null,
      bankVerified: r.verified, reversed: r.reversed,
    })),
    payouts: [
      ...agents.map((p) => line(p, "AGENT", p.userId, numericToCents(p.netPayout.toFixed(2)), p.events)),
      ...payables.map((p) => line(p, p.payeeType, null, numericToCents(p.amount.toFixed(2)), p.events)),
    ],
  };
}

function readAccount(r: Reader, field: string) {
  const a = r.nested(field, ["type", "id"]);
  return { type: a.oneOf("type", ["OPERATING", "COMMISSION_TRUST"] as const), id: a.uuid("id") };
}

export async function recordCommissionReceived(deps: Deps, actor: Actor, dealId: string, body: unknown): Promise<PayoutsView> {
  requireRole(actor, PAYMENT_RECORDERS, "Recording commission received");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body, ["amount", "receivedDate", "reference", "account"]);
  const input = {
    amount: r.amount("amount"), receivedDate: r.pastDate("receivedDate", today), reference: r.text("reference", 100),
    account: readAccount(r, "account"),
  };
  r.done();

  const s = await activeClosing(deps.prisma, dealId);
  const view = await getPayouts(deps, actor, dealId);
  const due = numericToCents(view.commissionDue);
  const received = numericToCents(view.commissionReceived);
  if (received + input.amount > due) {
    throw new RuleViolationError(
      "COMMISSION_OVER_RECEIVED",
      `This closing is owed $${formatCents(due)}; $${formatCents(received)} is already recorded`,
    );
  }
  const trust = input.account.type === "COMMISSION_TRUST" ? input.account.id : null;
  const operating = input.account.type === "OPERATING" ? input.account.id : null;
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO "CommissionReceipt" (id, "closingId", amount, "receivedDate", reference, "recordedById", "trustAccountId", "operatingAccountId")
      VALUES (gen_random_uuid(), ${s.id}::uuid, ${formatCents(input.amount)}::numeric, ${input.receivedDate}::date,
              ${input.reference}, ${actor.id}::uuid, ${trust}::uuid, ${operating}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return getPayouts(deps, actor, dealId);
}

/** A recalled or bounced commission payment. Anything not yet paid on it is blocked; anything paid is flagged for recovery. */
export async function reverseCommissionReceipt(deps: Deps, actor: Actor, receiptId: string, body: unknown): Promise<PayoutsView> {
  requireRole(actor, PAYMENT_RECORDERS, "Reversing a commission receipt");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body, ["reason", "reversedDate", "reference"]);
  const input = { reason: r.text("reason", 1000), reversedDate: r.pastDate("reversedDate", today), reference: r.optionalText("reference", 100) };
  r.done();
  const receipt = await deps.prisma.commissionReceipt.findUnique({ where: { id: receiptId }, include: { closing: { select: { transactionId: true } } } });
  if (!receipt) throw new NotFoundError("Commission receipt", receiptId);
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO "CommissionReceiptReversal" ("receiptId", reason, "reversedDate", reference, "actorId")
      VALUES (${receiptId}::uuid, ${input.reason}, ${input.reversedDate}::date, ${input.reference}, ${actor.id}::uuid)`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23505") {
      throw new ConflictError("RECEIPT_ALREADY_REVERSED", "This receipt is already reversed");
    }
    rethrow(err);
  }
  return getPayouts(deps, actor, receipt.closing.transactionId);
}

type Target = { kind: "payout" | "payable"; id: string };

async function dealOf(deps: Deps, t: Target): Promise<string> {
  const row = t.kind === "payout"
    ? await deps.prisma.closingAgentPayout.findUnique({ where: { id: t.id }, select: { closing: { select: { transactionId: true } } } })
    : await deps.prisma.closingPayable.findUnique({ where: { id: t.id }, select: { closing: { select: { transactionId: true } } } });
  if (!row) throw new NotFoundError(t.kind === "payout" ? "Payout" : "Payable", t.id);
  return row.closing.transactionId;
}

async function insertEvent(deps: Deps, t: Target, actor: Actor, kind: string, eventDate: string, extra: {
  reference?: string | null; note?: string | null; exceptionReason?: string | null;
  payFromTrust?: string | null; payFromOperating?: string | null; balanceStatementId?: string | null;
} = {}) {
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO "PayoutEvent" (id, "payoutId", "payableId", seq, kind, "actorId", "eventDate", reference, note, "exceptionReason",
                                 "payFromTrustAccountId", "payFromOperatingAccountId", "balanceStatementId")
      VALUES (gen_random_uuid(), ${t.kind === "payout" ? t.id : null}::uuid, ${t.kind === "payable" ? t.id : null}::uuid, 0,
              ${kind}::"PayoutEventKind", ${actor.id}::uuid, ${eventDate}::date, ${extra.reference ?? null}, ${extra.note ?? null},
              ${extra.exceptionReason ?? null}, ${extra.payFromTrust ?? null}::uuid, ${extra.payFromOperating ?? null}::uuid,
              ${extra.balanceStatementId ?? null}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
}

/** Managing broker. Checks segregation, cleared commission and available funds (all enforced by the database too). */
export async function approvePayout(deps: Deps, actor: Actor, t: Target, body: unknown): Promise<PayoutsView> {
  requireRole(actor, ["MANAGING_BROKER"], "Approving a payout");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body ?? {}, ["payFrom", "balanceStatementId", "note", "exceptionReason"]);
  const input = {
    payFrom: r.has("payFrom") ? readAccount(r, "payFrom") : null,
    balanceStatementId: r.optionalUuid("balanceStatementId"),
    note: r.optionalText("note", 1000),
    exceptionReason: r.optionalText("exceptionReason", 500),
  };
  r.done();
  const dealId = await dealOf(deps, t);
  const view = await getPayouts(deps, actor, dealId);
  const current = view.payouts.find((p) => p.id === t.id);
  if (!current) throw new RuleViolationError("CDA_VOIDED", "This payout belongs to a voided CDA; use the reissued one");
  const refusals: Partial<Record<PayoutStatus, [string, string]>> = {
    AWAITING_COMMISSION: ["COMMISSION_NOT_RECEIVED", `The commission for ${view.cdaNumber} hasn't been received in full ($${view.commissionReceived} of $${view.commissionDue})`],
    AWAITING_BANK_VERIFICATION: ["COMMISSION_NOT_CLEARED", `The commission for ${view.cdaNumber} is recorded but not yet matched to a verified bank record`],
    AWAITING_POLICY_APPROVAL: ["POLICY_NOT_APPROVED", "Co-op and referral payments stay disabled until counsel and the accountant approve how those funds are held"],
    NOTHING_OWED: ["NOTHING_OWED", "Nothing is owed on this payout under the current CDA"],
  };
  const refusal = refusals[current.status];
  if (refusal) throw new RuleViolationError(refusal[0], refusal[1]);
  if (current.status !== "READY_FOR_APPROVAL") throw new ConflictError("PAYOUT_ALREADY_APPROVED", "This payout is already approved");

  // Default the paying account to where the commission was received
  const payFrom = input.payFrom ?? (() => {
    const accounts = new Set(view.receipts.filter((x) => !x.reversed && x.account).map((x) => `${x.account!.type}:${x.account!.id}`));
    if (accounts.size !== 1) return null;
    const [type, id] = [...accounts][0]!.split(":") as ["OPERATING" | "COMMISSION_TRUST", string];
    return { type, id };
  })();
  if (!payFrom) throw new RuleViolationError("PAY_FROM_REQUIRED", "Say which account the payment will come from (payFrom)");
  const balanceStatementId = input.balanceStatementId ?? (await latestVerifiedBalance(deps, payFrom))?.id ?? null;
  if (!balanceStatementId) {
    throw new RuleViolationError("FUNDS_NOT_AVAILABLE", "No verified bank balance for the paying account. Import today's bank balance and have it verified first.");
  }
  await insertEvent(deps, t, actor, "APPROVED", today, {
    note: input.note, exceptionReason: input.exceptionReason, balanceStatementId,
    payFromTrust: payFrom.type === "COMMISSION_TRUST" ? payFrom.id : null,
    payFromOperating: payFrom.type === "OPERATING" ? payFrom.id : null,
  });
  return getPayouts(deps, actor, dealId);
}

async function latestVerifiedBalance(deps: Deps, account: { type: "OPERATING" | "COMMISSION_TRUST"; id: string }) {
  return deps.prisma.bankStatement.findFirst({
    where: {
      ...(account.type === "OPERATING" ? { operatingAccountId: account.id } : { trustAccountId: account.id }),
      verification: { isNot: null },
    },
    orderBy: [{ periodEnd: "desc" }, { importedAt: "desc" }],
    select: { id: true },
  });
}

export async function markPayoutPaid(deps: Deps, actor: Actor, t: Target, body: unknown): Promise<PayoutsView> {
  requireRole(actor, PAYMENT_RECORDERS, "Recording a payment");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body, ["paidDate", "reference", "exceptionReason"]);
  const input = { paidDate: r.pastDate("paidDate", today), reference: r.text("reference", 100), exceptionReason: r.optionalText("exceptionReason", 500) };
  r.done();
  const dealId = await dealOf(deps, t);
  const current = (await getPayouts(deps, actor, dealId)).payouts.find((p) => p.id === t.id);
  if (current?.status === "PAID") throw new ConflictError("PAYOUT_ALREADY_PAID", "This payout is already marked paid");
  if (current?.status !== "APPROVED" && current?.status !== "PAYMENT_RETURNED") {
    throw new RuleViolationError("PAYOUT_NOT_APPROVED", "A managing broker must approve this payout before it's paid");
  }
  await insertEvent(deps, t, actor, "PAID", input.paidDate, { reference: input.reference, exceptionReason: input.exceptionReason });
  return getPayouts(deps, actor, dealId);
}

export async function reversePayment(deps: Deps, actor: Actor, t: Target, body: unknown): Promise<PayoutsView> {
  requireRole(actor, PAYMENT_RECORDERS, "Recording a returned payment");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body, ["date", "reference", "reason"]);
  const input = { date: r.pastDate("date", today), reference: r.text("reference", 100), reason: r.text("reason", 1000) };
  r.done();
  const dealId = await dealOf(deps, t);
  await insertEvent(deps, t, actor, "PAYMENT_REVERSED", input.date, { reference: input.reference, note: input.reason });
  return getPayouts(deps, actor, dealId);
}

export async function cancelApproval(deps: Deps, actor: Actor, t: Target, body: unknown): Promise<PayoutsView> {
  requireRole(actor, ["MANAGING_BROKER"], "Cancelling a payout approval");
  const r = new Reader(body, ["reason"]);
  const reason = r.text("reason", 1000);
  r.done();
  const dealId = await dealOf(deps, t);
  await insertEvent(deps, t, actor, "CANCELLED", deps.today?.() ?? todayInToronto(), { note: reason });
  return getPayouts(deps, actor, dealId);
}
