/**
 * Statutory trust ledger (RECO / TRESA).
 *
 * Every write runs in one database transaction that first locks the deal row
 * (SELECT … FOR UPDATE), so two requests on the same deal are serialized and
 * the balance a check reads is the balance the insert lands on.
 *
 * Ledger rows are only ever INSERTed. Migration 003 makes the database reject
 * UPDATE / DELETE / TRUNCATE and re-checks funds, holds and broker authority
 * in a trigger, so the rules hold even if this code is bypassed.
 */

import { Prisma, type PrismaClient } from "@prisma/client";
import { requireRole, TRUST_AUTHORIZERS, TRUST_HOLD_FLAGGERS, TRUST_VIEWERS, type Actor } from "../auth.ts";
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  fromDatabaseError,
  InsufficientTrustFundsError,
  NotFoundError,
  RuleViolationError,
  TrustHoldActiveError,
  uniqueViolation,
} from "../errors.ts";
import { businessDaysBetween } from "../lib/dates.ts";
import { loadBusinessCalendar } from "../lib/calendar-store.ts";
import { formatCents, numericToCents, type Cents } from "../lib/money.ts";
import {
  PAYEE_ENTRY_TYPE,
  type DepositInput,
  type DisbursementInput,
  type HoldInput,
  type ReleaseInput,
  type ReversalInput,
} from "./validation.ts";

type Tx = Prisma.TransactionClient;

/** RECO: deposits go into trust within 5 business days of receipt. */
export const DEPOSIT_DEADLINE_BUSINESS_DAYS = 5;
const FIRST_RECEIPT_NUMBER = 1000;

export interface LedgerEntry {
  id: string;
  dealId: string;
  trustAccountId: string;
  entryType: string;
  direction: number;
  amount: string;
  method: string;
  referenceNo: string | null;
  receiptNumber: number | null;
  counterparty: string;
  receivedDate: string | null;
  effectiveDate: string;
  authorizationMethod: string | null;
  authorizationReference: string | null;
  memo: string | null;
  reversesEntryId: string | null;
  idempotencyKey: string;
  enteredById: string;
  authorizedById: string;
  createdAt: string; // UTC, microsecond precision
}

export interface TrustHold {
  id: string;
  dealId: string;
  depositEntryId: string | null;
  reason: string;
  note: string;
  flaggedById: string;
  flaggedAt: string;
  releasedById: string | null;
  releasedAt: string | null;
  releaseNote: string | null;
  active: boolean;
}

export interface LedgerWriteResult {
  entry: LedgerEntry;
  dealBalance: string;
  warnings: string[];
  replayed: boolean;
}

// Timestamps are formatted in SQL so microseconds survive (a JS Date keeps milliseconds only)
const ENTRY_COLUMNS = Prisma.sql`
  e.id, e."transactionId" AS "dealId", e."trustAccountId", e."entryType"::text AS "entryType", e.direction::int AS direction,
  e.amount::text AS amount, e.method::text AS method, e."referenceNo", e."receiptNumber", e.counterparty,
  to_char(e."receivedDate", 'YYYY-MM-DD') AS "receivedDate",
  to_char(e."effectiveDate", 'YYYY-MM-DD') AS "effectiveDate",
  e."authorizationMethod"::text AS "authorizationMethod", e."authorizationReference", e.memo,
  e."reversesEntryId", e."idempotencyKey", e."enteredById", e."authorizedById",
  to_char(e."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt"`;

const HOLD_COLUMNS = Prisma.sql`
  h.id, h."transactionId" AS "dealId", h."depositEntryId", h.reason::text AS reason, h.note, h."flaggedById",
  to_char(h."flaggedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "flaggedAt",
  h."releasedById",
  to_char(h."releasedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "releasedAt",
  h."releaseNote", (h."releasedAt" IS NULL) AS active`;

interface LockedDeal {
  id: string;
  dealNumber: string;
  status: string;
  trustDepositHolder: string;
  depositAmount: string;
  depositStatus: string;
}

// ── Building blocks ──────────────────────────────────────────────────────────

