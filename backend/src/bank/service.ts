/**
 * Bank statements, matching and monthly trust reconciliation.
 *
 * The trust ledger records what the brokerage says happened; the bank
 * statement is the evidence. Every ledger entry is matched to a statement
 * line of the same account and amount (automatically when there's exactly one
 * sensible candidate, otherwise by hand). The database only lets money leave
 * trust against deposits that have been matched (migration 008), and only
 * lets agent payouts be approved once the commission is matched to the
 * operating account.
 *
 * Each month, admin prepares the reconciliation for the statement; a managing
 * broker signs it. Exceptions (shortfalls, stale deposits, bank items missing
 * from the ledger) notify every managing broker as soon as they're found.
 */

import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type UserRole } from "@prisma/client";
import { requireRole, TRUST_AUTHORIZERS, TRUST_VIEWERS, type Actor } from "../auth.ts";
import { ConflictError, DomainError, fromDatabaseError, NotFoundError, RuleViolationError, ValidationError } from "../errors.ts";
import { insertNotifications, type NotificationHub, type NotificationView } from "../compliance/notifications.ts";
import { todayInToronto } from "../lib/dates.ts";
import { formatCents, numericToCents, parseAmount, type Cents } from "../lib/money.ts";
import { isUuid, Reader } from "../lib/reader.ts";
import { BankCsvError, checkRunningBalance, parseBankCsv, type BankLine, type DateOrder } from "./csv.ts";
import { reconcile, type ReconBankLine, type ReconLedgerEntry, type ReconResult } from "./reconcile.ts";
import { compareInterimToMonthly, type IntegrityLine } from "./integrity.ts";
import { loadBusinessCalendar } from "../lib/calendar-store.ts";

export const BANK_STAFF: readonly UserRole[] = ["ADMIN", "MANAGING_BROKER"];
export const RECONCILIATION_DUE_DAYS = 30;

type Db = PrismaClient | Prisma.TransactionClient;

export interface BankDeps {
  prisma: PrismaClient;
  hub: NotificationHub;
  today?: () => string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const cents = (d: Prisma.Decimal) => numericToCents(d.toFixed(2));
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
const addDays = (date: string, n: number) => new Date((dayNumber(date) + n) * 86_400_000).toISOString().slice(0, 10);

function signedMoney(r: Reader, field: string): Cents {
  const v = r.raw(field);
  if (typeof v !== "string") {
    r.fail(field, 'must be a decimal string, e.g. "125000.00" or "-50.00"');
    return 0;
  }
  const negative = v.startsWith("-");
  const c = parseAmount(negative ? v.slice(1) : v);
  if (c === null) {
    r.fail(field, 'must be a decimal string, e.g. "125000.00" or "-50.00"');
    return 0;
  }
  return negative ? -c : c;
}

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  const code = (err as { meta?: { code?: string } })?.meta?.code;
  if (code === "23505") throw new ConflictError("ALREADY_MATCHED", "That bank line or entry is already matched");
  throw fromDatabaseError(err) ?? err;
}

async function brokers(db: Db): Promise<string[]> {
  return (await db.user.findMany({ where: { role: "MANAGING_BROKER", isActive: true }, select: { id: true } })).map((u) => u.id);
}

// ── Operating accounts ───────────────────────────────────────────────────────

export async function createOperatingAccount(deps: BankDeps, actor: Actor, body: unknown) {
  requireRole(actor, BANK_STAFF, "Adding an operating account");
  const r = new Reader(body, ["name", "bankName", "accountLast4"]);
  const input = { name: r.text("name", 100), bankName: r.text("bankName", 100), accountLast4: r.text("accountLast4", 4, 4) };
  r.check(/^[0-9]{4}$/.test(input.accountLast4), "accountLast4", "must be 4 digits");
  r.done();
  const a = await deps.prisma.operatingAccount.create({ data: input });
  return { id: a.id, name: a.name, bankName: a.bankName, accountLast4: a.accountLast4 };
}

// ── Statement import ─────────────────────────────────────────────────────────

export interface StatementView {
  id: string;
  kind: "MONTHLY" | "INTERIM";
  account: { type: "TRUST" | "OPERATING"; id: string };
  periodStart: string;
  periodEnd: string;
  openingBalance: string | null;
  closingBalance: string;
  receivedDate: string | null;
  source: string | null;
  fileName: string;
  importedBy: string;
  verification: { verifiedBy: string; method: string; verifiedAt: string; segregationException: boolean; exceptionsReviewed: string | null } | null;
  /** Differences from the account's other bank records; the verifier must say how each was checked */
  integrityExceptions: string[];
  lines: {
    id: string;
    lineNumber: number;
    postedDate: string;
    amount: string;
    description: string;
    reference: string | null;
    match: {
      id: string; trustEntryId: string | null; commissionReceiptId: string | null; payoutEventId: string | null;
      receiptReversalId: string | null; dealNumber: string | null;
    } | null;
  }[];
  matched: number;
  unmatched: number;
}

interface Candidate {
  id: string; // "<match column>:<uuid>"
  signed: Cents;
  date: string;
  reference: string | null;
}

const MATCH_TARGETS = ["trustEntryId", "commissionReceiptId", "payoutEventId", "receiptReversalId"] as const;
type MatchTarget = (typeof MATCH_TARGETS)[number];

/** One sensible ledger entry per bank line, or none. Never guesses between two. */
export function proposeMatches(lines: { id: string; postedDate: string; amount: Cents; text: string }[], candidates: Candidate[]): Map<string, string> {
  const fits = (l: (typeof lines)[number], c: Candidate) => {
    if (c.signed !== l.amount) return false;
    const gap = dayNumber(l.postedDate) - dayNumber(c.date);
    return c.signed > 0 ? Math.abs(gap) <= 5 : gap >= 0 && gap <= 60; // a payment clears after it's made, sometimes weeks after
  };
  const strong = (l: (typeof lines)[number], c: Candidate) =>
    !!c.reference && c.reference.length >= 3 && l.text.toLowerCase().includes(c.reference.toLowerCase());

  const chosen = new Map<string, string>();
  for (const l of lines) {
    const all = candidates.filter((c) => fits(l, c));
    const best = all.filter((c) => strong(l, c));
    const pick = best.length === 1 ? best[0] : all.length === 1 ? all[0] : undefined;
    if (pick) chosen.set(l.id, pick.id);
  }
  // Drop any entry two lines both picked
  const counts = new Map<string, number>();
  for (const c of chosen.values()) counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const [line, c] of chosen) if (counts.get(c)! > 1) chosen.delete(line);
  return chosen;
}

