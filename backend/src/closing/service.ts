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
import { Reader } from "../lib/reader.ts";
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
        include: { user: true },
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
  // On a reissue, the distributions already posted under the voided CDA count as still held, so the
  // numbers are recomputed from the same starting point; finalize then checks they're unchanged
  const standing = await standingDistributions(db, dealId);
  for (const d of standing) {
    const b = balances.find((x) => x.trustAccountId === d.trustAccountId);
    if (b) b.balance = formatCents(numericToCents(b.balance) + d.amount);
    else balances.push({ trustAccountId: d.trustAccountId, balance: formatCents(d.amount) });
  }
  const standingTotal = standing.reduce((sum, d) => sum + d.amount, 0);
  const withFunds = balances.filter((b) => numericToCents(b.balance) !== 0);
  const deposits = await db.$queryRaw<{ receiptNumber: number | null; amount: string; date: string; payor: string }[]>`
    SELECT d."receiptNumber", d.amount::text AS amount, to_char(d."effectiveDate", 'YYYY-MM-DD') AS date,
           d.counterparty AS payor
      FROM "TrustLedgerEntry" d
     WHERE d."transactionId" = ${dealId}::uuid AND d."entryType" = 'DEPOSIT_RECEIVED'
       AND NOT EXISTS (SELECT 1 FROM "TrustLedgerEntry" r WHERE r."reversesEntryId" = d.id)
     ORDER BY d."createdAt"`;
  const [cleared] = withFunds.length === 1
    ? await db.$queryRaw<{ cleared: string }[]>`
        SELECT trust_cleared_balance(${dealId}::uuid, ${withFunds[0]!.trustAccountId}::uuid)::text AS cleared`
    : [{ cleared: "0" }];
  const hold = await db.trustHold.findFirst({ where: { transactionId: dealId, releasedAt: null }, select: { id: true } });

  // FINTRAC: every FINTRAC record slot on the deal must be approved
  const fintracSlots = await db.documentSlot.findMany({
    where: { transactionId: dealId, documentType: { metadataKind: { not: "NONE" } } },
    select: { status: true, documentType: { select: { name: true } }, party: { select: { fullName: true } } },
  });
  const outstanding = fintracSlots
    .filter((s) => s.status !== "APPROVED")
    .map((s) => `${s.documentType.name}${s.party ? ` (${s.party.fullName})` : ""}: ${s.status}`);

  // Agents with the plan in force on the close date, PREC details, cap-year totals from earlier
  // finalized closings, and the deal's approved bonuses and deductions
  const adjustments = await db.commissionAdjustment.findMany({
    where: { transactionId: dealId, approvedAt: { not: null }, withdrawnAt: null }, orderBy: { createdAt: "asc" },
  });
  const agents = [];
  for (const a of deal.agents) {
    const [plan] = await db.$queryRaw<{
      id: string; splitBps: number | null; annualCap: string | null; capYearStartMonth: number; capYearStartDay: number;
      fees: { name: string; amount: string }[];
    }[]>`
      SELECT (p).id::text AS id, (p)."splitBps" AS "splitBps", (p)."annualCap"::text AS "annualCap",
             (p)."capYearStartMonth" AS "capYearStartMonth", (p)."capYearStartDay" AS "capYearStartDay", (p).fees AS fees
        FROM (SELECT plan_in_force(${a.userId}::uuid, ${closeDate}::date) AS p) x WHERE (p).id IS NOT NULL`;
    let ytd = 0;
    if (plan?.annualCap) {
      const start = capYearStart(closeDate, plan.capYearStartMonth, plan.capYearStartDay);
      const [row] = await db.$queryRaw<{ total: string }[]>`
        SELECT COALESCE(SUM("houseSplitBase"), 0)::text AS total FROM "ClosingAgentPayout" p
         WHERE "userId" = ${a.userId}::uuid AND "closeDate" >= ${start}::date AND "closeDate" < ${addYear(start)}::date
           AND NOT EXISTS (SELECT 1 FROM "ClosingVoid" v WHERE v."closingId" = p."closingId")
           AND NOT EXISTS (SELECT 1 FROM "ClosingStatement" c WHERE c.id = p."closingId" AND c."transactionId" = ${dealId}::uuid)`;
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
      side: a.side,
      annualCap: plan?.annualCap ? numericToCents(plan.annualCap) : null,
      fees: (plan?.fees ?? []).map((f) => ({ name: f.name, amount: numericToCents(f.amount) })).sort((x, y) => x.name.localeCompare(y.name)),
      ytdHouseCollected: ytd,
      hasPlan: plan !== undefined,
      planVersionId: plan?.id ?? null,
      planSplitBps: plan?.splitBps ?? null,
      adjustments: adjustments.filter((x) => x.userId === a.userId).map((x) => ({
        id: x.id, kind: x.kind, description: x.description, amount: cents(x.amount), taxable: x.taxable,
      })),
    });
  }

  const [tax] = await db.$queryRaw<{ rateBps: number; taxName: "HST" | "GST" }[]>`
    SELECT (t)."rateBps" AS "rateBps", (t)."taxName" AS "taxName"
      FROM (SELECT sales_tax_on(${deal.province}, ${closeDate}::date) AS t) x WHERE (t).province IS NOT NULL`;

  const byRole = (role: string) => deal.parties.filter((p) => p.role === role);
  const lease = deal.side === "LANDLORD" || deal.side === "TENANT";
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
      province: deal.province,
      mlsNumber: deal.mlsNumber,
      salePrice: cents(deal.salePrice),
      expectedDeposit: cents(deal.depositAmount),
      trustDepositHolder: deal.trustDepositHolder,
      // On a lease, the landlord(s) and tenant(s) take the seller and buyer lines
      sellers: byRole(lease ? "LANDLORD" : "SELLER").map((p) => p.fullName),
      buyers: byRole(lease ? "TENANT" : "BUYER").map((p) => p.fullName),
    },
    baseGci: cents(deal.totalGci),
    sides: deal.listingSideGci !== null && deal.buyerSideGci !== null
      ? { listing: cents(deal.listingSideGci), buyer: cents(deal.buyerSideGci),
          buyerSidePaidBySeller: deal.buyerSideSellerPays === null ? null : cents(deal.buyerSideSellerPays) } : null,
    ...(tax ? { hstRate: tax.rateBps, taxName: tax.taxName } : {}),
    coopCommission: cents(deal.coopCommission),
    coopBrokerage: byRole("COOP_BROKERAGE")[0]?.fullName ?? deal.coopBrokerageName,
    referral: deal.outsideReferralPayee && deal.outsideReferralPct
      ? { payee: deal.outsideReferralPayee, rateBps: bps(deal.outsideReferralPct) }
      : null,
    agents,
    closingLawyer: lawyer ? { name: lawyer.fullName, email: lawyer.email, phone: lawyer.phone } : null,
    buyerLawyer: deal.side === "DUAL" && byRole("BUYER_LAWYER")[0]
      ? { name: byRole("BUYER_LAWYER")[0]!.fullName, email: byRole("BUYER_LAWYER")[0]!.email, phone: byRole("BUYER_LAWYER")[0]!.phone } : null,
    landlord: byRole("LANDLORD")[0] ? { name: byRole("LANDLORD").map((p) => p.fullName).join(" and "), email: byRole("LANDLORD")[0]!.email, phone: byRole("LANDLORD")[0]!.phone } : null,
    trust: {
      accountId: withFunds[0]?.trustAccountId ?? null,
      balance: withFunds.reduce((s, b) => s + numericToCents(b.balance), 0),
      cleared: numericToCents(cleared!.cleared) + standingTotal,
      accountsWithFunds: withFunds.length,
      activeHold: hold !== null,
      deposits: deposits.map((d) => ({ ...d, amount: numericToCents(d.amount) })),
    },
    fintrac: { total: fintracSlots.length, outstanding },
  };
}