async function lockDeal(tx: Tx, dealId: string): Promise<LockedDeal> {
  const rows = await tx.$queryRaw<LockedDeal[]>`
    SELECT id, "dealNumber", status::text AS status, "trustDepositHolder"::text AS "trustDepositHolder",
           "depositAmount"::text AS "depositAmount", "depositStatus"::text AS "depositStatus"
      FROM "Transaction" WHERE id = ${dealId}::uuid
       FOR UPDATE`;
  if (!rows[0]) throw new NotFoundError("Deal", dealId);
  return rows[0];
}

/** `lock` serializes receipt numbering across the whole account. */
async function requireActiveTrustAccount(tx: Tx, accountId: string, lock: boolean): Promise<void> {
  const rows = lock
    ? await tx.$queryRaw<{ isActive: boolean }[]>`
        SELECT "isActive" FROM "TrustAccount" WHERE id = ${accountId}::uuid FOR UPDATE`
    : await tx.$queryRaw<{ isActive: boolean }[]>`
        SELECT "isActive" FROM "TrustAccount" WHERE id = ${accountId}::uuid`;
  if (!rows[0]) throw new NotFoundError("Trust account", accountId);
  if (!rows[0].isActive) {
    throw new RuleViolationError("TRUST_ACCOUNT_INACTIVE", `Trust account ${accountId} is not active`);
  }
}

/** A deal's balance in one trust account. Never mixes deals. */
async function dealBalance(tx: Tx | PrismaClient, dealId: string, accountId: string): Promise<Cents> {
  const rows = await tx.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(amount * direction), 0)::text AS balance
      FROM "TrustLedgerEntry"
     WHERE "transactionId" = ${dealId}::uuid AND "trustAccountId" = ${accountId}::uuid`;
  return numericToCents(rows[0]!.balance);
}

/**
 * TRESA per-deal segregation. Call with the deal row already locked.
 * Throws instead of ever letting the deal's ledger go negative.
 */
export async function assertSufficientDealFunds(
  tx: Tx,
  dealId: string,
  accountId: string,
  amount: Cents,
): Promise<Cents> {
  const available = await dealBalance(tx, dealId, accountId);
  if (amount > available) {
    throw new InsufficientTrustFundsError(dealId, formatCents(available), formatCents(amount));
  }
  return available;
}

async function activeHold(tx: Tx, dealId: string): Promise<{ id: string; reason: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; reason: string }[]>`
    SELECT id, reason::text AS reason FROM "TrustHold"
     WHERE "transactionId" = ${dealId}::uuid AND "releasedAt" IS NULL`;
  return rows[0] ?? null;
}

async function findEntry(db: Tx | PrismaClient, where: Prisma.Sql): Promise<LedgerEntry | null> {
  const rows = await db.$queryRaw<LedgerEntry[]>`SELECT ${ENTRY_COLUMNS} FROM "TrustLedgerEntry" e WHERE ${where}`;
  return rows[0] ?? null;
}

async function setDepositStatus(tx: Tx, dealId: string, status: string, onlyFrom: string[]): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Transaction" SET "depositStatus" = ${status}::"DepositStatus", "updatedAt" = now()
     WHERE id = ${dealId}::uuid AND "depositStatus"::text IN (${Prisma.join(onlyFrom)})`;
}

// ── Idempotent, atomic write wrapper ─────────────────────────────────────────

interface ExpectedWrite {
  entryType: string;
  dealId: string;
  amount: Cents;
  reversesEntryId?: string;
}

function replay(db: PrismaClient, existing: LedgerEntry, expected: ExpectedWrite): Promise<LedgerWriteResult> {
  const same =
    existing.entryType === expected.entryType &&
    existing.dealId === expected.dealId &&
    numericToCents(existing.amount) === expected.amount &&
    (expected.reversesEntryId === undefined || existing.reversesEntryId === expected.reversesEntryId);
  if (!same) {
    throw new ConflictError(
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used for a different trust entry",
      { entryId: existing.id },
    );
  }
  return dealBalance(db, existing.dealId, existing.trustAccountId).then((balance) => ({
    entry: existing,
    dealBalance: formatCents(balance),
    warnings: [],
    replayed: true,
  }));
}