async function insertMatch(db: Db, actor: Actor, lineId: string, column: MatchTarget, targetId: string, note: string | null): Promise<string> {
  const target = (c: MatchTarget) => (c === column ? targetId : null);
  const [row] = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "BankMatch" (id, basis, "bankTransactionId", "trustEntryId", "commissionReceiptId", "payoutEventId", "receiptReversalId",
                             note, "matchedById")
    VALUES (gen_random_uuid(), 'BANK_STATEMENT', ${lineId}::uuid, ${target("trustEntryId")}::uuid, ${target("commissionReceiptId")}::uuid,
            ${target("payoutEventId")}::uuid, ${target("receiptReversalId")}::uuid, ${note}, ${actor.id}::uuid)
    RETURNING id::text`;
  return row!.id;
}

async function autoMatch(tx: Prisma.TransactionClient, actor: Actor, statementId: string): Promise<number> {
  const stmt = await tx.bankStatement.findUniqueOrThrow({ where: { id: statementId }, include: { lines: { include: { match: true } } } });
  const kind = stmt.kind;
  const lines = stmt.lines.filter((l) => !l.match).map((l) => ({
    id: l.id, postedDate: iso(l.postedDate), amount: cents(l.amount), text: `${l.reference ?? ""} ${l.description}`,
  }));
  if (lines.length === 0) return 0;
  const from = addDays(iso(stmt.periodStart), -60);
  const to = addDays(iso(stmt.periodEnd), 5);

  const trustKind = stmt.trustAccountId
    ? (await tx.trustAccount.findUniqueOrThrow({ where: { id: stmt.trustAccountId }, select: { kind: true } })).kind
    : null;
  const unmatched = (column: MatchTarget) => Prisma.sql`NOT EXISTS (SELECT 1 FROM "BankMatch" m WHERE m.${Prisma.raw(`"${column}"`)} = x.id
    AND (m."matchKind" = ${kind}::"StatementKind" OR m."matchKind" = 'MONTHLY'))`;
  let rows: { id: string; signed: string; date: string; reference: string | null }[];
  if (trustKind === "REAL_ESTATE_TRUST") {
    rows = await tx.$queryRaw`
      SELECT 'trustEntryId:' || x.id AS id, (x.amount * x.direction)::text AS signed, to_char(x."effectiveDate", 'YYYY-MM-DD') AS date,
             x."referenceNo" AS reference
        FROM "TrustLedgerEntry" x
       WHERE x."trustAccountId" = ${stmt.trustAccountId}::uuid
         AND x."effectiveDate" BETWEEN ${from}::date AND ${to}::date AND ${unmatched("trustEntryId")}`;
  } else {
    // Commission in, commission returned, payments out and payments returned, for this account
    rows = await tx.$queryRaw`
      SELECT 'commissionReceiptId:' || x.id AS id, x.amount::text AS signed, to_char(x."receivedDate", 'YYYY-MM-DD') AS date, x.reference
        FROM "CommissionReceipt" x
       WHERE x."receivedDate" BETWEEN ${from}::date AND ${to}::date
         AND x."trustAccountId" IS NOT DISTINCT FROM ${stmt.trustAccountId}::uuid
         AND x."operatingAccountId" IS NOT DISTINCT FROM ${stmt.operatingAccountId}::uuid
         AND NOT EXISTS (SELECT 1 FROM "CommissionReceiptReversal" v WHERE v."receiptId" = x.id) AND ${unmatched("commissionReceiptId")}
      UNION ALL
      SELECT 'receiptReversalId:' || x.id, (-r.amount)::text, to_char(v."reversedDate", 'YYYY-MM-DD'), v.reference
        FROM "CommissionReceiptReversal" v JOIN "CommissionReceipt" r ON r.id = v."receiptId"
        CROSS JOIN LATERAL (SELECT v."receiptId" AS id) x
       WHERE v."reversedDate" BETWEEN ${from}::date AND ${to}::date
         AND r."trustAccountId" IS NOT DISTINCT FROM ${stmt.trustAccountId}::uuid
         AND r."operatingAccountId" IS NOT DISTINCT FROM ${stmt.operatingAccountId}::uuid AND ${unmatched("receiptReversalId")}
      UNION ALL
      SELECT 'payoutEventId:' || x.id, mv.signed::text, to_char(x."eventDate", 'YYYY-MM-DD'), x.reference
        FROM "PayoutEvent" x CROSS JOIN LATERAL payout_event_money(x) mv
       WHERE x."eventDate" BETWEEN ${from}::date AND ${to}::date
         AND mv.trust_account IS NOT DISTINCT FROM ${stmt.trustAccountId}::uuid
         AND mv.operating_account IS NOT DISTINCT FROM ${stmt.operatingAccountId}::uuid AND ${unmatched("payoutEventId")}`;
  }
  const candidates: Candidate[] = rows.map((r) => ({ ...r, signed: numericToCents(r.signed) }));

  const proposals = proposeMatches(lines, candidates);
  for (const [lineId, target] of proposals) {
    const [column, targetId] = target.split(":") as [MatchTarget, string];
    await insertMatch(tx, actor, lineId, column, targetId, "Matched automatically on import");
  }
  return proposals.size;
}

export const STATEMENT_SOURCES = ["BANK_PORTAL_DOWNLOAD", "BANK_EMAIL", "BANK_PAPER_STATEMENT", "OTHER"] as const;

const normalize = (t: string | null) => (t ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Imports a bank file for a trust, commission trust or operating account.
 *
 *   MONTHLY  the bank's statement for a period: consecutive, opening + lines = closing.
 *            Used for the s.13 reconciliation. receivedDate starts its 30-day clock.
 *   INTERIM  recent activity and the current balance, downloaded from the bank between
 *            statements, so a commission can be verified (and funds shown to be available)
 *            the day it arrives. Interim files may overlap; lines already imported from an
 *            earlier interim file are skipped. They never replace the monthly statement.
 *
 * Nothing here counts as evidence until a second person verifies the file against the bank.
 */
export async function importStatement(deps: BankDeps, actor: Actor, body: unknown) {
  requireRole(actor, BANK_STAFF, "Importing a bank statement");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body, [
    "kind", "accountType", "accountId", "periodStart", "periodEnd", "openingBalance", "closingBalance", "receivedDate",
    "source", "sourceNote", "fileName", "csv", "dateOrder", "autoMatch",
  ]);
  const kind = (r.has("kind") ? r.oneOf("kind", ["MONTHLY", "INTERIM"] as const) : "MONTHLY") as "MONTHLY" | "INTERIM";
  const input = {
    kind,
    accountType: r.oneOf("accountType", ["TRUST", "OPERATING"] as const),
    accountId: r.uuid("accountId"),
    periodStart: r.date("periodStart"),
    periodEnd: r.pastDate("periodEnd", today),
    openingBalance: kind === "MONTHLY" ? signedMoney(r, "openingBalance") : null,
    closingBalance: signedMoney(r, "closingBalance"),
    receivedDate: r.pastDate("receivedDate", today),
    source: r.oneOf("source", STATEMENT_SOURCES),
    sourceNote: r.optionalText("sourceNote", 500),
    fileName: r.text("fileName", 255),
    csv: r.text("csv", 5_000_000),
    dateOrder: (r.has("dateOrder") ? r.oneOf("dateOrder", ["MDY", "DMY", "YMD"] as const) : "MDY") as DateOrder,
    autoMatch: r.has("autoMatch") ? r.bool("autoMatch") : true,
  };
  if (kind === "INTERIM") r.check(!r.has("openingBalance"), "openingBalance", "is only for monthly statements");
  if (input.periodStart && input.periodEnd) r.check(input.periodEnd >= input.periodStart, "periodEnd", "cannot be before periodStart");
  if (input.receivedDate && input.periodEnd) r.check(input.receivedDate >= input.periodEnd, "receivedDate", "can't be before the statement date");
  r.check(input.source !== "OTHER" || input.sourceNote !== null, "sourceNote", "say where the file came from");
  r.done();

  let lines: BankLine[];
  try {
    lines = parseBankCsv(input.csv, input.dateOrder);
  } catch (err) {
    if (err instanceof BankCsvError) throw new ValidationError(err.issues.map((message) => ({ field: "csv", message })));
    throw err;
  }
  const issues: string[] = [];
  const outside = lines.filter((l) => l.postedDate < input.periodStart || l.postedDate > input.periodEnd);
  if (outside.length) issues.push(`${outside.length} line(s) dated outside ${input.periodStart} to ${input.periodEnd}, e.g. line ${outside[0]!.lineNumber} (${outside[0]!.postedDate}); check the date order (${input.dateOrder})`);
  if (input.openingBalance !== null) {
    const total = lines.reduce((s, l) => s + l.amount, 0);
    if (input.openingBalance + total !== input.closingBalance) {
      issues.push(`opening ${formatCents(input.openingBalance)} + transactions ${formatCents(total)} = ${formatCents(input.openingBalance + total)}, but the statement closes at ${formatCents(input.closingBalance)}`);
    }
    const running = checkRunningBalance(lines, input.openingBalance);
    if (running) issues.push(running);
  }
  if (issues.length) throw new ValidationError(issues.map((message) => ({ field: "csv", message })));

  const trustAccountId = input.accountType === "TRUST" ? input.accountId : null;
  const operatingAccountId = input.accountType === "OPERATING" ? input.accountId : null;
  const account = trustAccountId
    ? await deps.prisma.trustAccount.findUnique({ where: { id: trustAccountId } })
    : await deps.prisma.operatingAccount.findUnique({ where: { id: operatingAccountId! } });
  if (!account || !account.isActive) throw new NotFoundError(input.accountType === "TRUST" ? "Trust account" : "Operating account", input.accountId);

  const sha = createHash("sha256").update(input.csv).digest("hex");
  const duplicate = await deps.prisma.bankStatement.findFirst({ where: { trustAccountId, operatingAccountId, fileSha256: sha } });
  if (duplicate) throw new ConflictError("STATEMENT_ALREADY_IMPORTED", `This file was already imported (statement ${duplicate.id})`);

  // Interim lines are fingerprinted so the same bank transaction can't be imported (and used as evidence) twice
  const seen = new Map<string, number>();
  const fingerprinted = lines.map((l) => {
    const base = `${input.accountId}|${l.postedDate}|${l.amount}|${normalize(l.reference)}|${normalize(l.description)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...l, interimFingerprint: createHash("sha256").update(`interim|${base}|${n}`).digest("hex") };
  });
  let toInsert = fingerprinted;
  let duplicatesSkipped = 0;
  if (kind === "INTERIM") {
    const existing = new Set((await deps.prisma.bankTransaction.findMany({
      where: { fingerprint: { in: fingerprinted.map((l) => l.interimFingerprint) } }, select: { fingerprint: true },
    })).map((t) => t.fingerprint));
    toInsert = fingerprinted.filter((l) => !existing.has(l.interimFingerprint));
    duplicatesSkipped = fingerprinted.length - toInsert.length;
  }

  const integrityExceptions = await crossCheck(deps.prisma, { trustAccountId, operatingAccountId }, {
    kind, fileName: input.fileName, periodStart: input.periodStart, periodEnd: input.periodEnd,
    openingBalance: input.openingBalance, closingBalance: input.closingBalance, lines,
  });

  let statementId = "";
  let autoMatched = 0;
  const published: NotificationView[] = [];
  try {
    await deps.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "BankStatement" (id, kind, "trustAccountId", "operatingAccountId", "periodStart", "periodEnd", "openingBalance",
                                     "closingBalance", "receivedDate", source, "sourceNote", "fileName", "fileSha256", "importedById",
                                     "integrityExceptions")
        VALUES (gen_random_uuid(), ${kind}::"StatementKind", ${trustAccountId}::uuid, ${operatingAccountId}::uuid,
                ${input.periodStart}::date, ${input.periodEnd}::date,
                ${input.openingBalance === null ? null : formatCents(input.openingBalance)}::numeric, ${formatCents(input.closingBalance)}::numeric,
                ${input.receivedDate}::date, ${input.source}, ${input.sourceNote}, ${input.fileName}, ${sha}, ${actor.id}::uuid,
                ${JSON.stringify(integrityExceptions)}::jsonb)
        RETURNING id::text`;
      statementId = row!.id;
      for (const l of toInsert) {
        const fingerprint = kind === "INTERIM" ? l.interimFingerprint : `monthly|${statementId}|${l.lineNumber}`;
        await tx.$executeRaw`
          INSERT INTO "BankTransaction" (id, "statementId", "lineNumber", "postedDate", amount, description, reference, fingerprint)
          VALUES (gen_random_uuid(), ${statementId}::uuid, ${l.lineNumber}, ${l.postedDate}::date, ${formatCents(l.amount)}::numeric,
                  ${l.description}, ${l.reference}, ${fingerprint})`;
      }
      if (input.autoMatch) autoMatched = await autoMatch(tx, actor, statementId);

      if (integrityExceptions.length > 0) {
        published.push(...await insertNotifications(tx, {
          userIds: await brokers(tx),
          type: "BANK_RECORD_MISMATCH",
          title: `${account.name}: bank file ${input.fileName} doesn't agree with earlier bank records`,
          body: `${integrityExceptions.slice(0, 3).join(" · ")}. Check with the bank before relying on either file.`,
          dealId: null,
          slotId: null,
        }));
      }

      // Money moved in a trust account that the ledger doesn't explain: tell the brokers now
      if (trustAccountId) {
        const unmatchedOut = await tx.$queryRaw<{ n: number; total: string }[]>`
          SELECT COUNT(*)::int AS n, COALESCE(SUM(t.amount), 0)::text AS total FROM "BankTransaction" t
           WHERE t."statementId" = ${statementId}::uuid AND t.amount < 0
             AND NOT EXISTS (SELECT 1 FROM "BankMatch" m WHERE m."bankTransactionId" = t.id)`;
        if (unmatchedOut[0]!.n > 0) {
          published.push(...await insertNotifications(tx, {
            userIds: await brokers(tx),
            type: "TRUST_BANK_UNMATCHED_WITHDRAWAL",
            title: `${unmatchedOut[0]!.n} trust withdrawal(s) not in the ledger`,
            body: `The ${input.periodEnd} ${kind === "MONTHLY" ? "statement" : "bank activity"} for ${account.name} shows ` +
              `$${unmatchedOut[0]!.total.replace("-", "")} leaving trust with no matching ledger entry. ` +
              "Check for returned deposits, bank fees or unrecorded payments before releasing funds.",
            dealId: null,
            slotId: null,
          }));
        }
      }
    }, { timeout: 30_000 });
  } catch (err) {
    rethrow(err);
  }
  for (const n of published) deps.hub.publish(n);
  return { ...(await getStatement(deps, actor, statementId)), autoMatched, duplicatesSkipped };
}

