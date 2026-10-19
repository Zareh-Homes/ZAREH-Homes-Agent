/**
 * Available funds, obligations, and the journal export.
 *
 * Available = verified bank balance − payments sent but not yet through the
 * bank − approved, unsent payments − returned payments still owed − the
 * operating account's other obligations. The database applies the same
 * formula when a payout is approved (migration 013); this module shows the
 * workings, records obligations figures and their attestation, and exports
 * the journal.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, TRUST_VIEWERS, type Actor, type ResolveUserId } from "../auth.ts";
import { ConflictError, DomainError, fromDatabaseError, NotFoundError, RuleViolationError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { formatCents, numericToCents, type Cents } from "../lib/money.ts";
import { Reader } from "../lib/reader.ts";
import { validatePathUuid } from "../trust/validation.ts";
import { BANK_STAFF } from "../bank/service.ts";
import { AccountingError, AccountingPostingDisabled, type AccountingAdapter } from "./adapter.ts";
import { ACCOUNT_ROLES, buildJournal, journalCsv, type AccountRole, type Movement } from "./journal.ts";

export const OBLIGATIONS_MAX_AGE_DAYS = 7;

export interface FundsDeps {
  prisma: PrismaClient;
  accounting?: AccountingAdapter | null;
  accountMap?: Partial<Record<AccountRole, string>>;
  today?: () => string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  if ((err as { meta?: { code?: string } })?.meta?.code === "23505") throw new ConflictError("ALREADY_ATTESTED", "This obligations figure is already attested");
  throw fromDatabaseError(err) ?? err;
}

type AccountRef = { type: "OPERATING" | "COMMISSION_TRUST"; id: string };

export interface FundsAvailability {
  account: AccountRef;
  asOf: string | null;
  bankBalance: string | null;
  unpresentedPayments: string;
  approvedNotSent: string;
  returnedStillOwed: string;
  obligations: { amount: string; asOf: string; source: string; reference: string } | null;
  available: string | null;
  /** Why nothing can be approved from this account right now, if so */
  blockedBecause: string[];
  /** Things the approver should check that don't block approval (e.g. an obligations figure below the HST the CDAs show) */
  cautions: string[];
  definition: string;
}