/** Trust distributions posted under any of the deal's CDAs and not since reversed. */
export async function standingDistributions(db: Db, dealId: string) {
  const rows = await db.$queryRaw<{ entryType: string; amount: string; trustAccountId: string }[]>`
    SELECT e."entryType"::text AS "entryType", e.amount::text AS amount, e."trustAccountId"::text AS "trustAccountId"
      FROM "TrustLedgerEntry" e
     WHERE e."transactionId" = ${dealId}::uuid AND e."authorizationMethod" = 'CLOSING_COMPLETED'
       AND e."authorizationReference" IN (SELECT "cdaNumber" FROM "ClosingStatement" WHERE "transactionId" = ${dealId}::uuid)
       AND NOT EXISTS (SELECT 1 FROM "TrustLedgerEntry" r WHERE r."reversesEntryId" = e.id)
     ORDER BY e."createdAt"`;
  return rows.map((r) => ({ ...r, amount: numericToCents(r.amount) }));
}

// ── Preview & documents ──────────────────────────────────────────────────────

export interface ClosingView {
  finalized: boolean;
  finalizedAt: string | null;
  revision: number | null;
  computation: ClosingComputation;
}

async function latestStatement(db: Db, dealId: string) {
  return db.closingStatement.findFirst({ where: { transactionId: dealId }, orderBy: { revision: "desc" }, include: { void: true } });
}