/** Monthly statements are compared with every interim file for the same dates, in whichever order they arrive. */
async function crossCheck(
  db: Db, account: { trustAccountId: string | null; operatingAccountId: string | null },
  file: { kind: "MONTHLY" | "INTERIM"; fileName: string; periodStart: string; periodEnd: string; openingBalance: Cents | null;
          closingBalance: Cents; lines: BankLine[] },
): Promise<string[]> {
  const toLines = (ls: { postedDate: string | Date; amount: Cents | Prisma.Decimal; description: string }[]): IntegrityLine[] =>
    ls.map((l) => ({
      postedDate: typeof l.postedDate === "string" ? l.postedDate : iso(l.postedDate),
      amount: typeof l.amount === "number" ? l.amount : cents(l.amount), description: l.description,
    }));
  const others = await db.bankStatement.findMany({
    where: {
      trustAccountId: account.trustAccountId, operatingAccountId: account.operatingAccountId,
      kind: file.kind === "MONTHLY" ? "INTERIM" : "MONTHLY",
      periodStart: { lte: new Date(`${file.periodEnd}T00:00:00Z`) }, periodEnd: { gte: new Date(`${file.periodStart}T00:00:00Z`) },
    },
    include: { lines: true },
  });
  const out: string[] = [];
  for (const o of others) {
    if (file.kind === "MONTHLY") {
      out.push(...compareInterimToMonthly(
        { periodStart: file.periodStart, periodEnd: file.periodEnd, openingBalance: file.openingBalance!, lines: toLines(file.lines) },
        { label: `interim file ${o.fileName}`, periodStart: iso(o.periodStart), periodEnd: iso(o.periodEnd), closingBalance: cents(o.closingBalance), lines: toLines(o.lines) },
      ));
    } else {
      out.push(...compareInterimToMonthly(
        { periodStart: iso(o.periodStart), periodEnd: iso(o.periodEnd), openingBalance: cents(o.openingBalance!), lines: toLines(o.lines) },
        { label: `this file (monthly statement ${o.fileName} differs)`, periodStart: file.periodStart, periodEnd: file.periodEnd,
          closingBalance: file.closingBalance, lines: toLines(file.lines) },
      ));
    }
  }
  return out;
}