/** The same figures the database uses to approve a payout, with the workings. */
export async function fundsAvailability(prisma: PrismaClient, account: AccountRef, today: string): Promise<FundsAvailability> {
  const trust = account.type === "COMMISSION_TRUST" ? account.id : null;
  const operating = account.type === "OPERATING" ? account.id : null;
  const balance = await prisma.bankStatement.findFirst({
    where: { ...(operating ? { operatingAccountId: operating } : { trustAccountId: trust! }), verification: { isNot: null } },
    orderBy: [{ periodEnd: "desc" }, { importedAt: "desc" }],
  });
  const asOf = balance ? iso(balance.periodEnd) : today;
  const [parts] = await prisma.$queryRaw<{ unpresented: string; approved: string; returned: string }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (COALESCE(e."payoutId", e."payableId")) e.* FROM "PayoutEvent" e
       ORDER BY COALESCE(e."payoutId", e."payableId"), e.seq DESC
    ), approval AS (
      SELECT l.*, (SELECT a FROM "PayoutEvent" a WHERE COALESCE(a."payoutId", a."payableId") = COALESCE(l."payoutId", l."payableId")
                    AND a.kind = 'APPROVED' ORDER BY a.seq DESC LIMIT 1) AS ap FROM latest l
    )
    SELECT COALESCE(SUM((ap).amount) FILTER (WHERE kind = 'PAID' AND NOT payout_event_presented(id, ${asOf}::date)), 0)::numeric(14, 2)::text AS unpresented,
           COALESCE(SUM((ap).amount) FILTER (WHERE kind = 'APPROVED'), 0)::numeric(14, 2)::text AS approved,
           COALESCE(SUM((ap).amount) FILTER (WHERE kind = 'PAYMENT_REVERSED'), 0)::numeric(14, 2)::text AS returned
      FROM approval
     WHERE (ap).id IS NOT NULL AND (ap)."payFromTrustAccountId" IS NOT DISTINCT FROM ${trust}::uuid
       AND (ap)."payFromOperatingAccountId" IS NOT DISTINCT FROM ${operating}::uuid`;
  const obligation = operating ? await prisma.fundsObligationSnapshot.findFirst({
    where: { operatingAccountId: operating, attestation: { isNot: null }, asOf: { lte: new Date(`${today}T00:00:00Z`) } },
    orderBy: [{ asOf: "desc" }, { createdAt: "desc" }],
  }) : null;
  const freshObligation = obligation && Date.parse(today) - obligation.asOf.getTime() <= OBLIGATIONS_MAX_AGE_DAYS * 86_400_000 ? obligation : null;

  const blockedBecause: string[] = [];
  if (!balance) blockedBecause.push("No verified bank balance for this account");
  else if (Date.parse(today) - balance.periodEnd.getTime() > 3 * 86_400_000) blockedBecause.push(`The latest verified balance is from ${asOf}; import today's balance`);
  if (operating && !freshObligation) blockedBecause.push(`No attested obligations figure in the last ${OBLIGATIONS_MAX_AGE_DAYS} days`);

  // The obligations figure is the accountant's, but the system knows the HST its CDAs collected: say so when the
  // figure is lower, so a $0 attestation can't silently leave HST out. A warning, not a block: some may be remitted.
  const cautions: string[] = [];
  if (operating && freshObligation) {
    const yearStart = `${today.slice(0, 4)}-01-01`;
    const [hst] = await prisma.$queryRaw<{ cents: string }[]>`
      SELECT COALESCE(SUM(COALESCE(c.computation #>> '{brokerage,netHstEstimate}', c.computation #>> '{brokerage,hstRemittance}')::bigint), 0)::text AS cents
        FROM "ClosingStatement" c JOIN "Transaction" t ON t.id = c."transactionId"
       WHERE t."closeDate" >= ${yearStart}::date AND t."closeDate" <= ${today}::date
         AND NOT EXISTS (SELECT 1 FROM "ClosingVoid" v WHERE v."closingId" = c.id)`;
    const netHst = Number(BigInt(hst!.cents));
    const attested = numericToCents(freshObligation.amount.toFixed(2));
    if (attested < netHst) {
      const cad = (c: Cents) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(c / 100);
      cautions.push(`This year's CDAs show ${cad(netHst)} of net HST collected (estimate); the attested obligations figure is ` +
        `${cad(attested)}. Unless that HST has already been remitted, the figure should include it.`);
    }
  }

  const deductions = numericToCents(parts!.unpresented) + numericToCents(parts!.approved) + numericToCents(parts!.returned) +
    (freshObligation ? numericToCents(freshObligation.amount.toFixed(2)) : 0);
  return {
    account,
    asOf: balance ? asOf : null,
    bankBalance: balance ? balance.closingBalance.toFixed(2) : null,
    unpresentedPayments: parts!.unpresented, approvedNotSent: parts!.approved, returnedStillOwed: parts!.returned,
    obligations: freshObligation
      ? { amount: freshObligation.amount.toFixed(2), asOf: iso(freshObligation.asOf), source: freshObligation.source, reference: freshObligation.sourceReference }
      : null,
    available: balance ? formatCents(numericToCents(balance.closingBalance.toFixed(2)) - deductions) : null,
    blockedBecause,
    cautions,
    definition: "Verified bank balance, less payments sent but not yet through the bank, payments approved but not sent, " +
      "returned payments still owed, and (operating account) other obligations from an attested figure no more than 7 days old.",
  };
}

