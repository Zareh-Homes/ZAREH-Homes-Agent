-- 003 – Statutory trust ledger invariants (RECO / TRESA)
--
-- The database enforces these on its own, so no bug or script in the app
-- can break them:
--   • the ledger is insert-only: UPDATE, DELETE and TRUNCATE are rejected
--   • every row is authorized by an active Managing Broker
--   • every row gets a microsecond database timestamp (clock_timestamp())
--   • a deal's balance in a trust account can never go below zero
--   • nothing leaves trust while the deal has an active hold
--   • reversals must match the original deal, account and amount, once only
--
-- Applies on top of 002. Run with plain `psql -f` (not --single-transaction):
-- new enum values have to be committed before the main block can use them.

ALTER TYPE "PaymentMethod"  ADD VALUE IF NOT EXISTS 'CERTIFIED_CHEQUE' AFTER 'CHEQUE';
ALTER TYPE "TrustEntryType" ADD VALUE IF NOT EXISTS 'DISBURSEMENT_TO_LAWYER' AFTER 'DISBURSEMENT_TO_COOP';

BEGIN;

CREATE TYPE "TrustAuthorization" AS ENUM ('CLOSING_COMPLETED', 'MUTUAL_RELEASE', 'COURT_ORDER');
CREATE TYPE "TrustHoldReason"    AS ENUM ('DISPUTED', 'UNCLAIMED');

-- The v1 guard allowed some updates; replace it. Drop it first so existing
-- rows can be backfilled below.
DROP TRIGGER IF EXISTS trust_ledger_immutable ON "TrustLedgerEntry";
DROP FUNCTION IF EXISTS trust_ledger_guard();
DROP VIEW IF EXISTS deal_trust_balance;

-- ── Ledger columns ───────────────────────────────────────────────────────────