/** A second person confirms the imported file against the bank itself (portal, statement). */
export async function verifyStatement(deps: BankDeps, actor: Actor, statementId: string, body: unknown) {
  requireRole(actor, BANK_STAFF, "Verifying a bank statement");
  const r = new Reader(body, ["method", "exceptionReason", "exceptionsReviewed"]);
  const method = r.text("method", 500);
  const exceptionReason = r.optionalText("exceptionReason", 500);
  const exceptionsReviewed = r.optionalText("exceptionsReviewed", 4000);
  r.done();
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO "BankStatementVerification" ("statementId", "verifiedById", method, "exceptionReason", "exceptionsReviewed")
      VALUES (${statementId}::uuid, ${actor.id}::uuid, ${method}, ${exceptionReason}, ${exceptionsReviewed})`;
  } catch (err) {
    const code = (err as { meta?: { code?: string } })?.meta?.code;
    if (code === "23505") throw new ConflictError("STATEMENT_ALREADY_VERIFIED", "This bank file is already verified");
    if (code === "23503") throw new NotFoundError("Bank statement", statementId);
    rethrow(err);
  }
  return getStatement(deps, actor, statementId);
}

export async function getStatement(deps: BankDeps, actor: Actor, statementId: string): Promise<StatementView> {
  requireRole(actor, TRUST_VIEWERS, "Viewing a bank statement");
  const s = await deps.prisma.bankStatement.findUnique({
    where: { id: statementId },
    include: {
      importedBy: { select: { firstName: true, lastName: true } },
      verification: { include: { verifiedBy: { select: { firstName: true, lastName: true } } } },
      lines: {
        orderBy: { lineNumber: "asc" },
        include: { match: { include: { trustEntry: { select: { transaction: { select: { dealNumber: true } } } } } } },
      },
    },
  });
  if (!s) throw new NotFoundError("Bank statement", statementId);
  const lines = s.lines.map((l) => ({
    id: l.id,
    lineNumber: l.lineNumber,
    postedDate: iso(l.postedDate),
    amount: l.amount.toFixed(2),
    description: l.description,
    reference: l.reference,
    match: l.match
      ? { id: l.match.id, trustEntryId: l.match.trustEntryId, commissionReceiptId: l.match.commissionReceiptId,
          payoutEventId: l.match.payoutEventId, receiptReversalId: l.match.receiptReversalId,
          dealNumber: l.match.trustEntry?.transaction.dealNumber ?? null }
      : null,
  }));
  const v = s.verification;
  return {
    id: s.id,
    kind: s.kind,
    account: s.trustAccountId ? { type: "TRUST", id: s.trustAccountId } : { type: "OPERATING", id: s.operatingAccountId! },
    periodStart: iso(s.periodStart),
    periodEnd: iso(s.periodEnd),
    openingBalance: s.openingBalance?.toFixed(2) ?? null,
    closingBalance: s.closingBalance.toFixed(2),
    receivedDate: s.receivedDate ? iso(s.receivedDate) : null,
    source: s.source,
    fileName: s.fileName,
    importedBy: `${s.importedBy.firstName} ${s.importedBy.lastName}`,
    verification: v
      ? { verifiedBy: `${v.verifiedBy.firstName} ${v.verifiedBy.lastName}`, method: v.method, verifiedAt: v.verifiedAt.toISOString(),
          segregationException: v.segregationException, exceptionsReviewed: v.exceptionsReviewed }
      : null,
    integrityExceptions: s.integrityExceptions as string[],
    lines,
    matched: lines.filter((l) => l.match).length,
    unmatched: lines.filter((l) => !l.match).length,
  };
}

// ── Matching ─────────────────────────────────────────────────────────────────

export async function matchLine(deps: BankDeps, actor: Actor, body: unknown) {
  requireRole(actor, BANK_STAFF, "Matching a bank transaction");
  const r = new Reader(body, ["bankTransactionId", ...MATCH_TARGETS, "note"]);
  const bankTransactionId = r.uuid("bankTransactionId");
  const targets = MATCH_TARGETS.map((c) => [c, r.optionalUuid(c)] as const).filter(([, id]) => id !== null);
  const note = r.optionalText("note", 500);
  r.check(targets.length === 1, "trustEntryId", `give exactly one of ${MATCH_TARGETS.join(", ")}`);
  r.done();
  try {
    return { matchId: await insertMatch(deps.prisma, actor, bankTransactionId, targets[0]![0], targets[0]![1]!, note) };
  } catch (err) {
    rethrow(err);
  }
}

export async function unmatch(deps: BankDeps, actor: Actor, matchId: string) {
  requireRole(actor, BANK_STAFF, "Removing a bank match");
  try {
    const n = await deps.prisma.$executeRaw`DELETE FROM "BankMatch" WHERE id = ${matchId}::uuid`;
    if (n === 0) throw new NotFoundError("Bank match", matchId);
  } catch (err) {
    rethrow(err);
  }
  return { removed: matchId };
}

/** History from before the first imported statement (e.g. migrated from Lone Wolf), attested by the broker of record. */
export async function attestPreCutover(deps: BankDeps, actor: Actor, body: unknown) {
  requireRole(actor, TRUST_AUTHORIZERS, "Attesting to pre-cutover trust history");
  const r = new Reader(body, ["trustEntryIds", "note"]);
  const ids = r.textList("trustEntryIds", 500, 36);
  r.check(ids.every(isUuid), "trustEntryIds", "must be entry IDs");
  const note = r.text("note", 500);
  r.done();
  try {
    await deps.prisma.$transaction(async (tx) => {
      for (const id of ids) {
        await tx.$executeRaw`
          INSERT INTO "BankMatch" (id, basis, "trustEntryId", note, "matchedById")
          VALUES (gen_random_uuid(), 'PRE_CUTOVER', ${id}::uuid, ${note}, ${actor.id}::uuid)
          ON CONFLICT ("trustEntryId", "matchKind") DO NOTHING`;
      }
    });
  } catch (err) {
    rethrow(err);
  }
  return { attested: ids.length };
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export async function computeForStatement(db: Db, statementId: string): Promise<{
  result: ReconResult; trustAccountId: string; periodEnd: string; receivedDate: string | null;
}> {
  const s = await db.bankStatement.findUnique({ where: { id: statementId }, include: { trustAccount: { select: { kind: true } } } });
  if (!s || !s.trustAccountId || s.kind !== "MONTHLY") throw new NotFoundError("Monthly trust account statement", statementId);
  const D = iso(s.periodEnd);

  type Row = {
    id: string; dealId: string; dealNumber: string; entryType: string; signed: string; effectiveDate: string; receivedDate: string | null;
    referenceNo: string | null; counterparty: string | null; basis: "BANK_STATEMENT" | "PRE_CUTOVER" | null; postedDate: string | null;
  };
  // A commission trust account's ledger is its receipts and payments (migration 012)
  const entries = s.trustAccount!.kind === "COMMISSION_TRUST" ? await db.$queryRaw<Row[]>`
    SELECT id::text, deal_id::text AS "dealId", deal_number AS "dealNumber", kind AS "entryType", signed::text,
           to_char(effective_date, 'YYYY-MM-DD') AS "effectiveDate", reference AS "referenceNo", counterparty,
           CASE WHEN match_posted IS NULL THEN NULL ELSE 'BANK_STATEMENT' END AS basis, to_char(match_posted, 'YYYY-MM-DD') AS "postedDate"
      FROM commission_trust_ledger(${s.trustAccountId}::uuid, ${D}::date)` : await db.$queryRaw<Row[]>`
    SELECT e.id::text, e."transactionId"::text AS "dealId", t."dealNumber", e."entryType"::text AS "entryType",
           (e.amount * e.direction)::text AS signed, to_char(e."effectiveDate", 'YYYY-MM-DD') AS "effectiveDate",
           to_char(e."receivedDate", 'YYYY-MM-DD') AS "receivedDate",
           e."referenceNo", e.counterparty, m.basis::text AS basis, to_char(b."postedDate", 'YYYY-MM-DD') AS "postedDate"
      FROM "TrustLedgerEntry" e
      JOIN "Transaction" t ON t.id = e."transactionId"
      LEFT JOIN "BankMatch" m ON m."trustEntryId" = e.id AND m."matchKind" = 'MONTHLY'
      LEFT JOIN "BankTransaction" b ON b.id = m."bankTransactionId"
     WHERE e."trustAccountId" = ${s.trustAccountId}::uuid AND e."effectiveDate" <= ${D}::date`;

  const lines = await db.$queryRaw<{ id: string; postedDate: string; amount: string; description: string; matchedEntryDate: string | null }[]>`
    SELECT b.id::text, to_char(b."postedDate", 'YYYY-MM-DD') AS "postedDate", b.amount::text, b.description,
           to_char(COALESCE(e."effectiveDate", cr."receivedDate", rv."reversedDate", pe."eventDate"), 'YYYY-MM-DD') AS "matchedEntryDate"
      FROM "BankTransaction" b
      JOIN "BankStatement" s ON s.id = b."statementId"
      LEFT JOIN "BankMatch" m ON m."bankTransactionId" = b.id
      LEFT JOIN "TrustLedgerEntry" e ON e.id = m."trustEntryId"
      LEFT JOIN "CommissionReceipt" cr ON cr.id = m."commissionReceiptId"
      LEFT JOIN "CommissionReceiptReversal" rv ON rv."receiptId" = m."receiptReversalId"
      LEFT JOIN "PayoutEvent" pe ON pe.id = m."payoutEventId"
     WHERE s."trustAccountId" = ${s.trustAccountId}::uuid AND s.kind = 'MONTHLY' AND b."postedDate" <= ${D}::date`;

  const result = reconcile({
    periodEnd: D,
    bankClosingBalance: cents(s.closingBalance),
    entries: entries.map((e): ReconLedgerEntry => ({
      id: e.id, dealId: e.dealId, dealNumber: e.dealNumber, entryType: e.entryType, signedAmount: numericToCents(e.signed),
      effectiveDate: e.effectiveDate, receivedDate: e.receivedDate, referenceNo: e.referenceNo, counterparty: e.counterparty,
      match: e.basis ? { basis: e.basis, postedDate: e.postedDate } : null,
    })),
    bankLines: lines.map((l): ReconBankLine => ({ ...l, amount: numericToCents(l.amount) })),
    calendar: await loadBusinessCalendar(db),
  });
  return { result, trustAccountId: s.trustAccountId, periodEnd: D, receivedDate: s.receivedDate ? iso(s.receivedDate) : null };
}

/** O. Reg. 579/05 s.13: 30 days after the statement is received (or, with no statement, after month end). */
export const statutoryDueBy = (receivedDate: string | null, periodEnd: string) =>
  addDays(receivedDate ?? periodEnd, RECONCILIATION_DUE_DAYS);

/**
 * The date we hold ourselves to: the earlier of s.13 and RECO's guidance that
 * the broker of record signs within 30 days after month end.
 */
export const reconciliationDueBy = (receivedDate: string | null, periodEnd: string) => {
  const statutory = statutoryDueBy(receivedDate, periodEnd);
  const guidance = addDays(periodEnd, RECONCILIATION_DUE_DAYS);
  return statutory < guidance ? statutory : guidance;
};

export interface ReconciliationView {
  id: string;
  trustAccountId: string;
  statementId: string;
  periodEnd: string;
  statementReceived: string | null;
  dueBy: string;
  statutoryDueBy: string;
  status: "PREPARED" | "SIGNED" | "SIGNED_WITH_DISCREPANCY" | "SUPERSEDED";
  /** A correction of an earlier signed reconciliation, and why */
  supersedes: { id: string; reason: string } | null;
  supersededBy: string | null;
  signedOnTime: boolean | null;
  statementVerified: boolean;
  incidents: { id: string; kind: string; open: boolean }[];
  figures: {
    bankClosingBalance: string; outstandingDeposits: string; outstandingDisbursements: string; unrecordedBankItems: string;
    adjustedBankBalance: string; ledgerBalance: string; clientLiabilities: string; difference: string;
  };
  isBalanced: boolean;
  details: ReconResult["details"];
  explanation: string | null;
  preparedBy: string;
  preparedAt: string;
  signedBy: string | null;
  signedAt: string | null;
  signatureNote: string | null;
  signSegregationException: boolean;
}

async function reconciliationView(db: Db, id: string): Promise<ReconciliationView> {
  const r = await db.trustReconciliation.findUnique({
    where: { id },
    include: {
      preparedBy: { select: { firstName: true, lastName: true } },
      signedBy: { select: { firstName: true, lastName: true } },
      statement: { select: { receivedDate: true, verification: { select: { statementId: true } } } },
      supersededBy: { select: { id: true, signedAt: true } },
    },
  });
  if (!r) throw new NotFoundError("Reconciliation", id);
  const incidents = await db.$queryRaw<{ id: string; kind: string; open: boolean }[]>`
    SELECT DISTINCT i.id::text, i.kind::text, trust_incident_is_open(i.id) AS open FROM "TrustIncident" i
     WHERE i."reconciliationId" = ${id}::uuid
        OR EXISTS (SELECT 1 FROM "TrustIncidentEvent" e WHERE e."incidentId" = i.id AND e."reconciliationId" = ${id}::uuid)`;
  const received = r.statement.receivedDate ? iso(r.statement.receivedDate) : null;
  const dueBy = reconciliationDueBy(received, iso(r.periodEnd));
  const name = (u: { firstName: string; lastName: string } | null) => (u ? `${u.firstName} ${u.lastName}` : null);
  return {
    id: r.id,
    trustAccountId: r.trustAccountId,
    statementId: r.statementId,
    periodEnd: iso(r.periodEnd),
    statementReceived: received,
    dueBy,
    statutoryDueBy: statutoryDueBy(received, iso(r.periodEnd)),
    status: r.supersededBy?.signedAt ? "SUPERSEDED" : !r.signedAt ? "PREPARED" : r.isBalanced ? "SIGNED" : "SIGNED_WITH_DISCREPANCY",
    supersedes: r.supersedesId ? { id: r.supersedesId, reason: r.amendmentReason! } : null,
    supersededBy: r.supersededBy?.id ?? null,
    signedOnTime: r.signedAt ? todayInToronto(r.signedAt) <= dueBy : null,
    statementVerified: r.statement.verification !== null,
    incidents,
    figures: {
      bankClosingBalance: r.bankClosingBalance.toFixed(2), outstandingDeposits: r.outstandingDeposits.toFixed(2),
      outstandingDisbursements: r.outstandingDisbursements.toFixed(2), unrecordedBankItems: r.unrecordedBankItems.toFixed(2),
      adjustedBankBalance: r.adjustedBankBalance.toFixed(2), ledgerBalance: r.ledgerBalance.toFixed(2),
      clientLiabilities: r.clientLiabilities.toFixed(2), difference: r.difference.toFixed(2),
    },
    isBalanced: r.isBalanced,
    details: r.details as unknown as ReconResult["details"],
    explanation: r.explanation,
    preparedBy: name(r.preparedBy)!,
    preparedAt: r.preparedAt.toISOString(),
    signedBy: name(r.signedBy),
    signedAt: r.signedAt?.toISOString() ?? null,
    signatureNote: r.signatureNote,
    signSegregationException: r.signSegregationException,
  };
}

export async function previewReconciliation(deps: BankDeps, actor: Actor, statementId: string) {
  requireRole(actor, TRUST_VIEWERS, "Viewing a trust reconciliation");
  const { result, periodEnd, receivedDate } = await computeForStatement(deps.prisma, statementId);
  return {
    periodEnd, statementReceived: receivedDate, dueBy: reconciliationDueBy(receivedDate, periodEnd),
    statutoryDueBy: statutoryDueBy(receivedDate, periodEnd), ...result,
  };
}

export async function prepareReconciliation(deps: BankDeps, actor: Actor, body: unknown): Promise<ReconciliationView> {
  requireRole(actor, BANK_STAFF, "Preparing a trust reconciliation");
  const r = new Reader(body, ["statementId", "explanation", "supersedesId", "amendmentReason"]);
  const statementId = r.uuid("statementId");
  const explanation = r.optionalText("explanation", 4000);
  const supersedesId = r.optionalUuid("supersedesId");
  const amendmentReason = r.optionalText("amendmentReason", 2000);
  r.check((supersedesId === null) === (amendmentReason === null), "amendmentReason", "is required with supersedesId (and only then)");
  r.done();

  const published: NotificationView[] = [];
  let id = "";
  try {
    await deps.prisma.$transaction(async (tx) => {
      const { result: x, trustAccountId, periodEnd } = await computeForStatement(tx, statementId);
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "TrustReconciliation" (id, "trustAccountId", "statementId", "periodEnd", "bankClosingBalance", "outstandingDeposits",
          "outstandingDisbursements", "unrecordedBankItems", "adjustedBankBalance", "ledgerBalance", "clientLiabilities", difference,
          "isBalanced", details, explanation, "preparedById", "supersedesId", "amendmentReason")
        VALUES (gen_random_uuid(), ${trustAccountId}::uuid, ${statementId}::uuid, ${periodEnd}::date,
          ${formatCents(x.bankClosingBalance)}::numeric, ${formatCents(x.outstandingDeposits)}::numeric,
          ${formatCents(x.outstandingDisbursements)}::numeric, ${formatCents(x.unrecordedBankItems)}::numeric,
          ${formatCents(x.adjustedBankBalance)}::numeric, ${formatCents(x.ledgerBalance)}::numeric,
          ${formatCents(x.clientLiabilities)}::numeric, ${formatCents(x.difference)}::numeric, ${x.isBalanced},
          ${JSON.stringify(x.details)}::jsonb, ${explanation}, ${actor.id}::uuid, ${supersedesId}::uuid, ${amendmentReason})
        RETURNING id::text`;
      id = row!.id;
      const today = deps.today?.() ?? todayInToronto();
      const overdrawn = -x.details.shortfalls.reduce((s, d) => s + d.balance, 0);
      const shortfall = Math.max(x.difference < 0 ? -x.difference : 0, overdrawn);
      if (shortfall > 0) {
        await recordIncident(tx, actor, trustAccountId, "SHORTFALL", shortfall, id, today,
          `Trust shortfall of $${formatCents(shortfall)} at ${periodEnd}: ${x.details.exceptions.slice(0, 3).join(" · ")}`);
        published.push(...await insertNotifications(tx, {
          userIds: await brokers(tx),
          type: "TRUST_SHORTFALL",
          title: `Trust shortfall of $${formatCents(shortfall)} at ${periodEnd}: notify RECO and replenish immediately`,
          body: "O. Reg. 579/05 s.14 requires the brokerage to notify the registrar immediately and deposit enough to eliminate the " +
            "shortfall. The only exception (RECO Bulletin 8.2): a shortfall caused solely by bank service fees and made good as soon " +
            "as it is found. The broker of record records the cause on the trust incident. " + x.details.exceptions.slice(0, 3).join(" · "),
          dealId: null,
          slotId: null,
        }));
      } else if (x.details.exceptions.length > 0) {
        await recordIncident(tx, actor, trustAccountId, "DISCREPANCY", Math.abs(x.difference), id, today,
          `Reconciliation exceptions at ${periodEnd}: ${x.details.exceptions.slice(0, 3).join(" · ")}`);
        published.push(...await insertNotifications(tx, {
          userIds: await brokers(tx),
          type: "TRUST_RECONCILIATION_EXCEPTION",
          title: `Trust reconciliation to ${periodEnd} has exceptions`,
          body: x.details.exceptions.slice(0, 5).join(" · "),
          dealId: null,
          slotId: null,
        }));
      }
    });
  } catch (err) {
    rethrow(err);
  }
  for (const n of published) deps.hub.publish(n);
  return reconciliationView(deps.prisma, id);
}