async function insertSnapshot(prisma: PrismaClient, actor: Actor, s: {
  operatingAccountId: string; asOf: string; amount: Cents; source: "ACCOUNTING_SYSTEM" | "MANUAL"; sourceReference: string; lines: unknown[];
}) {
  try {
    const [row] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "FundsObligationSnapshot" (id, "operatingAccountId", "asOf", amount, source, "sourceReference", lines, "preparedById")
      VALUES (gen_random_uuid(), ${s.operatingAccountId}::uuid, ${s.asOf}::date, ${formatCents(s.amount)}::numeric, ${s.source},
              ${s.sourceReference}, ${JSON.stringify(s.lines)}::jsonb, ${actor.id}::uuid)
      RETURNING id::text`;
    return snapshotView(prisma, row!.id);
  } catch (err) {
    rethrow(err);
  }
}

async function snapshotView(prisma: PrismaClient, id: string) {
  const s = await prisma.fundsObligationSnapshot.findUnique({
    where: { id },
    include: { preparedBy: { select: { firstName: true, lastName: true } }, attestation: { include: { attestedBy: { select: { firstName: true, lastName: true } } } } },
  });
  if (!s) throw new NotFoundError("Obligations figure", id);
  return {
    id: s.id, operatingAccountId: s.operatingAccountId, asOf: iso(s.asOf), amount: s.amount.toFixed(2), source: s.source,
    sourceReference: s.sourceReference, lines: s.lines, preparedBy: `${s.preparedBy.firstName} ${s.preparedBy.lastName}`,
    attestation: s.attestation
      ? { by: `${s.attestation.attestedBy.firstName} ${s.attestation.attestedBy.lastName}`, note: s.attestation.note, at: s.attestation.attestedAt.toISOString() }
      : null,
  };
}

/** Pulls unpaid bills from the connected accounting system. Read-only. */
export async function pullObligations(deps: FundsDeps, actor: Actor, body: unknown) {
  requireRole(actor, BANK_STAFF, "Importing obligations from the accounting system");
  const r = new Reader(body, ["operatingAccountId"]);
  const operatingAccountId = r.uuid("operatingAccountId");
  r.done();
  if (!deps.accounting) {
    throw new DomainError("ACCOUNTING_NOT_CONNECTED", 503,
      "No accounting system is connected. Use the manual procedure (if the broker of record has enabled it) or connect QuickBooks Online or Xero.");
  }
  const today = deps.today?.() ?? todayInToronto();
  let lines;
  try {
    lines = await deps.accounting.openPayables(today);
  } catch (err) {
    if (err instanceof AccountingError) throw new DomainError("ACCOUNTING_UNAVAILABLE", err.status === 401 ? 503 : 502, err.message);
    throw err;
  }
  const amount = lines.reduce((s, l) => s + l.amount, 0);
  return insertSnapshot(deps.prisma, actor, {
    operatingAccountId, asOf: today, amount, source: "ACCOUNTING_SYSTEM",
    sourceReference: `${deps.accounting.sourceLabel}: ${lines.length} unpaid bills read ${new Date().toISOString()}`,
    lines: lines.map((l) => ({ ...l, amount: formatCents(l.amount) })),
  });
}

/** The documented manual procedure: every obligation listed with its source document. Needs MANUAL_OBLIGATIONS_PROCEDURE. */
export async function recordManualObligations(deps: FundsDeps, actor: Actor, body: unknown) {
  requireRole(actor, BANK_STAFF, "Recording obligations");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body, ["operatingAccountId", "asOf", "procedureReference", "lines"]);
  const operatingAccountId = r.uuid("operatingAccountId");
  const asOf = r.pastDate("asOf", today);
  const procedureReference = r.text("procedureReference", 500);
  // Every obligation listed with its source document; an empty list means none, and is attested as such
  const lines = r.objects("lines", ["description", "payee", "dueDate", "amount", "sourceDocument"], { max: 500 }).map((lr) => ({
    description: lr.text("description", 300), payee: lr.optionalText("payee", 200), dueDate: lr.optionalDate("dueDate"),
    amount: lr.amount("amount"), sourceDocument: lr.text("sourceDocument", 300),
  }));
  r.done();
  return insertSnapshot(deps.prisma, actor, {
    operatingAccountId, asOf, amount: lines.reduce((s, l) => s + l.amount, 0), source: "MANUAL", sourceReference: procedureReference,
    lines: lines.map((l) => ({ ...l, amount: formatCents(l.amount) })),
  });
}

export async function attestObligations(deps: FundsDeps, actor: Actor, snapshotId: string, body: unknown) {
  requireRole(actor, BANK_STAFF, "Attesting to obligations");
  const r = new Reader(body, ["note", "exceptionReason"]);
  const note = r.text("note", 1000);
  const exceptionReason = r.optionalText("exceptionReason", 500);
  r.done();
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO "FundsObligationAttestation" ("snapshotId", "attestedById", note, "exceptionReason")
      VALUES (${snapshotId}::uuid, ${actor.id}::uuid, ${note}, ${exceptionReason})`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23503") throw new NotFoundError("Obligations figure", snapshotId);
    rethrow(err);
  }
  return snapshotView(deps.prisma, snapshotId);
}

