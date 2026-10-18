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
  account: { type: "TRUST" | "OPERATING"; id: string };
  periodStart: string;
  periodEnd: string;
  openingBalance: string;
  closingBalance: string;
  fileName: string;
  lines: {
    id: string;
    lineNumber: number;
    postedDate: string;
    amount: string;
    description: string;
    reference: string | null;
    match: { id: string; trustEntryId: string | null; commissionReceiptId: string | null; dealNumber: string | null } | null;
  }[];
  matched: number;
  unmatched: number;
}

interface Candidate {
  id: string;
  signed: Cents;
  date: string;
  reference: string | null;
}

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

async function autoMatch(tx: Prisma.TransactionClient, actor: Actor, statementId: string): Promise<number> {
  const stmt = await tx.bankStatement.findUniqueOrThrow({ where: { id: statementId }, include: { lines: { include: { match: true } } } });
  const lines = stmt.lines.filter((l) => !l.match).map((l) => ({
    id: l.id, postedDate: iso(l.postedDate), amount: cents(l.amount), text: `${l.reference ?? ""} ${l.description}`,
  }));
  if (lines.length === 0) return 0;
  const from = addDays(iso(stmt.periodStart), -60);
  const to = addDays(iso(stmt.periodEnd), 5);

  let candidates: Candidate[];
  if (stmt.trustAccountId) {
    const rows = await tx.$queryRaw<{ id: string; signed: string; date: string; reference: string | null }[]>`
      SELECT e.id::text, (e.amount * e.direction)::text AS signed, to_char(e."effectiveDate", 'YYYY-MM-DD') AS date, e."referenceNo" AS reference
        FROM "TrustLedgerEntry" e
       WHERE e."trustAccountId" = ${stmt.trustAccountId}::uuid
         AND e."effectiveDate" BETWEEN ${from}::date AND ${to}::date
         AND NOT EXISTS (SELECT 1 FROM "BankMatch" m WHERE m."trustEntryId" = e.id)`;
    candidates = rows.map((r) => ({ ...r, signed: numericToCents(r.signed) }));
  } else {
    const rows = await tx.$queryRaw<{ id: string; amount: string; date: string; reference: string }[]>`
      SELECT r.id::text, r.amount::text, to_char(r."receivedDate", 'YYYY-MM-DD') AS date, r.reference
        FROM "CommissionReceipt" r
       WHERE r."receivedDate" BETWEEN ${from}::date AND ${to}::date
         AND NOT EXISTS (SELECT 1 FROM "BankMatch" m WHERE m."commissionReceiptId" = r.id)`;
    candidates = rows.map((r) => ({ id: r.id, signed: numericToCents(r.amount), date: r.date, reference: r.reference }));
  }

  const proposals = proposeMatches(lines, candidates);
  for (const [lineId, targetId] of proposals) {
    await tx.$executeRaw`
      INSERT INTO "BankMatch" (id, basis, "bankTransactionId", "trustEntryId", "commissionReceiptId", note, "matchedById")
      VALUES (gen_random_uuid(), 'BANK_STATEMENT', ${lineId}::uuid,
              ${stmt.trustAccountId ? targetId : null}::uuid, ${stmt.trustAccountId ? null : targetId}::uuid,
              'Matched automatically on import', ${actor.id}::uuid)`;
  }
  return proposals.size;
}