export async function signReconciliation(deps: BankDeps, actor: Actor, reconciliationId: string, body: unknown): Promise<ReconciliationView> {
  requireRole(actor, TRUST_AUTHORIZERS, "Signing a trust reconciliation");
  const r = new Reader(body ?? {}, ["note", "exceptionReason"]);
  const note = r.optionalText("note", 2000);
  const exceptionReason = r.optionalText("exceptionReason", 500);
  r.done();
  const current = await reconciliationView(deps.prisma, reconciliationId);
  if (current.status !== "PREPARED") throw new ConflictError("RECONCILIATION_ALREADY_SIGNED", "This reconciliation is already signed");
  const [{ newer }] = await deps.prisma.$queryRaw<{ newer: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "TrustReconciliation" n JOIN "TrustReconciliation" r ON r.id = ${reconciliationId}::uuid
                    WHERE n."statementId" = r."statementId" AND n."preparedAt" > r."preparedAt") AS newer`;
  if (newer) {
    throw new RuleViolationError("RECONCILIATION_SUPERSEDED", "A newer reconciliation was prepared for this statement; sign that one");
  }
  if (current.details.exceptions.length > 0 && !current.explanation) {
    throw new RuleViolationError(
      "RECONCILIATION_NEEDS_EXPLANATION",
      "This reconciliation has exceptions. Prepare it again with an explanation of each one (what was found and what's being done) before signing. " +
        "Signing doesn't resolve them: shortfalls stay open on the trust incident until reported and replenished.",
      { exceptions: current.details.exceptions },
    );
  }
  try {
    await deps.prisma.$executeRaw`
      UPDATE "TrustReconciliation" SET "signedById" = ${actor.id}::uuid, "signedAt" = clock_timestamp(), "signatureNote" = ${note},
             "signExceptionReason" = ${exceptionReason}
       WHERE id = ${reconciliationId}::uuid`;
  } catch (err) {
    rethrow(err);
  }
  return reconciliationView(deps.prisma, reconciliationId);
}

export async function getReconciliation(deps: BankDeps, actor: Actor, id: string) {
  requireRole(actor, TRUST_VIEWERS, "Viewing a trust reconciliation");
  return reconciliationView(deps.prisma, id);
}

export interface AccountReconStatus {
  trustAccountId: string;
  name: string;
  kind: "REAL_ESTATE_TRUST" | "COMMISSION_TRUST";
  lastStatementEnd: string | null;
  lastSignedPeriodEnd: string | null;
  awaitingSignature: { periodEnd: string; received: string | null; dueBy: string; overdue: boolean }[];
  missingStatements: { month: string; dueBy: string; overdue: boolean }[]; // months ended with no statement imported
  openIncidents: { id: string; kind: "SHORTFALL" | "DISCREPANCY"; amount: string; detectedAt: string }[];
}

const monthEnd = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
};
const nextMonth = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, "0")}`;
};

