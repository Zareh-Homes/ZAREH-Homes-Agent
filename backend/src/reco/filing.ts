/**
 * RECO annual financial filing preparation (TRESA s.48.1; docs/regulatory-references.md §6).
 *
 * The broker of record files in RECO's MyWeb portal. This assembles what the
 * filing asks for, says where each figure came from, lists what's missing, and
 * gathers the evidence behind each attestation. It never files anything and
 * never fills in a financial figure: those come from the accountant's
 * statements, entered with their source.
 *
 * Due dates: fiscal years ending 2025-08-01 to 2026-07-31 file by 2026-10-30;
 * later years within 90 days after year end.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, TRUST_VIEWERS, type Actor, type ResolveUserId } from "../auth.ts";
import { ConflictError, DomainError, fromDatabaseError, NotFoundError } from "../errors.ts";
import { isIsoDate, todayInToronto } from "../lib/dates.ts";
import { numericToCents } from "../lib/money.ts";
import { Reader } from "../lib/reader.ts";
import { reconciliationDueBy } from "../bank/service.ts";

export const FINANCIAL_FIELDS = ["CASH", "TOTAL_ASSETS", "TOTAL_LIABILITIES", "EQUITY", "REVENUE", "GROSS_PROFIT", "EXPENSES", "NET_INCOME",
  "TRUST_INTEREST_RETAINED"] as const;
export const ATTESTATIONS = {
  TRUST_SUFFICIENCY: "Trust funds were sufficient to meet all trust liabilities",
  SEPARATION_OF_FUNDS: "Trust money was kept separate from the brokerage's own money",
  MONTHLY_RECONCILIATIONS: "Monthly trust reconciliations were performed",
  SHORTFALLS_REPORTED: "Any shortfall was immediately reported to RECO and replenished",
  NOTICE_OF_CHANGES: "RECO was promptly told of financial distress or changes in directors, officers or shareholders",
  ACCURACY: "The information submitted is accurate",
} as const;
type AttestationItem = keyof typeof ATTESTATIONS;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function filingDueDate(fiscalYearEnd: string): string {
  if (fiscalYearEnd >= "2025-08-01" && fiscalYearEnd <= "2026-07-31") return "2026-10-30";
  return addDays(fiscalYearEnd, 90);
}

const monthEnds = (start: string, end: string) => {
  const out: string[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  for (;;) {
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (last > end) break;
    out.push(last);
    m === 12 ? (y++, m = 1) : m++;
  }
  return out;
};

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  if ((err as { meta?: { code?: string } })?.meta?.code === "23505") throw new ConflictError("ALREADY_EXISTS", "Already recorded");
  throw fromDatabaseError(err) ?? err;
}

type Sourced<T> = { value: T; source: string };

export async function filingPackage(prisma: PrismaClient, fiscalYearEnd: string, today: string) {
  const year = await prisma.recoFilingYear.findUnique({
    where: { fiscalYearEnd: new Date(`${fiscalYearEnd}T00:00:00Z`) },
    include: { inputs: { orderBy: { createdAt: "asc" } }, reviews: { orderBy: { createdAt: "asc" }, include: { reviewedBy: { select: { firstName: true, lastName: true } } } }, submission: true },
  });
  if (!year) throw new NotFoundError("RECO filing year ending", fiscalYearEnd);
  const start = iso(year.fiscalYearStart);
  const end = fiscalYearEnd;
  const missing: string[] = [];

  // Financial statements: entered from the accountant's statements, never computed here
  const latest = new Map(year.inputs.map((i) => [i.field, i]));
  const financial = Object.fromEntries(FINANCIAL_FIELDS.map((f) => {
    const i = latest.get(f);
    if (!i) missing.push(`Financial statements: ${f.toLowerCase().replaceAll("_", " ")}`);
    return [f, i ? { value: i.amount!.toFixed(2), source: i.source } : null];
  })) as Record<(typeof FINANCIAL_FIELDS)[number], Sourced<string> | null>;
  const checks: string[] = [];
  const n = (f: (typeof FINANCIAL_FIELDS)[number]) => (financial[f] ? numericToCents(financial[f]!.value.replace("-", "")) * (financial[f]!.value.startsWith("-") ? -1 : 1) : null);
  if (n("TOTAL_ASSETS") !== null && n("TOTAL_LIABILITIES") !== null && n("EQUITY") !== null && n("TOTAL_ASSETS") !== n("TOTAL_LIABILITIES")! + n("EQUITY")!) {
    checks.push("Total assets don't equal liabilities plus equity: check the figures against the statements");
  }

  // Trust: from the signed reconciliation at year end, per account
  const accounts = await prisma.trustAccount.findMany({ orderBy: { name: "asc" } });
  const trust = [];
  for (const a of accounts) {
    const recon = await prisma.trustReconciliation.findFirst({
      where: { trustAccountId: a.id, periodEnd: { lte: new Date(`${end}T00:00:00Z`) }, signedAt: { not: null }, supersededBy: null },
      orderBy: { periodEnd: "desc" },
    });
    if (!recon || iso(recon.periodEnd) !== end) missing.push(`${a.name}: no signed reconciliation at the fiscal year end (${end})${recon ? `; latest is ${iso(recon.periodEnd)}` : ""}`);
    trust.push({
      account: a.name, kind: a.kind,
      liabilities: recon ? { value: recon.clientLiabilities.toFixed(2), source: `Signed reconciliation to ${iso(recon.periodEnd)}` } : null,
      assets: recon ? { value: recon.adjustedBankBalance.toFixed(2), source: `Adjusted bank balance, reconciliation to ${iso(recon.periodEnd)}` } : null,
      bankBalance: recon ? { value: recon.bankClosingBalance.toFixed(2), source: `Bank statement closing balance ${iso(recon.periodEnd)}` } : null,
    });
  }

  // Unclaimed trust money at year end, by kind, and held more than two years
  const unclaimed = await prisma.$queryRaw<{ unclear: string; notLocated: string; overTwoYears: string; n: number }[]>`
    SELECT COALESCE(SUM(u.amount) FILTER (WHERE u.entitlement <> 'ENTITLED_PARTY_NOT_LOCATED'), 0)::text AS unclear,
           COALESCE(SUM(u.amount) FILTER (WHERE u.entitlement = 'ENTITLED_PARTY_NOT_LOCATED'), 0)::text AS "notLocated",
           COALESCE(SUM(u.amount) FILTER (WHERE COALESCE(u."entitledSince", u."heldSince") <= ${end}::date - interval '2 years'), 0)::text AS "overTwoYears",
           COUNT(*)::int AS n
      FROM "UnclaimedTrustFund" u
     WHERE u."heldSince" <= ${end}::date
       AND NOT EXISTS (SELECT 1 FROM "UnclaimedFundEvent" e WHERE e."fundId" = u.id AND e.kind IN ('REMITTED_TO_RECO', 'RESOLVED_PAID_OUT') AND e."eventDate" <= ${end}::date)`;

  // Bank accounts; full account numbers and branches aren't kept here
  const operating = await prisma.operatingAccount.findMany({ orderBy: { name: "asc" } });
  const branch = (key: string) => latest.get(`BANK_BRANCH:${key}`)?.text ?? null;
  const yearStart = new Date(`${start}T00:00:00Z`);
  const bankAccounts = [
    ...accounts.map((a) => ({ id: a.id, name: a.name, institution: a.bankName, accountLast4: a.accountLast4, branch: branch(a.id),
      type: a.kind === "COMMISSION_TRUST" ? "COMMISSION_TRUST" : "REAL_ESTATE_TRUST", createdAt: a.createdAt, isActive: a.isActive })),
    ...operating.map((a) => ({ id: a.id, name: a.name, institution: a.bankName, accountLast4: a.accountLast4, branch: branch(a.id),
      type: "GENERAL", createdAt: a.createdAt, isActive: a.isActive })),
  ].map((a) => {
    if (!a.branch) missing.push(`${a.name}: branch (enter it as BANK_BRANCH:${a.id})`);
    return {
      name: a.name, institution: a.institution, branch: a.branch, accountNumber: `••••${a.accountLast4} (full number is entered in MyWeb, not kept here)`,
      type: a.type, status: !a.isActive ? "CLOSED (confirm the closing date)" : a.createdAt >= yearStart ? "OPENED" : "MAINTAINED",
    };
  });

  const [{ trades }] = await prisma.$queryRaw<{ trades: number }[]>`
    SELECT COUNT(*)::int AS trades FROM "Transaction" WHERE status = 'CLOSED' AND "closeDate" BETWEEN ${start}::date AND ${end}::date`;

  // Evidence for each attestation
  const months = monthEnds(start, end);
  const reconRows = await prisma.$queryRaw<{ account: string; periodEnd: string; signedAt: Date | null; received: string | null; balanced: boolean }[]>`
    SELECT a.name AS account, to_char(s."periodEnd", 'YYYY-MM-DD') AS "periodEnd", r."signedAt", to_char(s."receivedDate", 'YYYY-MM-DD') AS received,
           COALESCE(r."isBalanced", false) AS balanced
      FROM "TrustAccount" a
      JOIN "BankStatement" s ON s."trustAccountId" = a.id AND s.kind = 'MONTHLY'
      LEFT JOIN LATERAL (SELECT * FROM "TrustReconciliation" x WHERE x."statementId" = s.id AND x."signedAt" IS NOT NULL ORDER BY x."signedAt" LIMIT 1) r ON true
     WHERE s."periodEnd" BETWEEN ${start}::date AND ${end}::date`;
  const reconExceptions: string[] = [];
  for (const a of accounts.filter((x) => x.isActive || x.createdAt <= new Date(`${end}T00:00:00Z`))) {
    for (const m of months) {
      if (a.createdAt > new Date(`${m}T23:59:59Z`)) continue;
      const row = reconRows.find((r) => r.account === a.name && r.periodEnd === m);
      if (!row) reconExceptions.push(`${a.name}: no statement or reconciliation for the month ending ${m}`);
      else if (!row.signedAt) reconExceptions.push(`${a.name}: ${m} not signed`);
      else if (todayInToronto(row.signedAt) > reconciliationDueBy(row.received, m)) {
        reconExceptions.push(`${a.name}: ${m} signed ${todayInToronto(row.signedAt)}, after the ${reconciliationDueBy(row.received, m)} deadline`);
      }
    }
  }
  const incidents = await prisma.trustIncident.findMany({
    where: { kind: "SHORTFALL", detectedAt: { gte: yearStart, lte: new Date(`${end}T23:59:59Z`) } },
    include: { events: true, trustAccount: { select: { name: true } } },
  });
  const shortfallExceptions = incidents.flatMap((i) => {
    const notified = i.events.find((e) => e.kind === "REGISTRAR_NOTIFIED");
    const feeException = i.events.some((e) => e.kind === "CAUSE_DETERMINED" && e.cause === "BANK_SERVICE_FEE") && i.events.some((e) => e.kind === "RESOLVED");
    const resolved = i.events.some((e) => e.kind === "RESOLVED");
    const out: string[] = [];
    if (!notified && !feeException) out.push(`${i.trustAccount.name}: shortfall of $${i.amount.toFixed(2)} found ${iso(i.detectedAt)} has no registrar notice on record`);
    if (!resolved) out.push(`${i.trustAccount.name}: shortfall of $${i.amount.toFixed(2)} found ${iso(i.detectedAt)} is still open`);
    return out;
  });
  const reviewed = new Map(year.reviews.map((r) => [r.item, r]));
  const evidence = (Object.keys(ATTESTATIONS) as AttestationItem[]).map((item) => {
    const exceptions =
      item === "TRUST_SUFFICIENCY" ? [...incidents.map((i) => `${i.trustAccount.name}: shortfall of $${i.amount.toFixed(2)} found ${iso(i.detectedAt)}`),
        ...reconRows.filter((r) => r.signedAt && !r.balanced).map((r) => `${r.account}: ${r.periodEnd} signed with a discrepancy`)]
      : item === "MONTHLY_RECONCILIATIONS" ? reconExceptions
      : item === "SHORTFALLS_REPORTED" ? shortfallExceptions
      : [];
    const basis = {
      TRUST_SUFFICIENCY: "Shortfall incidents and unbalanced reconciliations in the fiscal year",
      SEPARATION_OF_FUNDS: "Enforced by the system: commission is never received into, and payouts never paid from, the real estate trust account; trust money leaves only against cleared deposits and a recorded authorization",
      MONTHLY_RECONCILIATIONS: "Each month of the fiscal year, per trust account: statement, signed reconciliation, signed on time",
      SHORTFALLS_REPORTED: "Each shortfall: registrar notice (or the bank service-fee exception), replenishment, resolution",
      NOTICE_OF_CHANGES: "Not tracked in this system: the broker of record confirms from the brokerage's own records",
      ACCURACY: "The broker of record's review of this package against the financial statements",
    }[item];
    const r = reviewed.get(item);
    return { item, statement: ATTESTATIONS[item], basis, exceptions, reviewedBy: r ? `${r.reviewedBy.firstName} ${r.reviewedBy.lastName}` : null, reviewNote: r?.note ?? null };
  });
  for (const e of evidence.filter((x) => !x.reviewedBy)) missing.push(`Broker of record review: ${e.statement}`);

  const due = filingDueDate(end);
  return {
    fiscalYear: { start, end }, dueDate: due, daysToDue: Math.round((Date.parse(due) - Date.parse(today)) / 86_400_000),
    status: year.submission ? "SUBMITTED" : missing.length ? "IN_PREPARATION" : "READY_FOR_BROKER_TO_FILE",
    submission: year.submission ? { submittedOn: iso(year.submission.submittedOn), reference: year.submission.reference } : null,
    nonTradingReportSuggested: trades === 0,
    financialStatements: financial, checks,
    trust, unclaimed: {
      unclearEntitlement: unclaimed[0]!.unclear, ownerCannotBeLocated: unclaimed[0]!.notLocated, heldOverTwoYears: unclaimed[0]!.overTwoYears,
      records: unclaimed[0]!.n, source: "Unclaimed trust money register at the fiscal year end",
    },
    bankAccounts,
    activity: { closedTrades: trades, source: `Deals marked closed with a close date from ${start} to ${end}` },
    attestations: evidence,
    missing,
    note: "Prepared for the broker of record to file in RECO MyWeb. Nothing has been filed. Check every figure against the financial statements before filing.",
  };
}

export async function createYear(prisma: PrismaClient, actor: Actor, body: unknown) {
  requireRole(actor, ["ADMIN", "MANAGING_BROKER"], "Setting up a RECO filing year");
  const r = new Reader(body, ["fiscalYearStart", "fiscalYearEnd"]);
  const input = { start: r.date("fiscalYearStart"), end: r.date("fiscalYearEnd") };
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "RecoFilingYear" ("fiscalYearEnd", "fiscalYearStart", "createdById") VALUES (${input.end}::date, ${input.start}::date, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return { fiscalYearStart: input.start, fiscalYearEnd: input.end, dueDate: filingDueDate(input.end) };
}

export async function enterFigure(prisma: PrismaClient, actor: Actor, fiscalYearEnd: string, body: unknown, today: string) {
  requireRole(actor, ["ADMIN", "MANAGING_BROKER"], "Entering RECO filing figures");
  const r = new Reader(body, ["field", "amount", "text", "source", "documentFileId"]);
  const field = r.text("field", 100);
  r.check((FINANCIAL_FIELDS as readonly string[]).includes(field) || field.startsWith("BANK_BRANCH:"), "field", `one of ${FINANCIAL_FIELDS.join(", ")} or BANK_BRANCH:<account id>`);
  const isBranch = field.startsWith("BANK_BRANCH:");
  const raw = r.raw("amount");
  const amount = isBranch ? null : typeof raw === "string" && /^-?\d{1,14}(\.\d{1,2})?$/.test(raw) ? raw : (r.fail("amount", 'a decimal string, e.g. "125000.00" or "-500.00"'), null);
  const text = isBranch ? r.text("text", 300) : null;
  const input = { source: r.text("source", 500), documentFileId: r.optionalUuid("documentFileId") };
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "RecoFilingInput" (id, "fiscalYearEnd", field, amount, text, source, "documentFileId", "enteredById")
      VALUES (gen_random_uuid(), ${fiscalYearEnd}::date, ${field}, ${amount}::numeric, ${text}, ${input.source}, ${input.documentFileId}::uuid, ${actor.id}::uuid)`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23503") throw new NotFoundError("RECO filing year ending", fiscalYearEnd);
    rethrow(err);
  }
  return filingPackage(prisma, fiscalYearEnd, today);
}

export async function reviewAttestation(prisma: PrismaClient, actor: Actor, fiscalYearEnd: string, body: unknown, today: string) {
  requireRole(actor, ["MANAGING_BROKER"], "Reviewing RECO filing attestations");
  const r = new Reader(body, ["item", "note"]);
  const input = { item: r.oneOf("item", Object.keys(ATTESTATIONS) as AttestationItem[]), note: r.text("note", 2000) };
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "RecoAttestationReview" (id, "fiscalYearEnd", item, note, "reviewedById")
      VALUES (gen_random_uuid(), ${fiscalYearEnd}::date, ${input.item}, ${input.note}, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return filingPackage(prisma, fiscalYearEnd, today);
}

export async function recordSubmission(prisma: PrismaClient, actor: Actor, fiscalYearEnd: string, body: unknown, today: string) {
  requireRole(actor, ["MANAGING_BROKER"], "Recording the RECO filing");
  const r = new Reader(body, ["submittedOn", "reference", "note"]);
  const input = { submittedOn: r.pastDate("submittedOn", today), reference: r.text("reference", 200), note: r.optionalText("note", 2000) };
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "RecoFilingSubmission" ("fiscalYearEnd", "submittedOn", reference, note, "submittedById")
      VALUES (${fiscalYearEnd}::date, ${input.submittedOn}::date, ${input.reference}, ${input.note}, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return filingPackage(prisma, fiscalYearEnd, today);
}

/** The package as a two-column CSV, for checking line by line against MyWeb. */
export function packageCsv(p: Awaited<ReturnType<typeof filingPackage>>): string {
  const rows: [string, string, string][] = [["Section / item", "Value", "Source"]];
  for (const [k, v] of Object.entries(p.financialStatements)) rows.push([`Financial: ${k}`, v?.value ?? "MISSING", v?.source ?? ""]);
  for (const t of p.trust) {
    rows.push([`Trust ${t.account}: liabilities`, t.liabilities?.value ?? "MISSING", t.liabilities?.source ?? ""]);
    rows.push([`Trust ${t.account}: assets`, t.assets?.value ?? "MISSING", t.assets?.source ?? ""]);
    rows.push([`Trust ${t.account}: bank balance`, t.bankBalance?.value ?? "MISSING", t.bankBalance?.source ?? ""]);
  }
  rows.push(["Unclaimed: unclear entitlement", p.unclaimed.unclearEntitlement, p.unclaimed.source]);
  rows.push(["Unclaimed: owner cannot be located", p.unclaimed.ownerCannotBeLocated, p.unclaimed.source]);
  rows.push(["Unclaimed: held over two years", p.unclaimed.heldOverTwoYears, p.unclaimed.source]);
  for (const b of p.bankAccounts) rows.push([`Bank: ${b.name} (${b.type})`, `${b.institution} · ${b.branch ?? "BRANCH MISSING"} · ${b.accountNumber} · ${b.status}`, "Account register"]);
  rows.push(["Closed trades", String(p.activity.closedTrades), p.activity.source]);
  for (const a of p.attestations) rows.push([`Attestation: ${a.statement}`, a.exceptions.length ? `${a.exceptions.length} exception(s)` : "No exceptions found", a.basis]);
  const cell = (v: string) => {
    const safe = /^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v;
    return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export async function recoRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; today?: () => string }) {
  const actorOf = async (req: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(req));
  const today = () => opts.today?.() ?? todayInToronto();
  type P = { Params: { fiscalYearEnd: string }; Querystring: { format?: string } };
  const fye = (v: string) => {
    if (!isIsoDate(v)) throw new NotFoundError("RECO filing year ending", v);
    return v;
  };
  app.post("/api/reco/filings", async (req, reply) => reply.code(201).send(await createYear(opts.prisma, await actorOf(req), req.body)));
  app.get<P>("/api/reco/filings/:fiscalYearEnd", async (req, reply) => {
    requireRole(await actorOf(req), TRUST_VIEWERS, "Viewing the RECO filing");
    const p = await filingPackage(opts.prisma, fye(req.params.fiscalYearEnd), today());
    if (req.query.format === "csv") {
      return reply.header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="reco-annual-filing-${p.fiscalYear.end}.csv"`).send(packageCsv(p));
    }
    return p;
  });
  app.post<P>("/api/reco/filings/:fiscalYearEnd/figures", async (req, reply) =>
    reply.code(201).send(await enterFigure(opts.prisma, await actorOf(req), fye(req.params.fiscalYearEnd), req.body, today())));
  app.post<P>("/api/reco/filings/:fiscalYearEnd/attestation-reviews", async (req, reply) =>
    reply.code(201).send(await reviewAttestation(opts.prisma, await actorOf(req), fye(req.params.fiscalYearEnd), req.body, today())));
  app.post<P>("/api/reco/filings/:fiscalYearEnd/submission", async (req, reply) =>
    reply.code(201).send(await recordSubmission(opts.prisma, await actorOf(req), fye(req.params.fiscalYearEnd), req.body, today())));
}

export const _test = { monthEnds };