export async function importStatement(deps: BankDeps, actor: Actor, body: unknown): Promise<StatementView & { autoMatched: number }> {
  requireRole(actor, BANK_STAFF, "Importing a bank statement");
  const today = deps.today?.() ?? todayInToronto();
  const r = new Reader(body, [
    "accountType", "accountId", "periodStart", "periodEnd", "openingBalance", "closingBalance", "fileName", "csv", "dateOrder", "autoMatch",
  ]);
  const input = {
    accountType: r.oneOf("accountType", ["TRUST", "OPERATING"] as const),
    accountId: r.uuid("accountId"),
    periodStart: r.date("periodStart"),
    periodEnd: r.pastDate("periodEnd", today),
    openingBalance: signedMoney(r, "openingBalance"),
    closingBalance: signedMoney(r, "closingBalance"),
    fileName: r.text("fileName", 255),
    csv: r.text("csv", 5_000_000),
    dateOrder: (r.has("dateOrder") ? r.oneOf("dateOrder", ["MDY", "DMY", "YMD"] as const) : "MDY") as DateOrder,
    autoMatch: r.has("autoMatch") ? r.bool("autoMatch") : true,
  };
  if (input.periodStart && input.periodEnd) r.check(input.periodEnd >= input.periodStart, "periodEnd", "cannot be before periodStart");
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
  const total = lines.reduce((s, l) => s + l.amount, 0);
  if (input.openingBalance + total !== input.closingBalance) {
    issues.push(`opening ${formatCents(input.openingBalance)} + transactions ${formatCents(total)} = ${formatCents(input.openingBalance + total)}, but the statement closes at ${formatCents(input.closingBalance)}`);
  }
  const running = checkRunningBalance(lines, input.openingBalance);
  if (running) issues.push(running);
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

  let statementId = "";
  let autoMatched = 0;
  const published: NotificationView[] = [];
  try {
    await deps.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "BankStatement" (id, "trustAccountId", "operatingAccountId", "periodStart", "periodEnd", "openingBalance",
                                     "closingBalance", "fileName", "fileSha256", "importedById")
        VALUES (gen_random_uuid(), ${trustAccountId}::uuid, ${operatingAccountId}::uuid, ${input.periodStart}::date, ${input.periodEnd}::date,
                ${formatCents(input.openingBalance)}::numeric, ${formatCents(input.closingBalance)}::numeric, ${input.fileName}, ${sha},
                ${actor.id}::uuid)
        RETURNING id::text`;
      statementId = row!.id;
      for (const l of lines) {
        await tx.$executeRaw`
          INSERT INTO "BankTransaction" (id, "statementId", "lineNumber", "postedDate", amount, description, reference)
          VALUES (gen_random_uuid(), ${statementId}::uuid, ${l.lineNumber}, ${l.postedDate}::date, ${formatCents(l.amount)}::numeric,
                  ${l.description}, ${l.reference})`;
      }
      if (input.autoMatch) autoMatched = await autoMatch(tx, actor, statementId);

      // Money moved in the trust account that the ledger doesn't explain: tell the brokers now
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
            body: `The ${input.periodEnd} statement for ${account.name} shows $${unmatchedOut[0]!.total.replace("-", "")} leaving trust ` +
              "with no matching ledger entry. Check for returned deposits, bank fees or unrecorded payments before releasing funds.",
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
  return { ...(await getStatement(deps, actor, statementId)), autoMatched };
}

export async function getStatement(deps: BankDeps, actor: Actor, statementId: string): Promise<StatementView> {
  requireRole(actor, TRUST_VIEWERS, "Viewing a bank statement");
  const s = await deps.prisma.bankStatement.findUnique({
    where: { id: statementId },
    include: {
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
          dealNumber: l.match.trustEntry?.transaction.dealNumber ?? null }
      : null,
  }));
  return {
    id: s.id,
    account: s.trustAccountId ? { type: "TRUST", id: s.trustAccountId } : { type: "OPERATING", id: s.operatingAccountId! },
    periodStart: iso(s.periodStart),
    periodEnd: iso(s.periodEnd),
    openingBalance: s.openingBalance.toFixed(2),
    closingBalance: s.closingBalance.toFixed(2),
    fileName: s.fileName,
    lines,
    matched: lines.filter((l) => l.match).length,
    unmatched: lines.filter((l) => !l.match).length,
  };
}

// ── Matching ─────────────────────────────────────────────────────────────────

export async function matchLine(deps: BankDeps, actor: Actor, body: unknown) {
  requireRole(actor, BANK_STAFF, "Matching a bank transaction");
  const r = new Reader(body, ["bankTransactionId", "trustEntryId", "commissionReceiptId", "note"]);
  const input = {
    bankTransactionId: r.uuid("bankTransactionId"),
    trustEntryId: r.optionalUuid("trustEntryId"),
    commissionReceiptId: r.optionalUuid("commissionReceiptId"),
    note: r.optionalText("note", 500),
  };
  r.check((input.trustEntryId === null) !== (input.commissionReceiptId === null), "trustEntryId", "give exactly one of trustEntryId or commissionReceiptId");
  r.done();
  try {
    const [row] = await deps.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "BankMatch" (id, basis, "bankTransactionId", "trustEntryId", "commissionReceiptId", note, "matchedById")
      VALUES (gen_random_uuid(), 'BANK_STATEMENT', ${input.bankTransactionId}::uuid, ${input.trustEntryId}::uuid,
              ${input.commissionReceiptId}::uuid, ${input.note}, ${actor.id}::uuid)
      RETURNING id::text`;
    return { matchId: row!.id };
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

/** History from before the first imported statement (e.g. migrated from Lone Wolf), attested by a broker. */
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
          ON CONFLICT ("trustEntryId") DO NOTHING`;
      }
    });
  } catch (err) {
    rethrow(err);
  }
  return { attested: ids.length };
}

// ── Reconciliation ───────────────────────────────────────────────────────────

export async function computeForStatement(db: Db, statementId: string): Promise<{ result: ReconResult; trustAccountId: string; periodEnd: string }> {
  const s = await db.bankStatement.findUnique({ where: { id: statementId } });
  if (!s || !s.trustAccountId) throw new NotFoundError("Trust account statement", statementId);
  const D = iso(s.periodEnd);

  const entries = await db.$queryRaw<{
    id: string; dealId: string; dealNumber: string; entryType: string; signed: string; effectiveDate: string;
    referenceNo: string | null; counterparty: string | null; basis: "BANK_STATEMENT" | "PRE_CUTOVER" | null; postedDate: string | null;
  }[]>`
    SELECT e.id::text, e."transactionId"::text AS "dealId", t."dealNumber", e."entryType"::text AS "entryType",
           (e.amount * e.direction)::text AS signed, to_char(e."effectiveDate", 'YYYY-MM-DD') AS "effectiveDate",
           e."referenceNo", e.counterparty, m.basis::text AS basis, to_char(b."postedDate", 'YYYY-MM-DD') AS "postedDate"
      FROM "TrustLedgerEntry" e
      JOIN "Transaction" t ON t.id = e."transactionId"
      LEFT JOIN "BankMatch" m ON m."trustEntryId" = e.id
      LEFT JOIN "BankTransaction" b ON b.id = m."bankTransactionId"
     WHERE e."trustAccountId" = ${s.trustAccountId}::uuid AND e."effectiveDate" <= ${D}::date`;

  const lines = await db.$queryRaw<{ id: string; postedDate: string; amount: string; description: string; matchedEntryDate: string | null }[]>`
    SELECT b.id::text, to_char(b."postedDate", 'YYYY-MM-DD') AS "postedDate", b.amount::text, b.description,
           to_char(e."effectiveDate", 'YYYY-MM-DD') AS "matchedEntryDate"
      FROM "BankTransaction" b
      JOIN "BankStatement" s ON s.id = b."statementId"
      LEFT JOIN "BankMatch" m ON m."bankTransactionId" = b.id
      LEFT JOIN "TrustLedgerEntry" e ON e.id = m."trustEntryId"
     WHERE s."trustAccountId" = ${s.trustAccountId}::uuid AND b."postedDate" <= ${D}::date`;

  const result = reconcile({
    periodEnd: D,
    bankClosingBalance: cents(s.closingBalance),
    entries: entries.map((e): ReconLedgerEntry => ({
      id: e.id, dealId: e.dealId, dealNumber: e.dealNumber, entryType: e.entryType, signedAmount: numericToCents(e.signed),
      effectiveDate: e.effectiveDate, referenceNo: e.referenceNo, counterparty: e.counterparty,
      match: e.basis ? { basis: e.basis, postedDate: e.postedDate } : null,
    })),
    bankLines: lines.map((l): ReconBankLine => ({ ...l, amount: numericToCents(l.amount) })),
  });
  return { result, trustAccountId: s.trustAccountId, periodEnd: D };
}

export interface ReconciliationView {
  id: string;
  trustAccountId: string;
  statementId: string;
  periodEnd: string;
  dueBy: string;
  status: "PREPARED" | "SIGNED";
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
}

async function reconciliationView(db: Db, id: string): Promise<ReconciliationView> {
  const r = await db.trustReconciliation.findUnique({
    where: { id },
    include: { preparedBy: { select: { firstName: true, lastName: true } }, signedBy: { select: { firstName: true, lastName: true } } },
  });
  if (!r) throw new NotFoundError("Reconciliation", id);
  const name = (u: { firstName: string; lastName: string } | null) => (u ? `${u.firstName} ${u.lastName}` : null);
  return {
    id: r.id,
    trustAccountId: r.trustAccountId,
    statementId: r.statementId,
    periodEnd: iso(r.periodEnd),
    dueBy: addDays(iso(r.periodEnd), RECONCILIATION_DUE_DAYS),
    status: r.signedAt ? "SIGNED" : "PREPARED",
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
  };
}

export async function previewReconciliation(deps: BankDeps, actor: Actor, statementId: string) {
  requireRole(actor, TRUST_VIEWERS, "Viewing a trust reconciliation");
  const { result, periodEnd } = await computeForStatement(deps.prisma, statementId);
  return { periodEnd, dueBy: addDays(periodEnd, RECONCILIATION_DUE_DAYS), ...result };
}

export async function prepareReconciliation(deps: BankDeps, actor: Actor, body: unknown): Promise<ReconciliationView> {
  requireRole(actor, BANK_STAFF, "Preparing a trust reconciliation");
  const r = new Reader(body, ["statementId", "explanation"]);
  const statementId = r.uuid("statementId");
  const explanation = r.optionalText("explanation", 4000);
  r.done();

  const published: NotificationView[] = [];
  let id = "";
  try {
    await deps.prisma.$transaction(async (tx) => {
      const { result: x, trustAccountId, periodEnd } = await computeForStatement(tx, statementId);
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "TrustReconciliation" (id, "trustAccountId", "statementId", "periodEnd", "bankClosingBalance", "outstandingDeposits",
          "outstandingDisbursements", "unrecordedBankItems", "adjustedBankBalance", "ledgerBalance", "clientLiabilities", difference,
          "isBalanced", details, explanation, "preparedById")
        VALUES (gen_random_uuid(), ${trustAccountId}::uuid, ${statementId}::uuid, ${periodEnd}::date,
          ${formatCents(x.bankClosingBalance)}::numeric, ${formatCents(x.outstandingDeposits)}::numeric,
          ${formatCents(x.outstandingDisbursements)}::numeric, ${formatCents(x.unrecordedBankItems)}::numeric,
          ${formatCents(x.adjustedBankBalance)}::numeric, ${formatCents(x.ledgerBalance)}::numeric,
          ${formatCents(x.clientLiabilities)}::numeric, ${formatCents(x.difference)}::numeric, ${x.isBalanced},
          ${JSON.stringify(x.details)}::jsonb, ${explanation}, ${actor.id}::uuid)
        RETURNING id::text`;
      id = row!.id;
      if (!x.isBalanced || x.details.staleDeposits.length > 0) {
        published.push(...await insertNotifications(tx, {
          userIds: await brokers(tx),
          type: x.isBalanced ? "TRUST_RECONCILIATION_EXCEPTION" : "TRUST_SHORTFALL",
          title: x.isBalanced ? `Trust reconciliation to ${periodEnd} has exceptions` : `Trust account doesn't reconcile at ${periodEnd}`,
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
  const r = new Reader(body ?? {}, ["note"]);
  const note = r.optionalText("note", 2000);
  r.done();
  const current = await reconciliationView(deps.prisma, reconciliationId);
  if (current.status === "SIGNED") throw new ConflictError("RECONCILIATION_ALREADY_SIGNED", "This reconciliation is already signed");
  const [{ newer }] = await deps.prisma.$queryRaw<{ newer: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM "TrustReconciliation" n JOIN "TrustReconciliation" r ON r.id = ${reconciliationId}::uuid
                    WHERE n."statementId" = r."statementId" AND n."preparedAt" > r."preparedAt") AS newer`;
  if (newer) {
    throw new RuleViolationError("RECONCILIATION_SUPERSEDED", "A newer reconciliation was prepared for this statement; sign that one");
  }
  if (current.details.exceptions.length > 0 && !current.explanation) {
    throw new RuleViolationError(
      "RECONCILIATION_NEEDS_EXPLANATION",
      "This reconciliation has exceptions. Prepare it again with an explanation of each one (and how it was resolved) before signing.",
      { exceptions: current.details.exceptions },
    );
  }
  try {
    await deps.prisma.$executeRaw`
      UPDATE "TrustReconciliation" SET "signedById" = ${actor.id}::uuid, "signedAt" = clock_timestamp(), "signatureNote" = ${note}
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
  lastStatementEnd: string | null;
  lastSignedPeriodEnd: string | null;
  awaitingSignature: { periodEnd: string; dueBy: string; overdue: boolean }[];
}

/** Per trust account: last statement, last signed month, and months still to sign. */
export async function reconciliationStatus(db: Db, today: string): Promise<AccountReconStatus[]> {
  const rows = await db.$queryRaw<{ id: string; name: string; periodEnd: string | null; signed: boolean | null }[]>`
    SELECT a.id::text, a.name, to_char(s."periodEnd", 'YYYY-MM-DD') AS "periodEnd",
           EXISTS (SELECT 1 FROM "TrustReconciliation" r WHERE r."statementId" = s.id AND r."signedAt" IS NOT NULL) AS signed
      FROM "TrustAccount" a LEFT JOIN "BankStatement" s ON s."trustAccountId" = a.id
     WHERE a."isActive"
     ORDER BY a.name, s."periodEnd"`;
  const out = new Map<string, AccountReconStatus>();
  for (const row of rows) {
    const a = out.get(row.id) ?? { trustAccountId: row.id, name: row.name, lastStatementEnd: null, lastSignedPeriodEnd: null, awaitingSignature: [] };
    if (row.periodEnd) {
      a.lastStatementEnd = row.periodEnd;
      if (row.signed) a.lastSignedPeriodEnd = row.periodEnd;
      else {
        const dueBy = addDays(row.periodEnd, RECONCILIATION_DUE_DAYS);
        a.awaitingSignature.push({ periodEnd: row.periodEnd, dueBy, overdue: dueBy < today });
      }
    }
    out.set(row.id, a);
  }
  return [...out.values()];
}