/** Per trust account: last statement, last signed month, months to sign, months with no statement, open incidents. */
export async function reconciliationStatus(db: Db, today: string): Promise<AccountReconStatus[]> {
  const rows = await db.$queryRaw<{
    id: string; name: string; kind: "REAL_ESTATE_TRUST" | "COMMISSION_TRUST"; periodEnd: string | null; received: string | null; signed: boolean | null;
  }[]>`
    SELECT a.id::text, a.name, a.kind::text AS kind, to_char(s."periodEnd", 'YYYY-MM-DD') AS "periodEnd",
           to_char(s."receivedDate", 'YYYY-MM-DD') AS received,
           EXISTS (SELECT 1 FROM "TrustReconciliation" r WHERE r."statementId" = s.id AND r."signedAt" IS NOT NULL) AS signed
      FROM "TrustAccount" a LEFT JOIN "BankStatement" s ON s."trustAccountId" = a.id AND s.kind = 'MONTHLY'
     WHERE a."isActive"
     ORDER BY a.name, s."periodEnd"`;
  const incidents = await db.$queryRaw<{ id: string; trustAccountId: string; kind: "SHORTFALL" | "DISCREPANCY"; amount: string; detectedAt: string }[]>`
    SELECT i.id::text, i."trustAccountId"::text, i.kind::text AS kind, i.amount::text,
           to_char(i."detectedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "detectedAt"
      FROM "TrustIncident" i WHERE trust_incident_is_open(i.id) ORDER BY i."detectedAt"`;
  const out = new Map<string, AccountReconStatus>();
  for (const row of rows) {
    const a = out.get(row.id) ?? {
      trustAccountId: row.id, name: row.name, kind: row.kind, lastStatementEnd: null, lastSignedPeriodEnd: null,
      awaitingSignature: [], missingStatements: [],
      openIncidents: incidents.filter((i) => i.trustAccountId === row.id).map(({ trustAccountId: _, ...i }) => i),
    };
    if (row.periodEnd) {
      a.lastStatementEnd = row.periodEnd;
      if (row.signed) a.lastSignedPeriodEnd = row.periodEnd;
      else {
        const dueBy = reconciliationDueBy(row.received, row.periodEnd);
        a.awaitingSignature.push({ periodEnd: row.periodEnd, received: row.received, dueBy, overdue: dueBy < today });
      }
    }
    out.set(row.id, a);
  }
  // Months that have ended since the last statement, with no statement imported yet
  for (const a of out.values()) {
    if (!a.lastStatementEnd) continue;
    for (let m = nextMonth(a.lastStatementEnd.slice(0, 7)); monthEnd(m) < today; m = nextMonth(m)) {
      const dueBy = reconciliationDueBy(null, monthEnd(m));
      a.missingStatements.push({ month: m, dueBy, overdue: dueBy < today });
    }
  }
  return [...out.values()];
}