/** The CDA in force: the latest revision, unless it has been voided (then there's none until it's reissued). */
async function finalizedStatement(db: Db, dealId: string) {
  const latest = await latestStatement(db, dealId);
  return latest && !latest.void ? latest : null;
}

export async function previewClosing(deps: ClosingDeps, actor: Actor, dealId: string): Promise<ClosingView> {
  requireRole(actor, TRUST_VIEWERS, "Viewing a closing");
  const done = await finalizedStatement(deps.prisma, dealId);
  if (done) {
    return {
      finalized: true,
      finalizedAt: done.finalizedAt.toISOString(),
      revision: done.revision,
      computation: done.computation as unknown as ClosingComputation,
    };
  }
  const input = await gatherClosingInput(deps.prisma, dealId);
  if (input.deal.status !== "FIRM" && input.deal.status !== "CLOSED") {
    throw new RuleViolationError("DEAL_NOT_FIRM", `Deal ${input.deal.dealNumber} is ${input.deal.status}`);
  }
  return { finalized: false, finalizedAt: null, revision: null, computation: computeClosing(input, deps.brokerage.legalName) };
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

const METHOD = { DISBURSEMENT_TO_COOP: "EFT", DISBURSEMENT_TO_GENERAL: "EFT", DISBURSEMENT_TO_LAWYER: "WIRE", DISBURSEMENT_TO_LANDLORD: "EFT" } as const;

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
  // Said first, so a lease isn't sent chasing other preconditions it can't use yet (the database enforces it too: migration 019)
  const [lease] = await deps.prisma.$queryRaw<{ blocked: boolean }[]>`
    SELECT side IN ('LANDLORD', 'TENANT') AND NOT policy_enabled('LEASE_SETTLEMENT') AS blocked FROM "Transaction" WHERE id = ${dealId}::uuid`;
  if (lease?.blocked) {
    throw new DomainError("POLICY_NOT_APPROVED", 409,
      "Issuing a CDA on a lease stays disabled until the broker of record records counsel's sign-off (LEASE_SETTLEMENT)");
  }

  try {
    return await deps.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM "Transaction" WHERE id = ${dealId}::uuid FOR UPDATE`;
      if (!locked) throw new NotFoundError("Deal", dealId);
      if (locked.status !== "CLOSED") {
        throw new RuleViolationError("DEAL_NOT_CLOSED", `Mark the deal CLOSED before finalizing (it is ${locked.status})`);
      }
      const previous = await latestStatement(tx, dealId);
      if (previous && !previous.void) {
        throw new ConflictError("ALREADY_FINALIZED", "This deal's closing has already been finalized");
      }
      const revision = previous ? previous.revision + 1 : 0;

      // Serialize cap math per agent across concurrent closings (sorted to avoid deadlocks)
      const agentIds = (await tx.transactionAgent.findMany({ where: { transactionId: dealId }, select: { userId: true } }))
        .map((a) => a.userId).sort();
      for (const id of agentIds) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-cap:${id}`}))`;

      const input = await gatherClosingInput(tx, dealId);
      const computation = computeClosing(input, deps.brokerage.legalName); // audits throw here
      if (revision > 0) computation.cdaNumber = `${computation.cdaNumber}-R${revision}`;

      // A reissue keeps the distributions already posted if they're unchanged; anything else must be reversed first
      const standing = await standingDistributions(tx, dealId);
      const key = (d: { entryType: string; amount: number }) => `${d.entryType}:${d.amount}`;
      const unchanged = standing.length > 0
        && JSON.stringify(standing.map(key).sort()) === JSON.stringify(computation.trust.distributions.map(key).sort());
      if (standing.length > 0 && !unchanged) {
        throw new RuleViolationError(
          "PRIOR_DISTRIBUTIONS_DIFFER",
          "The corrected CDA distributes trust money differently from the voided one. Reverse the earlier trust distributions first, then reissue.",
          { posted: standing, proposed: computation.trust.distributions },
        );
      }

      // Post the trust distributions; the ledger's own checks run on each
      const trustEntries: LedgerEntry[] = [];
      for (const d of unchanged ? [] : computation.trust.distributions) {
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
      const replaces = previous ? { cdaNumber: previous.cdaNumber, reason: previous.void!.reason } : undefined;
      const render = (audience: "lawyer" | "internal") =>
        renderCda(computation, deps.brokerage, { audience, status: "FINAL", issuedOn: today, computationSha, replaces });

      const [statement] = await tx.$queryRaw<{ id: string; finalizedAt: string }[]>`
        INSERT INTO "ClosingStatement" (id, "transactionId", "cdaNumber", computation, "computationSha",
                                        "lawyerHtml", "internalHtml", "idempotencyKey", "finalizedById", revision, "supersedesId")
        VALUES (gen_random_uuid(), ${dealId}::uuid, ${computation.cdaNumber}, ${json}::jsonb, ${computationSha},
                ${render("lawyer")}, ${render("internal")}, ${idempotencyKey}::uuid, ${actor.id}::uuid, ${revision},
                ${previous?.id ?? null}::uuid)
        RETURNING id, to_char("finalizedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "finalizedAt"`;

      // What each payee was already paid under voided revisions carries forward
      const paidBefore = await tx.$queryRaw<{ key: string; paid: string }[]>`
        SELECT 'AGENT|' || p."userId"::text AS key, COALESCE(SUM(ev.amount), 0)::text AS paid
          FROM "ClosingAgentPayout" p JOIN "ClosingStatement" c ON c.id = p."closingId"
          CROSS JOIN LATERAL payout_last_event(p.id, NULL::uuid) ev
         WHERE c."transactionId" = ${dealId}::uuid AND ev.kind = 'PAID'
         GROUP BY 1
        UNION ALL
        SELECT q."payeeType"::text || '|' || q."payeeName", COALESCE(SUM(ev.amount), 0)::text
          FROM "ClosingPayable" q JOIN "ClosingStatement" c ON c.id = q."closingId"
          CROSS JOIN LATERAL payout_last_event(NULL::uuid, q.id) ev
         WHERE c."transactionId" = ${dealId}::uuid AND ev.kind = 'PAID'
         GROUP BY 1`;
      const carried = (key: string) => formatCents(numericToCents(paidBefore.find((p) => p.key === key)?.paid ?? "0"));

      for (const a of computation.agents) {
        await tx.$executeRaw`
          INSERT INTO "ClosingAgentPayout" (id, "closingId", "userId", "closeDate", "payeeName", "allocatedBaseGci",
            "houseSplitBase", "agentSplitBase", "agentSplitHst", "feesBase", "feesHst", "netPayout",
            "wiredByLawyer", "paidByBrokerage", "carriedForward")
          VALUES (gen_random_uuid(), ${statement!.id}::uuid, ${a.userId}::uuid, ${input.deal.closeDate}::date, ${a.payeeName},
            ${formatCents(a.allocatedBaseGci)}::numeric, ${formatCents(a.houseSplitBase)}::numeric,
            ${formatCents(a.split.base)}::numeric, ${formatCents(a.split.hst)}::numeric,
            ${formatCents(a.feesTotal.base)}::numeric, ${formatCents(a.feesTotal.hst)}::numeric,
            ${formatCents(a.payout)}::numeric, 0, ${formatCents(a.payout)}::numeric, ${carried(`AGENT|${a.userId}`)}::numeric)`;
      }

      // Money the brokerage collects for others: the co-op share not paid straight from trust, and any referral
      const coopFromTrust = computation.trust.distributions
        .filter((d) => d.entryType === "DISBURSEMENT_TO_COOP").reduce((sum, d) => sum + d.amount, 0);
      const coop = computation.incoming.coop;
      const coopOwed = coop.total - coopFromTrust;
      const payables: { type: "COOP_BROKERAGE" | "REFERRAL"; payee: string; amount: number; hst: number }[] = [];
      if (coopOwed > 0) {
        payables.push({
          type: "COOP_BROKERAGE", payee: input.coopBrokerage ?? "Co-operating brokerage", amount: coopOwed,
          hst: coop.total > 0 ? Math.round((coop.hst * coopOwed) / coop.total) : 0,
        });
      }
      const referral = computation.brokerage.referral;
      if (referral && referral.total > 0) payables.push({ type: "REFERRAL", payee: referral.payee, amount: referral.total, hst: referral.hst });
      for (const q of payables) {
        await tx.$executeRaw`
          INSERT INTO "ClosingPayable" (id, "closingId", "payeeType", "payeeName", amount, hst, "carriedForward")
          VALUES (gen_random_uuid(), ${statement!.id}::uuid, ${q.type}::"PayableType", ${q.payee}, ${formatCents(q.amount)}::numeric,
                  ${formatCents(q.hst)}::numeric, ${carried(`${q.type}|${q.payee}`)}::numeric)`;
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
    if (target.includes("transactionId") || target.includes("ClosingStatement_transactionId_revision_key")) {
      throw new ConflictError("ALREADY_FINALIZED", "This deal's closing has already been finalized");
    }
    throw fromDatabaseError(err) ?? err;
  }
}