async function writeEntry(
  db: PrismaClient,
  idempotencyKey: string,
  expected: ExpectedWrite,
  work: (tx: Tx) => Promise<{ entry: LedgerEntry; balanceAfter: Cents; warnings: string[] }>,
): Promise<LedgerWriteResult> {
  const existing = await findEntry(db, Prisma.sql`e."idempotencyKey" = ${idempotencyKey}::uuid`);
  if (existing) return replay(db, existing, expected);

  try {
    const result = await db.$transaction(work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 5_000,
      timeout: 15_000,
    });
    return { entry: result.entry, dealBalance: formatCents(result.balanceAfter), warnings: result.warnings, replayed: false };
  } catch (err) {
    if (err instanceof DomainError) throw err;
    const unique = uniqueViolation(err);
    if (unique?.includes("idempotencyKey")) {
      // Same request raced itself; return the one that won
      const winner = await findEntry(db, Prisma.sql`e."idempotencyKey" = ${idempotencyKey}::uuid`);
      if (winner) return replay(db, winner, expected);
    }
    if (unique?.includes("reversesEntryId")) {
      throw new ConflictError("ALREADY_REVERSED", `Entry ${expected.reversesEntryId} has already been reversed`);
    }
    throw fromDatabaseError(err) ?? err;
  }
}

// ── 1. Deposit receipt ───────────────────────────────────────────────────────