-- Broker sign-off becomes mandatory and happens at insert time
ALTER TABLE "TrustLedgerEntry" DROP CONSTRAINT "TrustLedgerEntry_approvedById_fkey";
ALTER TABLE "TrustLedgerEntry" RENAME COLUMN "approvedById" TO "authorizedById";
UPDATE "TrustLedgerEntry" SET "authorizedById" = "enteredById" WHERE "authorizedById" IS NULL;
ALTER TABLE "TrustLedgerEntry" ALTER COLUMN "authorizedById" SET NOT NULL;
ALTER TABLE "TrustLedgerEntry" ADD CONSTRAINT "TrustLedgerEntry_authorizedById_fkey"
  FOREIGN KEY ("authorizedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Post-insert stamps can't exist on an immutable row. Bank matching will get
-- its own append-only table.
DROP INDEX IF EXISTS "TrustLedgerEntry_bankMatchedAt_idx";
ALTER TABLE "TrustLedgerEntry" DROP COLUMN "approvedAt", DROP COLUMN "bankMatchedAt";

ALTER TABLE "TrustLedgerEntry"
  ADD COLUMN "direction"              SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN "receivedDate"           DATE,
  ADD COLUMN "authorizationMethod"    "TrustAuthorization",
  ADD COLUMN "authorizationReference" TEXT,
  ADD COLUMN "idempotencyKey"         UUID;

-- Backfill any existing rows (pre-production data)
UPDATE "TrustLedgerEntry" SET direction = CASE WHEN "entryType" = 'DEPOSIT_RECEIVED' THEN 1 ELSE -1 END
  WHERE "entryType" <> 'REVERSAL';
UPDATE "TrustLedgerEntry" r SET direction = -o.direction
  FROM "TrustLedgerEntry" o WHERE r."reversesEntryId" = o.id;
UPDATE "TrustLedgerEntry" SET "receivedDate" = "effectiveDate" WHERE "entryType" = 'DEPOSIT_RECEIVED';
UPDATE "TrustLedgerEntry" SET "authorizationMethod" = 'CLOSING_COMPLETED'
  WHERE "entryType" IN ('DISBURSEMENT_TO_GENERAL', 'DISBURSEMENT_TO_COOP', 'REFUND_TO_PAYER');
UPDATE "TrustLedgerEntry" SET "idempotencyKey" = gen_random_uuid();

ALTER TABLE "TrustLedgerEntry" ALTER COLUMN "idempotencyKey" SET NOT NULL;
CREATE UNIQUE INDEX "TrustLedgerEntry_idempotencyKey_key" ON "TrustLedgerEntry"("idempotencyKey");

-- Microsecond, timezone-aware audit timestamps taken from the database clock
ALTER TABLE "TrustLedgerEntry"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(6) USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" SET DEFAULT clock_timestamp();

DROP INDEX IF EXISTS "TrustLedgerEntry_transactionId_effectiveDate_idx";
CREATE INDEX "TrustLedgerEntry_transactionId_trustAccountId_createdAt_idx"
  ON "TrustLedgerEntry"("transactionId", "trustAccountId", "createdAt");

-- ── Row rules ────────────────────────────────────────────────────────────────

ALTER TABLE "TrustLedgerEntry" ADD CONSTRAINT trust_direction_set CHECK (direction IN (-1, 1));

ALTER TABLE "TrustLedgerEntry" ADD CONSTRAINT trust_deposit_fields CHECK (
  "entryType" <> 'DEPOSIT_RECEIVED' OR (
    "receivedDate" IS NOT NULL
    AND "receiptNumber" IS NOT NULL
    AND NULLIF(btrim("referenceNo"), '') IS NOT NULL
    AND "effectiveDate" >= "receivedDate"
    AND method IN ('BANK_DRAFT', 'WIRE', 'CERTIFIED_CHEQUE')
  ));

ALTER TABLE "TrustLedgerEntry" ADD CONSTRAINT trust_disbursement_authorized CHECK (
  "entryType" NOT IN ('DISBURSEMENT_TO_GENERAL', 'DISBURSEMENT_TO_COOP', 'DISBURSEMENT_TO_LAWYER', 'REFUND_TO_PAYER')
  OR "authorizationMethod" IS NOT NULL);

ALTER TABLE "TrustLedgerEntry" ADD CONSTRAINT trust_authorization_reference CHECK (
  "authorizationMethod" NOT IN ('MUTUAL_RELEASE', 'COURT_ORDER')
  OR NULLIF(btrim("authorizationReference"), '') IS NOT NULL);

-- A terminated deal's refund needs a release or a court order, never "closing"
ALTER TABLE "TrustLedgerEntry" ADD CONSTRAINT trust_refund_not_closing CHECK (
  "entryType" <> 'REFUND_TO_PAYER' OR "authorizationMethod" <> 'CLOSING_COMPLETED');

ALTER TABLE "TrustLedgerEntry" ADD CONSTRAINT trust_reversal_shape CHECK (
  ("entryType" = 'REVERSAL') = ("reversesEntryId" IS NOT NULL)
  AND ("entryType" <> 'REVERSAL' OR NULLIF(btrim(memo), '') IS NOT NULL));

-- ── Holds (disputed / unclaimed) ─────────────────────────────────────────────

CREATE TABLE "TrustHold" (
  "id"             UUID NOT NULL,
  "transactionId"  UUID NOT NULL,
  "depositEntryId" UUID,
  "reason"         "TrustHoldReason" NOT NULL,
  "note"           TEXT NOT NULL,
  "flaggedById"    UUID NOT NULL,
  "flaggedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "releasedById"   UUID,
  "releasedAt"     TIMESTAMPTZ(6),
  "releaseNote"    TEXT,
  CONSTRAINT "TrustHold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT trust_hold_note CHECK (NULLIF(btrim("note"), '') IS NOT NULL),
  CONSTRAINT trust_hold_release_complete CHECK (
    ("releasedAt" IS NULL) = ("releasedById" IS NULL)
    AND ("releasedAt" IS NULL) = (NULLIF(btrim("releaseNote"), '') IS NULL))
);
CREATE INDEX "TrustHold_transactionId_idx" ON "TrustHold"("transactionId");
-- One active hold per deal
CREATE UNIQUE INDEX trust_hold_one_active ON "TrustHold"("transactionId") WHERE "releasedAt" IS NULL;

ALTER TABLE "TrustHold" ADD CONSTRAINT "TrustHold_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustHold" ADD CONSTRAINT "TrustHold_depositEntryId_fkey"
  FOREIGN KEY ("depositEntryId") REFERENCES "TrustLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TrustHold" ADD CONSTRAINT "TrustHold_flaggedById_fkey"
  FOREIGN KEY ("flaggedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustHold" ADD CONSTRAINT "TrustHold_releasedById_fkey"
  FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Triggers: ledger ─────────────────────────────────────────────────────────
-- Custom SQLSTATEs so the API can map them to clean errors:
--   ZT001 insufficient funds   ZT002 hold active   ZT003 not authorized
--   ZT004 invalid reversal     ZT005 immutable     ZT006 hold rule

CREATE FUNCTION trust_ledger_before_insert() RETURNS trigger AS $$
DECLARE
  orig          "TrustLedgerEntry"%ROWTYPE;
  auth_role     "UserRole";
  auth_active   boolean;
  deal_balance  numeric(14, 2);
BEGIN
  NEW."createdAt" := clock_timestamp();

  SELECT role, "isActive" INTO auth_role, auth_active FROM "User" WHERE id = NEW."authorizedById";
  IF auth_role IS DISTINCT FROM 'MANAGING_BROKER' OR auth_active IS NOT TRUE THEN
    RAISE EXCEPTION 'TRUST_UNAUTHORIZED: user % is not an active managing broker', NEW."authorizedById"
      USING ERRCODE = 'ZT003';
  END IF;

  -- Serialize every ledger write for this deal
  PERFORM 1 FROM "Transaction" WHERE id = NEW."transactionId" FOR UPDATE;

  IF NEW."entryType" = 'DEPOSIT_RECEIVED' THEN
    NEW.direction := 1;
  ELSIF NEW."entryType" = 'REVERSAL' THEN
    SELECT * INTO orig FROM "TrustLedgerEntry" WHERE id = NEW."reversesEntryId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'TRUST_INVALID_REVERSAL: entry % not found', NEW."reversesEntryId" USING ERRCODE = 'ZT004';
    END IF;
    IF orig."entryType" = 'REVERSAL' THEN
      RAISE EXCEPTION 'TRUST_INVALID_REVERSAL: a reversal cannot be reversed' USING ERRCODE = 'ZT004';
    END IF;
    IF orig."transactionId" <> NEW."transactionId"
       OR orig."trustAccountId" <> NEW."trustAccountId"
       OR orig.amount <> NEW.amount THEN
      RAISE EXCEPTION 'TRUST_INVALID_REVERSAL: must match the original deal, account and amount'
        USING ERRCODE = 'ZT004';
    END IF;
    NEW.direction := -orig.direction;
  ELSE
    NEW.direction := -1;
  END IF;

  -- Reversals are bookkeeping corrections, not payouts, so a hold doesn't block them
  IF NEW."entryType" <> 'REVERSAL' AND NEW.direction = -1 AND EXISTS (
       SELECT 1 FROM "TrustHold" WHERE "transactionId" = NEW."transactionId" AND "releasedAt" IS NULL) THEN
    RAISE EXCEPTION 'TRUST_HOLD_ACTIVE: deal % has an active trust hold', NEW."transactionId"
      USING ERRCODE = 'ZT002';
  END IF;

  IF NEW.direction = -1 THEN
    SELECT COALESCE(SUM(amount * direction), 0) INTO deal_balance
      FROM "TrustLedgerEntry"
     WHERE "transactionId" = NEW."transactionId" AND "trustAccountId" = NEW."trustAccountId";
    IF deal_balance - NEW.amount < 0 THEN
      RAISE EXCEPTION 'INSUFFICIENT_TRUST_FUNDS: deal % holds %, requested %',
        NEW."transactionId", deal_balance, NEW.amount USING ERRCODE = 'ZT001';
    END IF;
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trust_ledger_before_insert
  BEFORE INSERT ON "TrustLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION trust_ledger_before_insert();

CREATE FUNCTION trust_ledger_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TRUST_LEDGER_IMMUTABLE: % is not allowed on the trust ledger; post a reversal instead', TG_OP
    USING ERRCODE = 'ZT005';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trust_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON "TrustLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION trust_ledger_reject_change();
CREATE TRIGGER trust_ledger_no_truncate
  BEFORE TRUNCATE ON "TrustLedgerEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION trust_ledger_reject_change();

-- ── Triggers: holds ──────────────────────────────────────────────────────────

CREATE FUNCTION trust_hold_guard() RETURNS trigger AS $$
DECLARE
  actor_role   "UserRole";
  actor_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TRUST_HOLD_RULE: holds cannot be deleted; release them instead' USING ERRCODE = 'ZT006';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."flaggedAt" := clock_timestamp();
    IF NEW."releasedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'TRUST_HOLD_RULE: a hold cannot be created already released' USING ERRCODE = 'ZT006';
    END IF;
    SELECT role, "isActive" INTO actor_role, actor_active FROM "User" WHERE id = NEW."flaggedById";
    IF actor_role NOT IN ('ADMIN', 'MANAGING_BROKER', 'FILE_REVIEWER') OR actor_active IS NOT TRUE THEN
      RAISE EXCEPTION 'TRUST_UNAUTHORIZED: user % cannot flag trust holds', NEW."flaggedById" USING ERRCODE = 'ZT003';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: only a one-time release, by a managing broker
  IF OLD."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'TRUST_HOLD_RULE: hold % is already released', OLD.id USING ERRCODE = 'ZT006';
  END IF;
  IF (NEW.id, NEW."transactionId", NEW."depositEntryId", NEW.reason, NEW.note, NEW."flaggedById", NEW."flaggedAt")
     IS DISTINCT FROM
     (OLD.id, OLD."transactionId", OLD."depositEntryId", OLD.reason, OLD.note, OLD."flaggedById", OLD."flaggedAt") THEN
    RAISE EXCEPTION 'TRUST_HOLD_RULE: only the release fields of a hold can be set' USING ERRCODE = 'ZT006';
  END IF;
  SELECT role, "isActive" INTO actor_role, actor_active FROM "User" WHERE id = NEW."releasedById";
  IF actor_role IS DISTINCT FROM 'MANAGING_BROKER' OR actor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'TRUST_UNAUTHORIZED: only an active managing broker can release a hold' USING ERRCODE = 'ZT003';
  END IF;
  NEW."releasedAt" := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trust_hold_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "TrustHold"
  FOR EACH ROW EXECUTE FUNCTION trust_hold_guard();
CREATE TRIGGER trust_hold_no_truncate
  BEFORE TRUNCATE ON "TrustHold"
  FOR EACH STATEMENT EXECUTE FUNCTION trust_ledger_reject_change();

-- ── Reporting ────────────────────────────────────────────────────────────────

CREATE VIEW deal_trust_balance AS
SELECT "transactionId", "trustAccountId", SUM(amount * direction) AS balance
  FROM "TrustLedgerEntry"
 GROUP BY "transactionId", "trustAccountId";

COMMIT;

-- Recommended in production: the app's database role gets no UPDATE/DELETE at all.
--   REVOKE UPDATE, DELETE, TRUNCATE ON "TrustLedgerEntry" FROM app_user;
--   GRANT SELECT, INSERT ON "TrustLedgerEntry" TO app_user;