// ── Trust incidents (O. Reg. 579/05 s.14) ────────────────────────────────────

/** Opens an incident, or adds this observation to the one already open for the account. */
async function recordIncident(
  tx: Prisma.TransactionClient, actor: Actor, trustAccountId: string, kind: "SHORTFALL" | "DISCREPANCY",
  amount: Cents, reconciliationId: string, today: string, summary: string,
): Promise<string> {
  const [open] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM "TrustIncident"
     WHERE "trustAccountId" = ${trustAccountId}::uuid AND kind = ${kind}::"TrustIncidentKind" AND trust_incident_is_open(id)
     ORDER BY "detectedAt" LIMIT 1`;
  let id = open?.id;
  if (!id) {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "TrustIncident" (id, "trustAccountId", kind, summary, amount, "reconciliationId", "detectedById")
      VALUES (gen_random_uuid(), ${trustAccountId}::uuid, ${kind}::"TrustIncidentKind", ${summary}, ${formatCents(amount)}::numeric,
              ${reconciliationId}::uuid, ${actor.id}::uuid)
      RETURNING id::text`;
    id = row!.id;
  }
  await tx.$executeRaw`
    INSERT INTO "TrustIncidentEvent" (id, "incidentId", kind, "eventDate", amount, note, "reconciliationId", "actorId")
    VALUES (gen_random_uuid(), ${id}::uuid, 'OBSERVED', ${today}::date, ${formatCents(amount)}::numeric, ${summary},
            ${reconciliationId}::uuid, ${actor.id}::uuid)`;
  return id;
}

export interface IncidentView {
  id: string;
  trustAccountId: string;
  kind: "SHORTFALL" | "DISCREPANCY";
  summary: string;
  amount: string;
  detectedAt: string;
  open: boolean;
  registrarNotified: boolean;
  replenished: string;
  /** BANK_SERVICE_FEE, OTHER, or null until the broker of record determines it */
  cause: "BANK_SERVICE_FEE" | "OTHER" | null;
  /** RECO Bulletin 8.2: no registrar notice if solely bank service fees and replenished by the day after discovery */
  serviceFeeException: { feesIdentified: string; replenishBy: string; available: boolean } | null;
  /** What the s.14 process still needs, in order */
  outstanding: string[];
  events: {
    kind: string; eventDate: string; amount: string | null; reference: string | null; note: string | null; cause: string | null;
    bankTransactionId: string | null; by: string; at: string;
  }[];
}