export async function recordDeposit(
  db: PrismaClient,
  actor: Actor,
  input: DepositInput,
  idempotencyKey: string,
): Promise<LedgerWriteResult> {
  requireRole(actor, TRUST_AUTHORIZERS, "Receipting trust funds");

  return writeEntry(
    db,
    idempotencyKey,
    { entryType: "DEPOSIT_RECEIVED", dealId: input.dealId, amount: input.amount },
    async (tx) => {
      const deal = await lockDeal(tx, input.dealId);
      if (deal.trustDepositHolder !== "OUR_BROKERAGE") {
        throw new RuleViolationError(
          "DEPOSIT_NOT_HELD_BY_BROKERAGE",
          `Deal ${deal.dealNumber} records the deposit as held by ${deal.trustDepositHolder}; ` +
            "it can't be receipted into our trust account. Update the deal's deposit holder first if that's wrong.",
          { dealId: deal.id, trustDepositHolder: deal.trustDepositHolder },
        );
      }
      if (deal.status === "COLLAPSED" || deal.status === "CANCELLED") {
        throw new RuleViolationError("DEAL_NOT_ACTIVE", `Deal ${deal.dealNumber} is ${deal.status}`);
      }

      await requireActiveTrustAccount(tx, input.trustAccountId, true);
      // Receipt numbers are brokerage-wide, so serialize across all trust accounts: sequential, no gaps, no duplicates
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('trust-receipt-number'))`;
      const [{ next }] = await tx.$queryRaw<{ next: number }[]>`
        SELECT (COALESCE(MAX("receiptNumber"), ${FIRST_RECEIPT_NUMBER - 1}::int) + 1)::int AS next
          FROM "TrustLedgerEntry"`;

      const [entry] = await tx.$queryRaw<LedgerEntry[]>`
        INSERT INTO "TrustLedgerEntry" AS e (
          id, "trustAccountId", "transactionId", "entryType", amount, method, "referenceNo", "receiptNumber",
          counterparty, "receivedDate", "effectiveDate", memo, "idempotencyKey", "enteredById", "authorizedById")
        VALUES (
          gen_random_uuid(), ${input.trustAccountId}::uuid, ${input.dealId}::uuid, 'DEPOSIT_RECEIVED',
          ${formatCents(input.amount)}::numeric, ${input.method}::"PaymentMethod", ${input.bankReference}, ${next}::int,
          ${input.payorName}, ${input.dateReceived}::date, ${input.dateDeposited}::date, ${input.memo},
          ${idempotencyKey}::uuid, ${actor.id}::uuid, ${actor.id}::uuid)
        RETURNING ${ENTRY_COLUMNS}`;

      const balanceAfter = await dealBalance(tx, input.dealId, input.trustAccountId);
      await setDepositStatus(tx, input.dealId, "RECEIVED", ["NOT_DUE", "AWAITING"]);

      const warnings: string[] = [];
      if (businessDaysBetween(input.dateReceived, input.dateDeposited, await loadBusinessCalendar(tx)) > DEPOSIT_DEADLINE_BUSINESS_DAYS) {
        warnings.push("DEPOSITED_AFTER_5_BUSINESS_DAYS");
      }
      if (balanceAfter > numericToCents(deal.depositAmount)) {
        warnings.push("EXCEEDS_EXPECTED_DEPOSIT");
      }
      return { entry: entry!, balanceAfter, warnings };
    },
  );
}

// ── 2 + 3. Disbursement, behind the per-deal segregation check ───────────────

export async function recordDisbursement(
  db: PrismaClient,
  actor: Actor,
  input: DisbursementInput,
  idempotencyKey: string,
): Promise<LedgerWriteResult> {
  requireRole(actor, TRUST_AUTHORIZERS, "Disbursing trust funds");
  const entryType = PAYEE_ENTRY_TYPE[input.payeeType];

  return writeEntry(
    db,
    idempotencyKey,
    { entryType, dealId: input.dealId, amount: input.amount },
    async (tx) => {
      const deal = await lockDeal(tx, input.dealId);
      await requireActiveTrustAccount(tx, input.trustAccountId, false);

      if (input.authorizationMethod === "CLOSING_COMPLETED" && deal.status !== "CLOSED") {
        throw new RuleViolationError(
          "DEAL_NOT_CLOSED",
          `Deal ${deal.dealNumber} is ${deal.status}; mark it CLOSED before releasing funds on closing`,
          { dealId: deal.id, status: deal.status },
        );
      }

      const { entry, balanceAfter } = await insertDisbursement(tx, actor.id, {
        dealId: input.dealId,
        trustAccountId: input.trustAccountId,
        entryType,
        amount: input.amount,
        method: input.method,
        referenceNo: input.referenceNo,
        payeeName: input.payeeName,
        date: input.dateDisbursed,
        authorizationMethod: input.authorizationMethod,
        authorizationReference: input.authorizationReference,
        memo: input.memo,
        idempotencyKey,
        statusWhenEmpty: input.payeeType === "PAYOR_REFUND" ? "REFUNDED" : "RELEASED",
      });
      return { entry, balanceAfter, warnings: [] };
    },
  );
}

export interface DisbursementRow {
  dealId: string;
  trustAccountId: string;
  entryType: string;
  amount: Cents;
  method: string;
  referenceNo: string | null;
  payeeName: string;
  date: string;
  authorizationMethod: string;
  authorizationReference: string | null;
  memo: string | null;
  idempotencyKey: string;
  /** Deposit status to set once the deal's trust balance reaches zero */
  statusWhenEmpty: "RELEASED" | "REFUNDED";
}

/**
 * Pays money out of a deal's trust balance inside the caller's transaction.
 * The caller must already hold the deal row lock. Used by manual disbursements
 * and by closing finalization, so both go through the same hold and
 * segregation checks.
 */
export async function insertDisbursement(
  tx: Tx,
  actorId: string,
  p: DisbursementRow,
): Promise<{ entry: LedgerEntry; balanceAfter: Cents }> {
  const hold = await activeHold(tx, p.dealId);
  if (hold) throw new TrustHoldActiveError(p.dealId, hold.id, hold.reason);

  const available = await assertSufficientDealFunds(tx, p.dealId, p.trustAccountId, p.amount);

  const [entry] = await tx.$queryRaw<LedgerEntry[]>`
    INSERT INTO "TrustLedgerEntry" AS e (
      id, "trustAccountId", "transactionId", "entryType", amount, method, "referenceNo", counterparty,
      "effectiveDate", "authorizationMethod", "authorizationReference", memo, "idempotencyKey",
      "enteredById", "authorizedById")
    VALUES (
      gen_random_uuid(), ${p.trustAccountId}::uuid, ${p.dealId}::uuid, ${p.entryType}::"TrustEntryType",
      ${formatCents(p.amount)}::numeric, ${p.method}::"PaymentMethod", ${p.referenceNo},
      ${p.payeeName}, ${p.date}::date,
      ${p.authorizationMethod}::"TrustAuthorization", ${p.authorizationReference}, ${p.memo},
      ${p.idempotencyKey}::uuid, ${actorId}::uuid, ${actorId}::uuid)
    RETURNING ${ENTRY_COLUMNS}`;

  const balanceAfter = available - p.amount;
  if (balanceAfter === 0) await setDepositStatus(tx, p.dealId, p.statusWhenEmpty, ["RECEIVED"]);
  return { entry: entry!, balanceAfter };
}

// ── 5. Corrections: reversal rows only ───────────────────────────────────────

export async function reverseEntry(
  db: PrismaClient,
  actor: Actor,
  entryId: string,
  input: ReversalInput,
  idempotencyKey: string,
): Promise<LedgerWriteResult> {
  requireRole(actor, TRUST_AUTHORIZERS, "Reversing a trust entry");

  const original = await findEntry(db, Prisma.sql`e.id = ${entryId}::uuid`);
  if (!original) throw new NotFoundError("Trust entry", entryId);
  const amount = numericToCents(original.amount);

  return writeEntry(
    db,
    idempotencyKey,
    { entryType: "REVERSAL", dealId: original.dealId, amount, reversesEntryId: original.id },
    async (tx) => {
      await lockDeal(tx, original.dealId);

      if (original.entryType === "REVERSAL") {
        throw new RuleViolationError("CANNOT_REVERSE_REVERSAL", "A reversal can't be reversed; post a new entry instead");
      }
      const already = await findEntry(tx, Prisma.sql`e."reversesEntryId" = ${original.id}::uuid`);
      if (already) {
        throw new ConflictError("ALREADY_REVERSED", `Entry ${original.id} was already reversed`, {
          reversalId: already.id,
        });
      }
      if (input.effectiveDate < original.effectiveDate) {
        throw new RuleViolationError("REVERSAL_BEFORE_ORIGINAL", "A reversal can't be dated before the entry it reverses");
      }

      // Taking a deposit back out must not leave the deal negative
      let balanceBefore: Cents;
      if (original.direction === 1) {
        balanceBefore = await assertSufficientDealFunds(tx, original.dealId, original.trustAccountId, amount);
      } else {
        balanceBefore = await dealBalance(tx, original.dealId, original.trustAccountId);
      }

      const [entry] = await tx.$queryRaw<LedgerEntry[]>`
        INSERT INTO "TrustLedgerEntry" AS e (
          id, "trustAccountId", "transactionId", "entryType", amount, method, "referenceNo", counterparty,
          "effectiveDate", memo, "reversesEntryId", "idempotencyKey", "enteredById", "authorizedById")
        VALUES (
          gen_random_uuid(), ${original.trustAccountId}::uuid, ${original.dealId}::uuid, 'REVERSAL',
          ${original.amount}::numeric, ${original.method}::"PaymentMethod", ${original.referenceNo},
          ${original.counterparty}, ${input.effectiveDate}::date, ${input.reason}, ${original.id}::uuid,
          ${idempotencyKey}::uuid, ${actor.id}::uuid, ${actor.id}::uuid)
        RETURNING ${ENTRY_COLUMNS}`;

      return { entry: entry!, balanceAfter: balanceBefore - amount * original.direction, warnings: [] };
    },
  );
}

// ── 4. Disputed / unclaimed holds ────────────────────────────────────────────

export async function flagHold(db: PrismaClient, actor: Actor, dealId: string, input: HoldInput): Promise<TrustHold> {
  requireRole(actor, TRUST_HOLD_FLAGGERS, "Flagging a trust hold");
  try {
    return await db.$transaction(async (tx) => {
      await lockDeal(tx, dealId);
      if (input.depositEntryId) {
        const deposit = await findEntry(tx, Prisma.sql`e.id = ${input.depositEntryId}::uuid`);
        if (!deposit || deposit.dealId !== dealId || deposit.entryType !== "DEPOSIT_RECEIVED") {
          throw new RuleViolationError("INVALID_DEPOSIT_ENTRY", "depositEntryId must be a deposit on this deal");
        }
      }
      const existing = await activeHold(tx, dealId);
      if (existing) {
        throw new ConflictError("HOLD_ALREADY_ACTIVE", `Deal ${dealId} already has an active hold`, { holdId: existing.id });
      }
      const [hold] = await tx.$queryRaw<TrustHold[]>`
        INSERT INTO "TrustHold" AS h (id, "transactionId", "depositEntryId", reason, note, "flaggedById")
        VALUES (gen_random_uuid(), ${dealId}::uuid, ${input.depositEntryId}::uuid,
                ${input.reason}::"TrustHoldReason", ${input.note}, ${actor.id}::uuid)
        RETURNING ${HOLD_COLUMNS}`;
      return hold!;
    });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    if (uniqueViolation(err)?.includes("trust_hold_one_active")) {
      throw new ConflictError("HOLD_ALREADY_ACTIVE", `Deal ${dealId} already has an active hold`);
    }
    throw fromDatabaseError(err) ?? err;
  }
}

export async function releaseHold(
  db: PrismaClient,
  actor: Actor,
  holdId: string,
  input: ReleaseInput,
): Promise<TrustHold> {
  requireRole(actor, TRUST_AUTHORIZERS, "Releasing a trust hold");
  try {
    return await db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ releasedAt: Date | null }[]>`
        SELECT "releasedAt" FROM "TrustHold" WHERE id = ${holdId}::uuid FOR UPDATE`;
      if (!rows[0]) throw new NotFoundError("Trust hold", holdId);
      if (rows[0].releasedAt) throw new ConflictError("HOLD_ALREADY_RELEASED", `Hold ${holdId} is already released`);

      const [hold] = await tx.$queryRaw<TrustHold[]>`
        UPDATE "TrustHold" AS h
           SET "releasedById" = ${actor.id}::uuid, "releaseNote" = ${input.releaseNote}, "releasedAt" = clock_timestamp()
         WHERE h.id = ${holdId}::uuid
        RETURNING ${HOLD_COLUMNS}`;
      return hold!;
    });
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw fromDatabaseError(err) ?? err;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface DealLedger {
  deal: { id: string; dealNumber: string; status: string; trustDepositHolder: string; depositStatus: string };
  balances: { trustAccountId: string; balance: string }[];
  entries: (LedgerEntry & { runningBalance: string })[];
  holds: TrustHold[];
  activeHold: TrustHold | null;
}

async function assertCanViewDeal(db: PrismaClient, actor: Actor, dealId: string): Promise<void> {
  if (TRUST_VIEWERS.includes(actor.role)) return;
  const onDeal = await db.transactionAgent.findFirst({ where: { transactionId: dealId, userId: actor.id } });
  if (!onDeal) throw new ForbiddenError("You can only view the trust ledger for your own deals");
}

export async function getDealLedger(db: PrismaClient, actor: Actor, dealId: string): Promise<DealLedger> {
  const deal = await db.transaction.findUnique({
    where: { id: dealId },
    select: { id: true, dealNumber: true, status: true, trustDepositHolder: true, depositStatus: true },
  });
  if (!deal) throw new NotFoundError("Deal", dealId);
  await assertCanViewDeal(db, actor, dealId);

  const rows = await db.$queryRaw<LedgerEntry[]>`
    SELECT ${ENTRY_COLUMNS} FROM "TrustLedgerEntry" e
     WHERE e."transactionId" = ${dealId}::uuid
     ORDER BY e."createdAt", e.id`;
  const holds = await db.$queryRaw<TrustHold[]>`
    SELECT ${HOLD_COLUMNS} FROM "TrustHold" h
     WHERE h."transactionId" = ${dealId}::uuid
     ORDER BY h."flaggedAt"`;

  const running = new Map<string, Cents>();
  const entries = rows.map((e) => {
    const next = (running.get(e.trustAccountId) ?? 0) + numericToCents(e.amount) * e.direction;
    running.set(e.trustAccountId, next);
    return { ...e, runningBalance: formatCents(next) };
  });

  return {
    deal,
    balances: [...running].map(([trustAccountId, balance]) => ({ trustAccountId, balance: formatCents(balance) })),
    entries,
    holds,
    activeHold: holds.find((h) => h.active) ?? null,
  };
}

export async function getEntry(db: PrismaClient, actor: Actor, entryId: string): Promise<LedgerEntry> {
  const entry = await findEntry(db, Prisma.sql`e.id = ${entryId}::uuid`);
  if (!entry) throw new NotFoundError("Trust entry", entryId);
  await assertCanViewDeal(db, actor, entry.dealId);
  return entry;
}