// ── Void ─────────────────────────────────────────────────────────────────────

/**
 * Withdraws the CDA in force so a corrected one can be issued. Nothing is
 * deleted: the voided CDA, its approvals and payments stay on record. Open
 * approvals are cancelled; payments already made carry forward to the
 * reissued CDA. Trust distributions already posted stay unless reversed.
 */
export async function voidClosing(deps: ClosingDeps, actor: Actor, dealId: string, body: unknown) {
  requireRole(actor, TRUST_AUTHORIZERS, "Voiding a CDA");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body, ["reason"]);
  const reason = r.text("reason", 1000);
  r.done();
  try {
    return await deps.prisma.$transaction(async (tx) => {
      const active = await finalizedStatement(tx, dealId);
      if (!active) throw new NotFoundError("Finalized CDA in force for deal", dealId);
      await tx.$executeRaw`INSERT INTO "ClosingVoid" ("closingId", reason, "actorId") VALUES (${active.id}::uuid, ${reason}, ${actor.id}::uuid)`;
      const open = await tx.$queryRaw<{ payoutId: string | null; payableId: string | null }[]>`
        SELECT p.id::text AS "payoutId", NULL::text AS "payableId" FROM "ClosingAgentPayout" p
         WHERE p."closingId" = ${active.id}::uuid AND (payout_last_event(p.id, NULL::uuid)).kind IN ('APPROVED', 'PAYMENT_REVERSED')
        UNION ALL
        SELECT NULL, q.id::text FROM "ClosingPayable" q
         WHERE q."closingId" = ${active.id}::uuid AND (payout_last_event(NULL::uuid, q.id)).kind IN ('APPROVED', 'PAYMENT_REVERSED')`;
      for (const o of open) {
        await tx.$executeRaw`
          INSERT INTO "PayoutEvent" (id, "payoutId", "payableId", seq, kind, "actorId", "eventDate", note)
          VALUES (gen_random_uuid(), ${o.payoutId}::uuid, ${o.payableId}::uuid, 0, 'CANCELLED', ${actor.id}::uuid, ${today}::date,
                  ${`CDA ${active.cdaNumber} voided: ${reason}`})`;
      }
      return { voided: active.cdaNumber, cancelledApprovals: open.length };
    });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw fromDatabaseError(err) ?? err;
  }
}