/** Every money movement in a date range, as journal entries. */
export async function journal(deps: FundsDeps, actor: Actor, from: string, to: string) {
  requireRole(actor, ["ADMIN", "MANAGING_BROKER"], "Exporting the journal");
  const rows = await deps.prisma.$queryRaw<(Omit<Movement, "amount"> & { amount: string })[]>`
    SELECT r.id::text, to_char(r."receivedDate", 'YYYY-MM-DD') AS date, 'COMMISSION_RECEIVED' AS kind, r.amount::text, t."dealNumber",
           r.reference, CASE WHEN r."operatingAccountId" IS NULL THEN 'BANK_COMMISSION_TRUST' ELSE 'BANK_OPERATING' END AS bank,
           NULL AS payable, NULL AS payee
      FROM "CommissionReceipt" r JOIN "ClosingStatement" c ON c.id = r."closingId" JOIN "Transaction" t ON t.id = c."transactionId"
     WHERE r."receivedDate" BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT 'reversal:' || x."receiptId", to_char(x."reversedDate", 'YYYY-MM-DD'), 'COMMISSION_RETURNED', r.amount::text, t."dealNumber",
           x.reference, CASE WHEN r."operatingAccountId" IS NULL THEN 'BANK_COMMISSION_TRUST' ELSE 'BANK_OPERATING' END, NULL, NULL
      FROM "CommissionReceiptReversal" x JOIN "CommissionReceipt" r ON r.id = x."receiptId"
      JOIN "ClosingStatement" c ON c.id = r."closingId" JOIN "Transaction" t ON t.id = c."transactionId"
     WHERE x."reversedDate" BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT e.id::text, to_char(e."effectiveDate", 'YYYY-MM-DD'), 'TRUST_TO_GENERAL', e.amount::text, t."dealNumber", e."referenceNo",
           'BANK_OPERATING', NULL, NULL
      FROM "TrustLedgerEntry" e JOIN "Transaction" t ON t.id = e."transactionId"
     WHERE e."entryType" = 'DISBURSEMENT_TO_GENERAL' AND e."effectiveDate" BETWEEN ${from}::date AND ${to}::date
    UNION ALL
    SELECT ev.id::text, to_char(ev."eventDate", 'YYYY-MM-DD'), CASE WHEN ev.kind = 'PAID' THEN 'PAYOUT_SENT' ELSE 'PAYOUT_RETURNED' END,
           ABS(mv.signed)::text, t."dealNumber", ev.reference,
           CASE WHEN mv.operating_account IS NULL THEN 'BANK_COMMISSION_TRUST' ELSE 'BANK_OPERATING' END,
           CASE WHEN ev."payoutId" IS NOT NULL THEN 'AGENT_COMMISSION_PAYABLE' WHEN q."payeeType" = 'COOP_BROKERAGE' THEN 'COOP_PAYABLE' ELSE 'REFERRAL_PAYABLE' END,
           COALESCE(p."payeeName", q."payeeName")
      FROM "PayoutEvent" ev CROSS JOIN LATERAL payout_event_money(ev) mv
      LEFT JOIN "ClosingAgentPayout" p ON p.id = ev."payoutId" LEFT JOIN "ClosingPayable" q ON q.id = ev."payableId"
      JOIN "ClosingStatement" c ON c.id = COALESCE(p."closingId", q."closingId") JOIN "Transaction" t ON t.id = c."transactionId"
     WHERE ev."eventDate" BETWEEN ${from}::date AND ${to}::date`;
  const entries = buildJournal(rows.map((m) => ({ ...m, amount: numericToCents(m.amount) }) as Movement), deps.accountMap ?? {});
  const unmapped = ACCOUNT_ROLES.filter((role) => !deps.accountMap?.[role]);
  return { from, to, entries, ready: entries.every((e) => e.ready), unmappedRoles: unmapped, csv: journalCsv(entries) };
}