async function incidentView(db: Db, id: string): Promise<IncidentView> {
  const i = await db.trustIncident.findUnique({
    where: { id },
    include: {
      events: {
        orderBy: { createdAt: "asc" },
        include: { actor: { select: { firstName: true, lastName: true } }, bankTransaction: { select: { amount: true } } },
      },
    },
  });
  if (!i) throw new NotFoundError("Trust incident", id);
  const open = !i.events.some((e) => e.kind === "RESOLVED");
  const notified = i.events.some((e) => e.kind === "REGISTRAR_NOTIFIED");
  const replenished = i.events.filter((e) => e.kind === "REPLENISHED").reduce((s, e) => s + cents(e.amount!), 0);
  const worst = Math.max(cents(i.amount), ...i.events.filter((e) => e.kind === "OBSERVED" && e.amount).map((e) => cents(e.amount!)));
  const causes = i.events.filter((e) => e.kind === "CAUSE_DETERMINED");
  const cause = causes.some((e) => e.cause === "OTHER") ? "OTHER" : causes.length ? "BANK_SERVICE_FEE" : null;
  const fees = cause === "BANK_SERVICE_FEE" ? -causes.reduce((s, e) => s + cents(e.bankTransaction!.amount), 0) : 0;
  const replenishBy = addDays(todayInToronto(i.detectedAt), 1);
  let running = 0;
  const coveredOn = i.events.filter((e) => e.kind === "REPLENISHED")
    .sort((a, b) => iso(a.eventDate).localeCompare(iso(b.eventDate)))
    .find((e) => (running += cents(e.amount!)) >= worst);
  const feeExceptionAvailable = cause === "BANK_SERVICE_FEE" && fees >= worst && (coveredOn ? iso(coveredOn.eventDate) <= replenishBy : true);
  const outstanding: string[] = [];
  if (open && i.kind === "SHORTFALL") {
    if (!notified && !feeExceptionAvailable) outstanding.push("Notify the RECO registrar immediately and record when, how and the reference");
    if (cause === null) {
      outstanding.push("Broker of record: record the cause. Only a shortfall caused solely by bank service fees, made good by " +
        `${replenishBy}, is exempt from notifying RECO (Bulletin 8.2); anything else is reported now`);
    }
    if (replenished < worst) {
      outstanding.push(`Deposit $${formatCents(worst - replenished)} of brokerage funds into the trust account and record the bank reference` +
        (feeExceptionAvailable ? ` by ${replenishBy}, or the service-fee exception lapses and RECO must be notified` : ""));
    }
    if (cause === "BANK_SERVICE_FEE" && fees < worst) {
      outstanding.push(`The bank fees identified ($${formatCents(fees)}) don't account for the whole $${formatCents(worst)}: identify the rest or treat it as reportable`);
    }
    outstanding.push("Resolve once reported and replenished, replenished under the service-fee exception, or shown by a later balanced reconciliation to be a ledger error");
  } else if (open) {
    outstanding.push("Investigate, record what was found, and resolve");
  }
  return {
    id: i.id,
    trustAccountId: i.trustAccountId,
    kind: i.kind,
    summary: i.summary,
    amount: i.amount.toFixed(2),
    detectedAt: i.detectedAt.toISOString(),
    open,
    registrarNotified: notified,
    replenished: formatCents(replenished),
    cause,
    serviceFeeException: i.kind === "SHORTFALL" && cause === "BANK_SERVICE_FEE"
      ? { feesIdentified: formatCents(fees), replenishBy, available: feeExceptionAvailable }
      : null,
    outstanding,
    events: i.events.map((e) => ({
      kind: e.kind, eventDate: iso(e.eventDate), amount: e.amount?.toFixed(2) ?? null, reference: e.reference, note: e.note,
      cause: e.cause, bankTransactionId: e.bankTransactionId, by: `${e.actor.firstName} ${e.actor.lastName}`, at: e.createdAt.toISOString(),
    })),
  };
}

export async function listIncidents(deps: BankDeps, actor: Actor, openOnly: boolean): Promise<IncidentView[]> {
  requireRole(actor, TRUST_VIEWERS, "Viewing trust incidents");
  const ids = await deps.prisma.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM "TrustIncident" WHERE (${!openOnly} OR trust_incident_is_open(id)) ORDER BY "detectedAt" DESC LIMIT 200`;
  return Promise.all(ids.map((r) => incidentView(deps.prisma, r.id)));
}

export async function getIncident(deps: BankDeps, actor: Actor, id: string) {
  requireRole(actor, TRUST_VIEWERS, "Viewing a trust incident");
  return incidentView(deps.prisma, id);
}

/** Records what was done: a note, the registrar notification, a replenishment, or the resolution. Never sends or moves anything. */
export async function addIncidentEvent(deps: BankDeps, actor: Actor, incidentId: string, body: unknown): Promise<IncidentView> {
  requireRole(actor, BANK_STAFF, "Updating a trust incident");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body, ["kind", "eventDate", "amount", "reference", "note", "reconciliationId", "bankTransactionId", "cause"]);
  const input = {
    kind: r.oneOf("kind", ["NOTE", "REGISTRAR_NOTIFIED", "REPLENISHED", "RESOLVED", "CAUSE_DETERMINED"] as const),
    cause: r.has("cause") ? r.oneOf("cause", ["BANK_SERVICE_FEE", "OTHER"] as const) : null,
    eventDate: r.has("eventDate") ? r.pastDate("eventDate", today) : today,
    amount: r.has("amount") ? r.amount("amount") : null,
    reference: r.optionalText("reference", 200),
    note: r.optionalText("note", 4000),
    reconciliationId: r.optionalUuid("reconciliationId"),
    bankTransactionId: r.optionalUuid("bankTransactionId"),
  };
  r.check(input.kind !== "REPLENISHED" || input.amount !== null, "amount", "is required for a replenishment");
  r.check(!["REGISTRAR_NOTIFIED", "REPLENISHED"].includes(input.kind) || input.reference !== null, "reference", "is required as evidence");
  r.check(!["NOTE", "RESOLVED", "CAUSE_DETERMINED"].includes(input.kind) || input.note !== null, "note", "is required");
  r.check((input.kind === "CAUSE_DETERMINED") === (input.cause !== null), "cause", "is given with CAUSE_DETERMINED, and only then");
  r.check(input.cause !== "BANK_SERVICE_FEE" || input.bankTransactionId !== null, "bankTransactionId", "the bank line showing the fee is required");
  r.done();
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO "TrustIncidentEvent" (id, "incidentId", kind, "eventDate", amount, reference, note, "reconciliationId", "bankTransactionId",
                                        "actorId", cause)
      VALUES (gen_random_uuid(), ${incidentId}::uuid, ${input.kind}::"TrustIncidentEventKind", ${input.eventDate}::date,
              ${input.amount === null ? null : formatCents(input.amount)}::numeric, ${input.reference}, ${input.note},
              ${input.reconciliationId}::uuid, ${input.bankTransactionId}::uuid, ${actor.id}::uuid, ${input.cause})`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23503") throw new NotFoundError("Trust incident", incidentId);
    rethrow(err);
  }
  return incidentView(deps.prisma, incidentId);
}
