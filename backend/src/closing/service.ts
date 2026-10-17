/**
 * Closing service: gathers a deal's data (deal tables, agents' commission
 * plans and year-to-date cap totals, the trust ledger, FINTRAC status), runs
 * the closing calculator, renders the CDA, and finalizes.
 *
 * Finalizing is one database transaction: lock the deal (and each agent's
 * cap), recompute from fresh data, post the trust distributions through the
 * trust ledger's own checks, and store the frozen statement + documents.
 */

import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { requireRole, TRUST_AUTHORIZERS, TRUST_VIEWERS, type Actor } from "../auth.ts";
import { ConflictError, DomainError, fromDatabaseError, NotFoundError, RuleViolationError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { formatCents, numericToCents, type Cents } from "../lib/money.ts";
import { insertDisbursement, type LedgerEntry } from "../trust/service.ts";
import { computeClosing, type ClosingComputation, type ClosingInput } from "./calculate.ts";
import { renderCda, type BrokerageProfile } from "./cda-template.ts";

type Db = Prisma.TransactionClient;

export interface ClosingDeps {
  prisma: PrismaClient;
  brokerage: BrokerageProfile;
  today?: () => string;
}

const cents = (d: Prisma.Decimal | null | undefined): Cents => (d ? numericToCents(d.toFixed(2)) : 0);
const bps = (d: Prisma.Decimal): number => Math.round(Number(d.toFixed(2)) * 100);
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** First day of the cap year that contains `date`. */
export function capYearStart(date: string, month: number, day: number): string {
  const year = Number(date.slice(0, 4));
  const thisYear = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return date >= thisYear ? thisYear : `${year - 1}${thisYear.slice(4)}`;
}

function addYear(date: string): string {
  return `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`;
}

// ── Gather ───────────────────────────────────────────────────────────────────

export async function gatherClosingInput(db: Db, dealId: string): Promise<ClosingInput> {
  const deal = await db.transaction.findUnique({
    where: { id: dealId },
    include: {
      agents: {
        orderBy: [{ role: "asc" }, { userId: "asc" }], // PRIMARY first
        include: { user: { include: { commissionPlan: { include: { fees: { orderBy: { name: "asc" } } } } } } },
      },
      parties: true,
    },
  });
  if (!deal) throw new NotFoundError("Deal", dealId);
  const closeDate = isoDate(deal.closeDate);

  // Trust: balance per account, receipts still standing, active hold
  const balances = await db.$queryRaw<{ trustAccountId: string; balance: string }[]>`
    SELECT "trustAccountId", SUM(amount * direction)::text AS balance
      FROM "TrustLedgerEntry" WHERE "transactionId" = ${dealId}::uuid
     GROUP BY "trustAccountId"`;
  const withFunds = balances.filter((b) => numericToCents(b.balance) !== 0);
  const deposits = await db.$queryRaw<{ receiptNumber: number | null; amount: string; date: string; payor: string }[]>`
    SELECT d."receiptNumber", d.amount::text AS amount, to_char(d."effectiveDate", 'YYYY-MM-DD') AS date,
           d.counterparty AS payor
      FROM "TrustLedgerEntry" d
     WHERE d."transactionId" = ${dealId}::uuid AND d."entryType" = 'DEPOSIT_RECEIVED'
       AND NOT EXISTS (SELECT 1 FROM "TrustLedgerEntry" r WHERE r."reversesEntryId" = d.id)
     ORDER BY d."createdAt"`;
  const hold = await db.trustHold.findFirst({ where: { transactionId: dealId, releasedAt: null }, select: { id: true } });

  // FINTRAC: every FINTRAC record slot on the deal must be approved
  const fintracSlots = await db.documentSlot.findMany({
    where: { transactionId: dealId, documentType: { metadataKind: { not: "NONE" } } },
    select: { status: true, documentType: { select: { name: true } }, party: { select: { fullName: true } } },
  });
  const outstanding = fintracSlots
    .filter((s) => s.status !== "APPROVED")
    .map((s) => `${s.documentType.name}${s.party ? ` (${s.party.fullName})` : ""}: ${s.status}`);

  // Agents with plan, PREC details and cap-year totals from earlier finalized closings
  const agents = [];
  for (const a of deal.agents) {
    const plan = a.user.commissionPlan;
    let ytd = 0;
    if (plan?.annualCap) {
      const start = capYearStart(closeDate, plan.capYearStartMonth, plan.capYearStartDay);
      const [row] = await db.$queryRaw<{ total: string }[]>`
        SELECT COALESCE(SUM("houseSplitBase"), 0)::text AS total FROM "ClosingAgentPayout"
         WHERE "userId" = ${a.userId}::uuid AND "closeDate" >= ${start}::date AND "closeDate" < ${addYear(start)}::date`;
      ytd = numericToCents(row!.total);
    }
    agents.push({
      userId: a.userId,
      name: `${a.user.firstName} ${a.user.lastName}`,
      role: a.role,
      isPrec: a.user.isPrec,
      precLegalName: a.user.precLegalName,
      hstNumber: a.user.hstNumber,
      splitBps: bps(a.splitPct),
      gciShareBps: bps(a.gciSharePct),
      annualCap: plan?.annualCap ? cents(plan.annualCap) : null,
      fees: (plan?.fees ?? []).map((f) => ({ name: f.name, amount: cents(f.amount) })),
      ytdHouseCollected: ytd,
      hasPlan: plan !== null,
    });
  }

  const byRole = (role: string) => deal.parties.filter((p) => p.role === role);
  const lawyerRole = deal.side === "BUYER" ? "BUYER_LAWYER" : "SELLER_LAWYER";
  const lawyer = byRole(lawyerRole)[0];

  return {
    deal: {
      id: deal.id,
      dealNumber: deal.dealNumber,
      side: deal.side,
      status: deal.status,
      closeDate,
      streetAddress: deal.streetAddress,
      unit: deal.unit,
      city: deal.city,
      mlsNumber: deal.mlsNumber,
      salePrice: cents(deal.salePrice),
      expectedDeposit: cents(deal.depositAmount),
      trustDepositHolder: deal.trustDepositHolder,
      sellers: byRole("SELLER").map((p) => p.fullName),
      buyers: byRole("BUYER").map((p) => p.fullName),
    },
    baseGci: cents(deal.totalGci),
    coopCommission: cents(deal.coopCommission),
    coopBrokerage: byRole("COOP_BROKERAGE")[0]?.fullName ?? deal.coopBrokerageName,
    referral: deal.outsideReferralPayee && deal.outsideReferralPct
      ? { payee: deal.outsideReferralPayee, rateBps: bps(deal.outsideReferralPct) }
      : null,
    agents,
    closingLawyer: lawyer ? { name: lawyer.fullName, email: lawyer.email, phone: lawyer.phone } : null,
    trust: {
      accountId: withFunds[0]?.trustAccountId ?? null,
      balance: withFunds.reduce((s, b) => s + numericToCents(b.balance), 0),
      accountsWithFunds: withFunds.length,
      activeHold: hold !== null,
      deposits: deposits.map((d) => ({ ...d, amount: numericToCents(d.amount) })),
    },
    fintrac: { total: fintracSlots.length, outstanding },
  };
}

// ── Preview & documents ──────────────────────────────────────────────────────

export interface ClosingView {
  finalized: boolean;
  finalizedAt: string | null;
  computation: ClosingComputation;
}

async function finalizedStatement(db: Db, dealId: string) {
  return db.closingStatement.findUnique({ where: { transactionId: dealId } });
}

export async function previewClosing(deps: ClosingDeps, actor: Actor, dealId: string): Promise<ClosingView> {
  requireRole(actor, TRUST_VIEWERS, "Viewing a closing");
  const done = await finalizedStatement(deps.prisma, dealId);
  if (done) {
    return {
      finalized: true,
      finalizedAt: done.finalizedAt.toISOString(),
      computation: done.computation as unknown as ClosingComputation,
    };
  }
  const input = await gatherClosingInput(deps.prisma, dealId);
  if (input.deal.status !== "FIRM" && input.deal.status !== "CLOSED") {
    throw new RuleViolationError("DEAL_NOT_FIRM", `Deal ${input.deal.dealNumber} is ${input.deal.status}`);
  }
  return { finalized: false, finalizedAt: null, computation: computeClosing(input, deps.brokerage.legalName) };
}

/** The issued document once finalized; otherwise a fresh DRAFT. */
export async function cdaHtml(
  deps: ClosingDeps,
  actor: Actor,
  dealId: string,
  audience: "lawyer" | "internal",
): Promise<string> {
  requireRole(actor, TRUST_VIEWERS, "Viewing a CDA");
  const done = await finalizedStatement(deps.prisma, dealId);
  if (done) return audience === "lawyer" ? done.lawyerHtml : done.internalHtml;
  const { computation } = await previewClosing(deps, actor, dealId);
  const today = deps.today?.() ?? todayInToronto();
  return renderCda(computation, deps.brokerage, { audience, status: "DRAFT", issuedOn: today });
}

// ── Finalize ─────────────────────────────────────────────────────────────────

export interface FinalizeResult {
  statementId: string;
  cdaNumber: string;
  finalizedAt: string;
  computationSha: string;
  computation: ClosingComputation;
  trustEntries: LedgerEntry[];
  replayed: boolean;
}

const METHOD = { DISBURSEMENT_TO_COOP: "EFT", DISBURSEMENT_TO_GENERAL: "EFT", DISBURSEMENT_TO_LAWYER: "WIRE" } as const;

export async function finalizeClosing(
  deps: ClosingDeps,
  actor: Actor,
  dealId: string,
  idempotencyKey: string,
): Promise<FinalizeResult> {
  requireRole(actor, TRUST_AUTHORIZERS, "Finalizing a closing");
  const today = deps.today?.() ?? todayInToronto();

  const replay = async (): Promise<FinalizeResult | null> => {
    const existing = await deps.prisma.closingStatement.findUnique({ where: { idempotencyKey } });
    if (!existing) return null;
    if (existing.transactionId !== dealId) {
      throw new ConflictError("IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was used to finalize a different deal");
    }
    return {
      statementId: existing.id,
      cdaNumber: existing.cdaNumber,
      finalizedAt: existing.finalizedAt.toISOString(),
      computationSha: existing.computationSha,
      computation: existing.computation as unknown as ClosingComputation,
      trustEntries: [],
      replayed: true,
    };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  try {
    return await deps.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM "Transaction" WHERE id = ${dealId}::uuid FOR UPDATE`;
      if (!locked) throw new NotFoundError("Deal", dealId);
      if (locked.status !== "CLOSED") {
        throw new RuleViolationError("DEAL_NOT_CLOSED", `Mark the deal CLOSED before finalizing (it is ${locked.status})`);
      }
      if (await finalizedStatement(tx, dealId)) {
        throw new ConflictError("ALREADY_FINALIZED", "This deal's closing has already been finalized");
      }

      // Serialize cap math per agent across concurrent closings (sorted to avoid deadlocks)
      const agentIds = (await tx.transactionAgent.findMany({ where: { transactionId: dealId }, select: { userId: true } }))
        .map((a) => a.userId).sort();
      for (const id of agentIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-cap:${id}`}))`;

      const input = await gatherClosingInput(tx, dealId);
      const computation = computeClosing(input, deps.brokerage.legalName); // audits throw here

      // Post the trust distributions; the ledger's own checks run on each
      const trustEntries: LedgerEntry[] = [];
      for (const d of computation.trust.distributions) {
        const { entry } = await insertDisbursement(tx, actor.id, {
          dealId,
          trustAccountId: input.trust.accountId!,
          entryType: d.entryType,
          amount: d.amount,
          method: METHOD[d.entryType],
          referenceNo: null,
          payeeName: d.payee,
          date: today,
          authorizationMethod: "CLOSING_COMPLETED",
          authorizationReference: computation.cdaNumber,
          memo: d.purpose,
          idempotencyKey: randomUUID(),
          statusWhenEmpty: "RELEASED",
        });
        trustEntries.push(entry);
      }
      const [after] = await tx.$queryRaw<{ balance: string }[]>`
        SELECT COALESCE(SUM(amount * direction), 0)::text AS balance FROM "TrustLedgerEntry"
         WHERE "transactionId" = ${dealId}::uuid`;
      if (numericToCents(after!.balance) !== 0) {
        throw new RuleViolationError("TRUST_WILL_NOT_BALANCE", `Trust ledger ended at $${after!.balance}, not $0.00`);
      }

      const json = JSON.stringify(computation);
      const computationSha = createHash("sha256").update(json).digest("hex");
      const render = (audience: "lawyer" | "internal") =>
        renderCda(computation, deps.brokerage, { audience, status: "FINAL", issuedOn: today, computationSha });

      const [statement] = await tx.$queryRaw<{ id: string; finalizedAt: string }[]>`
        INSERT INTO "ClosingStatement" (id, "transactionId", "cdaNumber", computation, "computationSha",
                                        "lawyerHtml", "internalHtml", "idempotencyKey", "finalizedById")
        VALUES (gen_random_uuid(), ${dealId}::uuid, ${computation.cdaNumber}, ${json}::jsonb, ${computationSha},
                ${render("lawyer")}, ${render("internal")}, ${idempotencyKey}::uuid, ${actor.id}::uuid)
        RETURNING id, to_char("finalizedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "finalizedAt"`;

      for (const a of computation.agents) {
        await tx.$executeRaw`
          INSERT INTO "ClosingAgentPayout" (id, "closingId", "userId", "closeDate", "payeeName", "allocatedBaseGci",
            "houseSplitBase", "agentSplitBase", "agentSplitHst", "feesBase", "feesHst", "netPayout",
            "wiredByLawyer", "paidByBrokerage")
          VALUES (gen_random_uuid(), ${statement!.id}::uuid, ${a.userId}::uuid, ${input.deal.closeDate}::date, ${a.payeeName},
            ${formatCents(a.allocatedBaseGci)}::numeric, ${formatCents(a.houseSplitBase)}::numeric,
            ${formatCents(a.split.base)}::numeric, ${formatCents(a.split.hst)}::numeric,
            ${formatCents(a.feesTotal.base)}::numeric, ${formatCents(a.feesTotal.hst)}::numeric,
            ${formatCents(a.payout)}::numeric, ${formatCents(a.wiredByPayer)}::numeric, ${formatCents(a.coveredByTrust)}::numeric)`;
      }

      return {
        statementId: statement!.id,
        cdaNumber: computation.cdaNumber,
        finalizedAt: statement!.finalizedAt,
        computationSha,
        computation,
        trustEntries,
        replayed: false,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 5_000, timeout: 20_000 });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    const target = String((err as { meta?: { target?: unknown; message?: string } })?.meta?.target ?? (err as Error)?.message ?? "");
    if (target.includes("idempotencyKey")) {
      const raced = await replay();
      if (raced) return raced;
    }
    if (target.includes("transactionId") || target.includes("ClosingStatement_transactionId_key")) {
      throw new ConflictError("ALREADY_FINALIZED", "This deal's closing has already been finalized");
    }
    throw fromDatabaseError(err) ?? err;
  }
}