/** Recent obligations figures for an operating account, newest first, so a second person can find one to attest. */
export async function listObligations(prisma: PrismaClient, actor: Actor, operatingAccountId: string) {
  requireRole(actor, TRUST_VIEWERS, "Viewing obligations figures");
  const rows = await prisma.fundsObligationSnapshot.findMany({
    where: { operatingAccountId }, orderBy: [{ asOf: "desc" }, { createdAt: "desc" }], take: 20, select: { id: true },
  });
  return { obligations: await Promise.all(rows.map((r) => snapshotView(prisma, r.id))) };
}

export async function fundsRoutes(app: FastifyInstance, opts: FundsDeps & { resolveUserId: ResolveUserId }) {
  const actorOf = async (request: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(request));
  const today = () => opts.today?.() ?? todayInToronto();
  app.get<{ Querystring: { accountType?: string; accountId?: string } }>("/api/funds/availability", async (req) => {
    requireRole(await actorOf(req), TRUST_VIEWERS, "Viewing available funds");
    const type = req.query.accountType === "COMMISSION_TRUST" ? "COMMISSION_TRUST" : req.query.accountType === "OPERATING" ? "OPERATING" : null;
    if (!type) throw new RuleViolationError("ACCOUNT_TYPE", "accountType must be OPERATING or COMMISSION_TRUST");
    return fundsAvailability(opts.prisma, { type, id: validatePathUuid(req.query.accountId ?? "", "accountId") }, today());
  });
  app.get<{ Querystring: { operatingAccountId?: string } }>("/api/funds/obligations", async (req) =>
    listObligations(opts.prisma, await actorOf(req), validatePathUuid(req.query.operatingAccountId ?? "", "operatingAccountId")));
  app.post("/api/funds/obligations", async (req, reply) => reply.code(201).send(await recordManualObligations(opts, await actorOf(req), req.body)));
  app.post("/api/funds/obligations/pull", async (req, reply) => reply.code(201).send(await pullObligations(opts, await actorOf(req), req.body)));
  app.post<{ Params: Record<string, string> }>("/api/funds/obligations/:id/attest", async (req) =>
    attestObligations(opts, await actorOf(req), validatePathUuid(req.params.id, "id"), req.body));
  app.get<{ Querystring: { from?: string; to?: string; format?: string } }>("/api/accounting/journal", async (req, reply) => {
    const r = new Reader(req.query, ["from", "to", "format"]);
    const from = r.date("from");
    const to = r.date("to");
    r.done();
    const j = await journal(opts, await actorOf(req), from, to);
    if (req.query.format === "csv") {
      return reply.header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="journal-${from}-to-${to}.csv"`).send(j.csv);
    }
    return { ...j, csv: undefined };
  });
  app.post("/api/accounting/journal/post", async (req) => {
    requireRole(await actorOf(req), ["MANAGING_BROKER"], "Posting to the accounting system");
    throw new DomainError("ACCOUNTING_POSTING_DISABLED", 409, new AccountingPostingDisabled().message);
  });
}
