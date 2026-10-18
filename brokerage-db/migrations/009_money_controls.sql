-- 009 – Money controls after review
--
--   • Account kinds: real estate trust, commission trust, operating.
--   • Financial policies: switches only the broker of record can turn on,
--     each with the counsel / accountant sign-off reference, for decisions
--     that depend on professional advice. Everything they gate stays off
--     until then.
--   • Broker of record (and designated substitute) as a recorded legal
--     designation, separate from the MANAGING_BROKER permission. Signs
--     reconciliations, attests pre-cutover history, handles s.14 incidents.
--   • Bank evidence: where each file came from, when the brokerage received
--     the statement (O. Reg. 579/05 s.13 clock), independent verification
--     by a second person, and interim bank records (same-day activity and
--     balance) so commission can be verified without waiting a month.
--     Only verified evidence clears funds.
--   • Trust incidents (s.14): a shortfall opens an incident that tracks
--     registrar notification and replenishment. Nothing is sent or moved.
--   • Payouts: one event history for agent payouts and third-party
--     payables (co-op brokerages, referrals). APPROVED → PAID →
--     PAYMENT_REVERSED → PAID…, or CANCELLED. Approval needs the commission
--     received, not reversed, verified at the bank, approved by someone
--     else, and funds actually available in the paying account.
--   • Commission receipt reversals; void and reissue of a finalized CDA.
--   • A restricted database role for the application.
--
-- New SQLSTATEs: ZP001 policy not approved; ZT008 funds not available. Applies on top of 008.

-- New enum values must be committed before functions below can refer to them
ALTER TYPE "PayoutEventKind" ADD VALUE IF NOT EXISTS 'PAYMENT_REVERSED';
ALTER TYPE "PayoutEventKind" ADD VALUE IF NOT EXISTS 'CANCELLED';

BEGIN;

-- ── Account kinds ────────────────────────────────────────────────────────────

CREATE TYPE "TrustAccountKind" AS ENUM ('REAL_ESTATE_TRUST', 'COMMISSION_TRUST');
ALTER TABLE "TrustAccount" ADD COLUMN "kind" "TrustAccountKind" NOT NULL DEFAULT 'REAL_ESTATE_TRUST';

-- The deal trust ledger is the real estate trust account's; commission trust money is tracked as receipts and payouts
CREATE FUNCTION trust_ledger_account_kind() RETURNS trigger AS $$
BEGIN
  IF (SELECT kind FROM "TrustAccount" WHERE id = NEW."trustAccountId") IS DISTINCT FROM 'REAL_ESTATE_TRUST' THEN
    RAISE EXCEPTION 'BANK_RULE: deal trust entries belong in a real estate trust account' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trust_ledger_a_account_kind
  BEFORE INSERT ON "TrustLedgerEntry" FOR EACH ROW EXECUTE FUNCTION trust_ledger_account_kind();

-- ── Broker of record ─────────────────────────────────────────────────────────

CREATE TYPE "BrokerDesignationRole" AS ENUM ('BROKER_OF_RECORD', 'DESIGNATED_SUBSTITUTE');

CREATE TABLE "BrokerOfRecordDesignation" (
  "id"            UUID NOT NULL,
  "userId"        UUID NOT NULL,
  "role"          "BrokerDesignationRole" NOT NULL,
  "effectiveFrom" DATE NOT NULL,
  "effectiveTo"   DATE,
  "reference"     TEXT NOT NULL,
  "createdById"   UUID NOT NULL,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "BrokerOfRecordDesignation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT designation_period CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  CONSTRAINT designation_reference CHECK (btrim("reference") <> '')
);
CREATE INDEX "BrokerOfRecordDesignation_userId_idx" ON "BrokerOfRecordDesignation"("userId");
ALTER TABLE "BrokerOfRecordDesignation" ADD CONSTRAINT "BrokerOfRecordDesignation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BrokerOfRecordDesignation" ADD CONSTRAINT "BrokerOfRecordDesignation_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION is_broker_of_record(who UUID, on_date DATE) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "BrokerOfRecordDesignation" d JOIN "User" u ON u.id = d."userId"
     WHERE d."userId" = who AND u."isActive" AND u.role = 'MANAGING_BROKER'
       AND d."effectiveFrom" <= on_date AND (d."effectiveTo" IS NULL OR d."effectiveTo" >= on_date))
$$ LANGUAGE sql STABLE;

CREATE FUNCTION require_broker_of_record(who UUID, action TEXT) RETURNS void AS $$
BEGIN
  IF NOT is_broker_of_record(who, (clock_timestamp() AT TIME ZONE 'America/Toronto')::date) THEN
    RAISE EXCEPTION 'BROKER_OF_RECORD_REQUIRED: % must be done by the broker of record or a designated substitute', action
      USING ERRCODE = 'ZD002';
  END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION designation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    PERFORM require_bank_staff(NEW."createdById", false, 'recording a broker-of-record designation');
    IF NEW."createdById" = NEW."userId" THEN
      RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: someone else must record your designation' USING ERRCODE = 'ZD002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "User" WHERE id = NEW."userId" AND role = 'MANAGING_BROKER' AND "isActive") THEN
      RAISE EXCEPTION 'BANK_RULE: only an active broker can be designated' USING ERRCODE = 'ZB001';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('broker-of-record'));
    IF NEW.role = 'BROKER_OF_RECORD' AND EXISTS (
         SELECT 1 FROM "BrokerOfRecordDesignation" d WHERE d.role = 'BROKER_OF_RECORD'
            AND daterange(d."effectiveFrom", d."effectiveTo", '[]') && daterange(NEW."effectiveFrom", NEW."effectiveTo", '[]')) THEN
      RAISE EXCEPTION 'BANK_RULE: another broker of record is designated for part of that period; end that designation first'
        USING ERRCODE = 'ZB001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR OLD."effectiveTo" IS NOT NULL
     OR (NEW.id, NEW."userId", NEW.role, NEW."effectiveFrom", NEW.reference, NEW."createdById", NEW."createdAt")
        IS DISTINCT FROM (OLD.id, OLD."userId", OLD.role, OLD."effectiveFrom", OLD.reference, OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'APPEND_ONLY: a designation can only be ended, once' USING ERRCODE = 'ZD003';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER designation_guard BEFORE INSERT OR UPDATE OR DELETE ON "BrokerOfRecordDesignation"
  FOR EACH ROW EXECUTE FUNCTION designation_guard();

-- ── Financial policies ───────────────────────────────────────────────────────

CREATE TABLE "FinancialPolicyDecision" (
  "id"          UUID NOT NULL,
  "policy"      TEXT NOT NULL,
  "enabled"     BOOLEAN NOT NULL,
  "reference"   TEXT NOT NULL,
  "note"        TEXT,
  "decidedById" UUID NOT NULL,
  "decidedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "FinancialPolicyDecision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT policy_known CHECK ("policy" IN ('SOLE_OPERATOR_EXCEPTION', 'THIRD_PARTY_PAYABLES')),
  CONSTRAINT policy_reference CHECK (btrim("reference") <> '')
);
CREATE INDEX "FinancialPolicyDecision_policy_decidedAt_idx" ON "FinancialPolicyDecision"("policy", "decidedAt");
ALTER TABLE "FinancialPolicyDecision" ADD CONSTRAINT "FinancialPolicyDecision_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION policy_enabled(key TEXT) RETURNS boolean AS $$
  SELECT COALESCE((SELECT enabled FROM "FinancialPolicyDecision" WHERE policy = key ORDER BY "decidedAt" DESC, id DESC LIMIT 1), false)
$$ LANGUAGE sql STABLE;

CREATE FUNCTION policy_decision_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."decidedAt" := clock_timestamp();
  PERFORM require_broker_of_record(NEW."decidedById", 'changing a financial policy');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER policy_decision_before_insert BEFORE INSERT ON "FinancialPolicyDecision"
  FOR EACH ROW EXECUTE FUNCTION policy_decision_before_insert();
CREATE TRIGGER policy_decision_immutable BEFORE UPDATE OR DELETE ON "FinancialPolicyDecision"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- One person doing two duties is refused unless the sole-operator exception is on and a reason is given
CREATE FUNCTION require_separate_people(a UUID, b UUID, reason TEXT, duty TEXT) RETURNS boolean AS $$
BEGIN
  IF a IS DISTINCT FROM b THEN RETURN false; END IF;
  IF policy_enabled('SOLE_OPERATOR_EXCEPTION') AND NULLIF(btrim(reason), '') IS NOT NULL THEN RETURN true; END IF;
  RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: % must be done by a different person', duty USING ERRCODE = 'ZD002';
END $$ LANGUAGE plpgsql;

-- ── Bank evidence ────────────────────────────────────────────────────────────

CREATE TYPE "StatementKind" AS ENUM ('MONTHLY', 'INTERIM');

ALTER TABLE "BankStatement"
  ADD COLUMN "kind"         "StatementKind" NOT NULL DEFAULT 'MONTHLY',
  ADD COLUMN "receivedDate" DATE,
  ADD COLUMN "source"       TEXT,
  ADD COLUMN "sourceNote"   TEXT,
  ALTER COLUMN "openingBalance" DROP NOT NULL;
ALTER TABLE "BankStatement" ADD CONSTRAINT statement_source CHECK (
  "source" IS NULL OR "source" IN ('BANK_PORTAL_DOWNLOAD', 'BANK_EMAIL', 'BANK_PAPER_STATEMENT', 'OTHER'));
ALTER TABLE "BankStatement" ADD CONSTRAINT statement_monthly_opening CHECK ("kind" = 'INTERIM' OR "openingBalance" IS NOT NULL);
ALTER TABLE "BankStatement" ADD CONSTRAINT statement_evidence
  CHECK ("receivedDate" IS NOT NULL AND "source" IS NOT NULL AND ("source" <> 'OTHER' OR NULLIF(btrim("sourceNote"), '') IS NOT NULL)) NOT VALID;

ALTER TABLE "BankTransaction" ADD COLUMN "fingerprint" TEXT;
CREATE UNIQUE INDEX "BankTransaction_fingerprint_key" ON "BankTransaction"("fingerprint");

CREATE OR REPLACE FUNCTION bank_statement_before_insert() RETURNS trigger AS $$
DECLARE
  prev "BankStatement"%ROWTYPE;
BEGIN
  NEW."importedAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."importedById", false, 'importing a bank statement');
  IF NEW."receivedDate" < NEW."periodEnd" THEN
    RAISE EXCEPTION 'BANK_RULE: received date % can''t be before the statement date %',
      NEW."receivedDate", NEW."periodEnd" USING ERRCODE = 'ZB001';
  END IF;
  IF NEW.kind = 'INTERIM' THEN
    RETURN NEW; -- interim records may overlap; they never replace the monthly statement
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bank-statement:' || COALESCE(NEW."trustAccountId", NEW."operatingAccountId")::text));
  SELECT * INTO prev FROM "BankStatement"
   WHERE "trustAccountId" IS NOT DISTINCT FROM NEW."trustAccountId"
     AND "operatingAccountId" IS NOT DISTINCT FROM NEW."operatingAccountId" AND kind = 'MONTHLY'
   ORDER BY "periodEnd" DESC LIMIT 1;
  IF FOUND THEN
    IF NEW."periodStart" <= prev."periodEnd" THEN
      RAISE EXCEPTION 'BANK_RULE: statement period starting % overlaps the statement ending %', NEW."periodStart", prev."periodEnd"
        USING ERRCODE = 'ZB001';
    END IF;
    IF NEW."periodStart" > prev."periodEnd" + 1 THEN
      RAISE EXCEPTION 'BANK_RULE: missing statement between % and %', prev."periodEnd" + 1, NEW."periodStart" - 1
        USING ERRCODE = 'ZB001';
    END IF;
    IF NEW."openingBalance" <> prev."closingBalance" THEN
      RAISE EXCEPTION 'BANK_RULE: opening balance % doesn''t equal the previous statement''s closing balance %',
        NEW."openingBalance", prev."closingBalance" USING ERRCODE = 'ZB001';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION bank_statement_balances() RETURNS trigger AS $$
DECLARE
  lines DECIMAL(14, 2);
BEGIN
  IF NEW."openingBalance" IS NULL THEN RETURN NULL; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO lines FROM "BankTransaction" WHERE "statementId" = NEW.id;
  IF NEW."openingBalance" + lines <> NEW."closingBalance" THEN
    RAISE EXCEPTION 'BANK_RULE: opening % + transactions % = %, but the statement closes at %',
      NEW."openingBalance", lines, NEW."openingBalance" + lines, NEW."closingBalance" USING ERRCODE = 'ZB001';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- A second person checks the imported file against the bank itself
CREATE TABLE "BankStatementVerification" (
  "statementId"           UUID NOT NULL,
  "verifiedById"          UUID NOT NULL,
  "method"                TEXT NOT NULL,
  "segregationException"  BOOLEAN NOT NULL DEFAULT false,
  "exceptionReason"       TEXT,
  "verifiedAt"            TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "BankStatementVerification_pkey" PRIMARY KEY ("statementId"),
  CONSTRAINT verification_method CHECK (btrim("method") <> '')
);
ALTER TABLE "BankStatementVerification" ADD CONSTRAINT "BankStatementVerification_statementId_fkey"
  FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankStatementVerification" ADD CONSTRAINT "BankStatementVerification_verifiedById_fkey"
  FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION statement_verification_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."verifiedAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."verifiedById", false, 'verifying a bank statement');
  NEW."segregationException" := require_separate_people(
    NEW."verifiedById", (SELECT "importedById" FROM "BankStatement" WHERE id = NEW."statementId"), NEW."exceptionReason",
    'Verifying a bank file against the bank (the importer can''t verify their own import)');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER statement_verification_before_insert BEFORE INSERT ON "BankStatementVerification"
  FOR EACH ROW EXECUTE FUNCTION statement_verification_before_insert();
CREATE TRIGGER statement_verification_immutable BEFORE UPDATE OR DELETE ON "BankStatementVerification"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- Matches: a monthly-statement match (reconciliation and clearance) and an
-- interim match (clearance only, until the monthly statement arrives)
ALTER TABLE "BankMatch" ADD COLUMN "matchKind" "StatementKind" NOT NULL DEFAULT 'MONTHLY';
DROP INDEX "BankMatch_trustEntryId_key";
DROP INDEX "BankMatch_commissionReceiptId_key";
CREATE UNIQUE INDEX "BankMatch_trustEntryId_matchKind_key" ON "BankMatch"("trustEntryId", "matchKind");
CREATE UNIQUE INDEX "BankMatch_commissionReceiptId_matchKind_key" ON "BankMatch"("commissionReceiptId", "matchKind");

-- Commission is received into the operating account or a commission trust account
ALTER TABLE "CommissionReceipt"
  ADD COLUMN "trustAccountId"     UUID,
  ADD COLUMN "operatingAccountId" UUID;
ALTER TABLE "CommissionReceipt" ADD CONSTRAINT receipt_one_account
  CHECK (("trustAccountId" IS NULL) <> ("operatingAccountId" IS NULL)) NOT VALID;
ALTER TABLE "CommissionReceipt" ADD CONSTRAINT "CommissionReceipt_trustAccountId_fkey"
  FOREIGN KEY ("trustAccountId") REFERENCES "TrustAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionReceipt" ADD CONSTRAINT "CommissionReceipt_operatingAccountId_fkey"
  FOREIGN KEY ("operatingAccountId") REFERENCES "OperatingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION bank_match_before_insert() RETURNS trigger AS $$
DECLARE
  line    "BankTransaction"%ROWTYPE;
  stmt    "BankStatement"%ROWTYPE;
  entry   "TrustLedgerEntry"%ROWTYPE;
  receipt "CommissionReceipt"%ROWTYPE;
  first_period DATE;
BEGIN
  NEW."matchedAt" := clock_timestamp();
  IF NEW.basis = 'PRE_CUTOVER' THEN
    PERFORM require_broker_of_record(NEW."matchedById", 'Attesting to pre-cutover trust history');
  ELSE
    PERFORM require_bank_staff(NEW."matchedById", false, 'matching a bank transaction');
  END IF;

  IF NEW."trustEntryId" IS NOT NULL THEN
    SELECT * INTO entry FROM "TrustLedgerEntry" WHERE id = NEW."trustEntryId";
    PERFORM 1 FROM "Transaction" WHERE id = entry."transactionId" FOR UPDATE; -- same lock as ledger writes
  ELSE
    SELECT * INTO receipt FROM "CommissionReceipt" WHERE id = NEW."commissionReceiptId";
    PERFORM 1 FROM "ClosingStatement" WHERE id = receipt."closingId" FOR UPDATE; -- same lock as payout approvals
  END IF;

  IF NEW.basis = 'PRE_CUTOVER' THEN
    NEW."matchKind" := 'MONTHLY';
    SELECT MIN("periodStart") INTO first_period FROM "BankStatement" WHERE "trustAccountId" = entry."trustAccountId" AND kind = 'MONTHLY';
    IF first_period IS NOT NULL AND entry."effectiveDate" >= first_period THEN
      RAISE EXCEPTION 'BANK_RULE: entry dated % is covered by imported statements (from %); match it to a statement line',
        entry."effectiveDate", first_period USING ERRCODE = 'ZB001';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO line FROM "BankTransaction" WHERE id = NEW."bankTransactionId";
  SELECT * INTO stmt FROM "BankStatement" WHERE id = line."statementId";
  NEW."matchKind" := stmt.kind;
  IF NEW."trustEntryId" IS NOT NULL THEN
    IF stmt."trustAccountId" IS DISTINCT FROM entry."trustAccountId" THEN
      RAISE EXCEPTION 'BANK_RULE: the statement line is not from this entry''s trust account' USING ERRCODE = 'ZB001';
    END IF;
    IF line.amount <> entry.amount * entry.direction THEN
      RAISE EXCEPTION 'BANK_RULE: bank amount % doesn''t equal the ledger entry %', line.amount, entry.amount * entry.direction
        USING ERRCODE = 'ZB001';
    END IF;
    IF line."postedDate" < entry."effectiveDate" - 7 THEN
      RAISE EXCEPTION 'BANK_RULE: bank line dated % is more than a week before the entry (%)', line."postedDate", entry."effectiveDate"
        USING ERRCODE = 'ZB001';
    END IF;
  ELSE
    IF stmt."trustAccountId" IS DISTINCT FROM receipt."trustAccountId" OR stmt."operatingAccountId" IS DISTINCT FROM receipt."operatingAccountId" THEN
      RAISE EXCEPTION 'BANK_RULE: the statement line is not from the account this commission was received into' USING ERRCODE = 'ZB001';
    END IF;
    IF line.amount <> receipt.amount THEN
      RAISE EXCEPTION 'BANK_RULE: bank amount % doesn''t equal the commission receipt %', line.amount, receipt.amount
        USING ERRCODE = 'ZB001';
    END IF;
    IF line."postedDate" < receipt."receivedDate" - 7 THEN
      RAISE EXCEPTION 'BANK_RULE: bank line dated % is more than a week before the receipt (%)', line."postedDate", receipt."receivedDate"
        USING ERRCODE = 'ZB001';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Evidence only clears funds once it's verified (or is a broker's pre-cutover attestation)
CREATE FUNCTION bank_match_is_cleared(m "BankMatch") RETURNS boolean AS $$
  SELECT m.basis = 'PRE_CUTOVER' OR EXISTS (
    SELECT 1 FROM "BankTransaction" t JOIN "BankStatementVerification" v ON v."statementId" = t."statementId"
     WHERE t.id = m."bankTransactionId")
$$ LANGUAGE sql STABLE;

CREATE FUNCTION trust_entry_cleared(entry UUID) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "BankMatch" m WHERE m."trustEntryId" = entry AND bank_match_is_cleared(m))
$$ LANGUAGE sql STABLE;

CREATE FUNCTION receipt_cleared(receipt UUID) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "BankMatch" m WHERE m."commissionReceiptId" = receipt AND bank_match_is_cleared(m))
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION trust_cleared_balance(deal UUID, account UUID) RETURNS DECIMAL(14, 2) AS $$
  SELECT COALESCE(SUM(CASE
           WHEN e."entryType" = 'DEPOSIT_RECEIVED' THEN
             CASE WHEN trust_entry_cleared(e.id)
                   AND NOT EXISTS (SELECT 1 FROM "TrustLedgerEntry" r WHERE r."reversesEntryId" = e.id)
                  THEN e.amount ELSE 0 END
           WHEN e."entryType" = 'REVERSAL' AND EXISTS (
                  SELECT 1 FROM "TrustLedgerEntry" o WHERE o.id = e."reversesEntryId" AND o."entryType" = 'DEPOSIT_RECEIVED') THEN 0
           ELSE e.amount * e.direction END), 0)::DECIMAL(14, 2)
    FROM "TrustLedgerEntry" e
   WHERE e."transactionId" = deal AND e."trustAccountId" = account
$$ LANGUAGE sql STABLE;

-- ── Reconciliation sign-off ──────────────────────────────────────────────────

ALTER TABLE "TrustReconciliation"
  ADD COLUMN "signSegregationException" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "signExceptionReason"      TEXT;

-- ── Trust incidents (O. Reg. 579/05 s.14) ────────────────────────────────────

CREATE TYPE "TrustIncidentKind" AS ENUM ('SHORTFALL', 'DISCREPANCY');
CREATE TYPE "TrustIncidentEventKind" AS ENUM ('OBSERVED', 'NOTE', 'REGISTRAR_NOTIFIED', 'REPLENISHED', 'RESOLVED');

CREATE TABLE "TrustIncident" (
  "id"               UUID NOT NULL,
  "trustAccountId"   UUID NOT NULL,
  "kind"             "TrustIncidentKind" NOT NULL,
  "summary"          TEXT NOT NULL,
  "amount"           DECIMAL(14, 2) NOT NULL,
  "reconciliationId" UUID,
  "detectedById"     UUID NOT NULL,
  "detectedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "TrustIncident_pkey" PRIMARY KEY ("id"),
  CONSTRAINT incident_amount CHECK ("amount" >= 0)
);
CREATE INDEX "TrustIncident_trustAccountId_kind_idx" ON "TrustIncident"("trustAccountId", "kind");
ALTER TABLE "TrustIncident" ADD CONSTRAINT "TrustIncident_trustAccountId_fkey"
  FOREIGN KEY ("trustAccountId") REFERENCES "TrustAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustIncident" ADD CONSTRAINT "TrustIncident_reconciliationId_fkey"
  FOREIGN KEY ("reconciliationId") REFERENCES "TrustReconciliation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustIncident" ADD CONSTRAINT "TrustIncident_detectedById_fkey"
  FOREIGN KEY ("detectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "TrustIncidentEvent" (
  "id"                UUID NOT NULL,
  "incidentId"        UUID NOT NULL,
  "kind"              "TrustIncidentEventKind" NOT NULL,
  "eventDate"         DATE NOT NULL,
  "amount"            DECIMAL(14, 2),
  "reference"         TEXT,
  "note"              TEXT,
  "reconciliationId"  UUID,
  "bankTransactionId" UUID,
  "actorId"           UUID NOT NULL,
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "TrustIncidentEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT incident_event_evidence CHECK (
    ("kind" NOT IN ('REGISTRAR_NOTIFIED', 'REPLENISHED') OR NULLIF(btrim("reference"), '') IS NOT NULL)
    AND ("kind" <> 'REPLENISHED' OR "amount" > 0)
    AND ("kind" NOT IN ('NOTE', 'RESOLVED') OR NULLIF(btrim("note"), '') IS NOT NULL))
);
CREATE INDEX "TrustIncidentEvent_incidentId_createdAt_idx" ON "TrustIncidentEvent"("incidentId", "createdAt");
ALTER TABLE "TrustIncidentEvent" ADD CONSTRAINT "TrustIncidentEvent_incidentId_fkey"
  FOREIGN KEY ("incidentId") REFERENCES "TrustIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustIncidentEvent" ADD CONSTRAINT "TrustIncidentEvent_reconciliationId_fkey"
  FOREIGN KEY ("reconciliationId") REFERENCES "TrustReconciliation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustIncidentEvent" ADD CONSTRAINT "TrustIncidentEvent_bankTransactionId_fkey"
  FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustIncidentEvent" ADD CONSTRAINT "TrustIncidentEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION trust_incident_is_open(incident UUID) RETURNS boolean AS $$
  SELECT NOT EXISTS (SELECT 1 FROM "TrustIncidentEvent" WHERE "incidentId" = incident AND kind = 'RESOLVED')
$$ LANGUAGE sql STABLE;

CREATE FUNCTION trust_incident_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."detectedAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."detectedById", false, 'recording a trust incident');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trust_incident_before_insert BEFORE INSERT ON "TrustIncident"
  FOR EACH ROW EXECUTE FUNCTION trust_incident_before_insert();

CREATE FUNCTION trust_incident_event_before_insert() RETURNS trigger AS $$
DECLARE
  inc          "TrustIncident"%ROWTYPE;
  replenished  DECIMAL(14, 2);
  worst        DECIMAL(14, 2);
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT * INTO inc FROM "TrustIncident" WHERE id = NEW."incidentId" FOR UPDATE;
  IF NOT trust_incident_is_open(inc.id) THEN
    RAISE EXCEPTION 'BANK_RULE: this incident is resolved' USING ERRCODE = 'ZB001';
  END IF;
  IF NEW.kind IN ('OBSERVED', 'NOTE') THEN
    PERFORM require_bank_staff(NEW."actorId", false, 'adding to a trust incident');
    RETURN NEW;
  END IF;
  PERFORM require_broker_of_record(NEW."actorId", 'Recording regulator notification, replenishment or resolution');
  IF NEW.kind = 'RESOLVED' AND inc.kind = 'SHORTFALL' THEN
    SELECT COALESCE(SUM(amount), 0) INTO replenished FROM "TrustIncidentEvent" WHERE "incidentId" = inc.id AND kind = 'REPLENISHED';
    SELECT GREATEST(inc.amount, COALESCE(MAX(amount), 0)) INTO worst FROM "TrustIncidentEvent" WHERE "incidentId" = inc.id AND kind = 'OBSERVED';
    -- Either the shortfall was reported and made good, or a later balanced reconciliation shows it was a ledger error
    IF NOT (
         (EXISTS (SELECT 1 FROM "TrustIncidentEvent" WHERE "incidentId" = inc.id AND kind = 'REGISTRAR_NOTIFIED') AND replenished >= worst)
         OR (NEW."reconciliationId" IS NOT NULL AND EXISTS (
               SELECT 1 FROM "TrustReconciliation" r WHERE r.id = NEW."reconciliationId" AND r."trustAccountId" = inc."trustAccountId"
                  AND r."isBalanced" AND r."preparedAt" > inc."detectedAt"))) THEN
      RAISE EXCEPTION 'BANK_RULE: a shortfall is resolved only once the registrar has been notified and at least % has been replenished, or a later balanced reconciliation shows there was no shortfall', worst
        USING ERRCODE = 'ZB001';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trust_incident_event_before_insert BEFORE INSERT ON "TrustIncidentEvent"
  FOR EACH ROW EXECUTE FUNCTION trust_incident_event_before_insert();
CREATE TRIGGER trust_incident_immutable BEFORE UPDATE OR DELETE ON "TrustIncident"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER trust_incident_event_immutable BEFORE UPDATE OR DELETE ON "TrustIncidentEvent"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- Reconciliations: monthly statements only; signed by the broker of record, not the preparer;
-- an unbalanced month can be signed on time, but a shortfall must have an incident
CREATE OR REPLACE FUNCTION trust_reconciliation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."preparedAt" := clock_timestamp();
    PERFORM require_bank_staff(NEW."preparedById", false, 'preparing a trust reconciliation');
    IF NEW."signedById" IS NOT NULL THEN
      RAISE EXCEPTION 'BANK_RULE: a reconciliation is signed after it is prepared' USING ERRCODE = 'ZB001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "BankStatement" s WHERE s.id = NEW."statementId" AND s.kind = 'MONTHLY'
                    AND s."trustAccountId" = NEW."trustAccountId" AND s."periodEnd" = NEW."periodEnd") THEN
      RAISE EXCEPTION 'BANK_RULE: reconciliation must be for a monthly statement of this trust account' USING ERRCODE = 'ZB001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR OLD."signedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'APPEND_ONLY: % on a % reconciliation is not allowed', TG_OP,
      CASE WHEN TG_OP = 'DELETE' THEN 'trust' ELSE 'signed' END USING ERRCODE = 'ZD003';
  END IF;
  IF (NEW.id, NEW."trustAccountId", NEW."statementId", NEW."periodEnd", NEW."bankClosingBalance", NEW."outstandingDeposits",
      NEW."outstandingDisbursements", NEW."unrecordedBankItems", NEW."adjustedBankBalance", NEW."ledgerBalance",
      NEW."clientLiabilities", NEW.difference, NEW."isBalanced", NEW.details, NEW.explanation, NEW."preparedById", NEW."preparedAt")
     IS DISTINCT FROM
     (OLD.id, OLD."trustAccountId", OLD."statementId", OLD."periodEnd", OLD."bankClosingBalance", OLD."outstandingDeposits",
      OLD."outstandingDisbursements", OLD."unrecordedBankItems", OLD."adjustedBankBalance", OLD."ledgerBalance",
      OLD."clientLiabilities", OLD.difference, OLD."isBalanced", OLD.details, OLD.explanation, OLD."preparedById", OLD."preparedAt") THEN
    RAISE EXCEPTION 'APPEND_ONLY: a prepared reconciliation can only be signed, not changed' USING ERRCODE = 'ZD003';
  END IF;
  IF NEW."signedById" IS NULL THEN
    RAISE EXCEPTION 'BANK_RULE: nothing to change' USING ERRCODE = 'ZB001';
  END IF;
  PERFORM require_broker_of_record(NEW."signedById", 'Signing a trust reconciliation');
  NEW."signSegregationException" := require_separate_people(NEW."signedById", NEW."preparedById", NEW."signExceptionReason",
    'Signing a reconciliation (the preparer can''t sign their own)');
  NEW."signedAt" := clock_timestamp();
  IF NOT EXISTS (SELECT 1 FROM "BankStatementVerification" v WHERE v."statementId" = NEW."statementId") THEN
    RAISE EXCEPTION 'BANK_RULE: the bank statement must be independently verified before the reconciliation is signed' USING ERRCODE = 'ZB001';
  END IF;
  IF EXISTS (SELECT 1 FROM "TrustReconciliation" r WHERE r."statementId" = NEW."statementId" AND r."preparedAt" > NEW."preparedAt") THEN
    RAISE EXCEPTION 'BANK_RULE: a newer reconciliation was prepared for this statement; sign that one' USING ERRCODE = 'ZB001';
  END IF;
  IF EXISTS (SELECT 1 FROM "BankStatement" s WHERE s."trustAccountId" = NEW."trustAccountId" AND s.kind = 'MONTHLY' AND s."periodEnd" < NEW."periodEnd"
              AND NOT EXISTS (SELECT 1 FROM "TrustReconciliation" r WHERE r."statementId" = s.id AND r."signedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'BANK_RULE: earlier months must be signed first' USING ERRCODE = 'ZB001';
  END IF;
  IF (NEW.difference < 0 OR NEW."ledgerBalance" <> NEW."clientLiabilities") AND NOT EXISTS (
       SELECT 1 FROM "TrustIncident" i WHERE i."trustAccountId" = NEW."trustAccountId" AND i.kind = 'SHORTFALL'
          AND (i."reconciliationId" = NEW.id OR EXISTS (
                SELECT 1 FROM "TrustIncidentEvent" e WHERE e."incidentId" = i.id AND e."reconciliationId" = NEW.id))) THEN
    RAISE EXCEPTION 'BANK_RULE: this reconciliation shows a shortfall with no trust incident recorded' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ── Commission receipts: reversals, totals across CDA revisions ──────────────

CREATE TABLE "CommissionReceiptReversal" (
  "receiptId"    UUID NOT NULL,
  "reason"       TEXT NOT NULL,
  "reversedDate" DATE NOT NULL,
  "reference"    TEXT,
  "actorId"      UUID NOT NULL,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "CommissionReceiptReversal_pkey" PRIMARY KEY ("receiptId"),
  CONSTRAINT receipt_reversal_reason CHECK (btrim("reason") <> '')
);
ALTER TABLE "CommissionReceiptReversal" ADD CONSTRAINT "CommissionReceiptReversal_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "CommissionReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionReceiptReversal" ADD CONSTRAINT "CommissionReceiptReversal_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION receipt_reversal_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."actorId", false, 'reversing a commission receipt');
  PERFORM 1 FROM "ClosingStatement" c JOIN "CommissionReceipt" r ON r."closingId" = c.id WHERE r.id = NEW."receiptId" FOR UPDATE OF c;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER receipt_reversal_before_insert BEFORE INSERT ON "CommissionReceiptReversal"
  FOR EACH ROW EXECUTE FUNCTION receipt_reversal_before_insert();
CREATE TRIGGER receipt_reversal_immutable BEFORE UPDATE OR DELETE ON "CommissionReceiptReversal"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- Receipts count for every revision of a deal's CDA, minus reversals
CREATE OR REPLACE FUNCTION closing_amount_received(closing UUID) RETURNS DECIMAL(12, 2) AS $$
  SELECT COALESCE(SUM(r.amount), 0)::DECIMAL(12, 2)
    FROM "CommissionReceipt" r JOIN "ClosingStatement" c ON c.id = r."closingId"
   WHERE c."transactionId" = (SELECT "transactionId" FROM "ClosingStatement" WHERE id = closing)
     AND NOT EXISTS (SELECT 1 FROM "CommissionReceiptReversal" x WHERE x."receiptId" = r.id)
$$ LANGUAGE sql STABLE;

CREATE FUNCTION closing_receipts_cleared(closing UUID) RETURNS boolean AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM "CommissionReceipt" r JOIN "ClosingStatement" c ON c.id = r."closingId"
     WHERE c."transactionId" = (SELECT "transactionId" FROM "ClosingStatement" WHERE id = closing)
       AND NOT EXISTS (SELECT 1 FROM "CommissionReceiptReversal" x WHERE x."receiptId" = r.id)
       AND NOT receipt_cleared(r.id))
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION commission_receipt_before_insert() RETURNS trigger AS $$
DECLARE
  due      DECIMAL(12, 2);
  received DECIMAL(12, 2);
BEGIN
  NEW."recordedAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."recordedById", false, 'recording commission received');
  PERFORM 1 FROM "ClosingStatement" WHERE id = NEW."closingId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ClosingVoid" v WHERE v."closingId" = NEW."closingId") THEN
    RAISE EXCEPTION 'PAYOUT_RULE: this CDA was voided; record the receipt against the reissued CDA' USING ERRCODE = 'ZD004';
  END IF;
  IF NEW."trustAccountId" IS NOT NULL AND (SELECT kind FROM "TrustAccount" WHERE id = NEW."trustAccountId") <> 'COMMISSION_TRUST' THEN
    RAISE EXCEPTION 'BANK_RULE: commission is received into the operating account or a commission trust account, never the real estate trust account'
      USING ERRCODE = 'ZB001';
  END IF;
  due := closing_amount_due(NEW."closingId");
  received := closing_amount_received(NEW."closingId");
  IF received + NEW.amount > due THEN
    RAISE EXCEPTION 'PAYOUT_RULE: receipts of % would exceed the % due under this closing', received + NEW.amount, due
      USING ERRCODE = 'ZD004';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ── CDA void and reissue ─────────────────────────────────────────────────────

CREATE TABLE "ClosingVoid" (
  "closingId" UUID NOT NULL,
  "reason"    TEXT NOT NULL,
  "actorId"   UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "ClosingVoid_pkey" PRIMARY KEY ("closingId"),
  CONSTRAINT closing_void_reason CHECK (btrim("reason") <> '')
);
ALTER TABLE "ClosingVoid" ADD CONSTRAINT "ClosingVoid_closingId_fkey"
  FOREIGN KEY ("closingId") REFERENCES "ClosingStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClosingVoid" ADD CONSTRAINT "ClosingVoid_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION closing_void_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM 1 FROM "ClosingStatement" WHERE id = NEW."closingId" FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE id = NEW."actorId" AND role = 'MANAGING_BROKER' AND "isActive") THEN
    RAISE EXCEPTION 'CLOSING_UNAUTHORIZED: only an active managing broker can void a CDA' USING ERRCODE = 'ZD002';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER closing_void_before_insert BEFORE INSERT ON "ClosingVoid" FOR EACH ROW EXECUTE FUNCTION closing_void_before_insert();
CREATE TRIGGER closing_void_immutable BEFORE UPDATE OR DELETE ON "ClosingVoid" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

DROP INDEX "ClosingStatement_transactionId_key";
CREATE INDEX "ClosingStatement_transactionId_idx" ON "ClosingStatement"("transactionId");
ALTER TABLE "ClosingStatement"
  ADD COLUMN "revision"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "supersedesId" UUID;
CREATE UNIQUE INDEX "ClosingStatement_supersedesId_key" ON "ClosingStatement"("supersedesId");
CREATE UNIQUE INDEX "ClosingStatement_transactionId_revision_key" ON "ClosingStatement"("transactionId", "revision");
ALTER TABLE "ClosingStatement" ADD CONSTRAINT "ClosingStatement_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES "ClosingStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION closing_statement_before_insert() RETURNS trigger AS $$
DECLARE
  actor_role   "UserRole";
  actor_active boolean;
  latest       "ClosingStatement"%ROWTYPE;
BEGIN
  NEW."finalizedAt" := clock_timestamp();
  SELECT role, "isActive" INTO actor_role, actor_active FROM "User" WHERE id = NEW."finalizedById";
  IF actor_role IS DISTINCT FROM 'MANAGING_BROKER' OR actor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'CLOSING_UNAUTHORIZED: only an active managing broker can finalize a closing'
      USING ERRCODE = 'ZT003';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Transaction" WHERE id = NEW."transactionId" AND status = 'CLOSED') THEN
    RAISE EXCEPTION 'CLOSING_RULE: deal % is not CLOSED', NEW."transactionId" USING ERRCODE = 'ZD001';
  END IF;
  SELECT * INTO latest FROM "ClosingStatement" WHERE "transactionId" = NEW."transactionId" ORDER BY revision DESC LIMIT 1;
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM "ClosingVoid" WHERE "closingId" = latest.id) THEN
      RAISE EXCEPTION 'CLOSING_RULE: this deal already has a finalized CDA; void it before reissuing' USING ERRCODE = 'ZD001';
    END IF;
    IF NEW."supersedesId" IS DISTINCT FROM latest.id OR NEW.revision <> latest.revision + 1 THEN
      RAISE EXCEPTION 'CLOSING_RULE: a reissued CDA must supersede revision %', latest.revision USING ERRCODE = 'ZD001';
    END IF;
  ELSIF NEW."supersedesId" IS NOT NULL OR NEW.revision <> 0 THEN
    RAISE EXCEPTION 'CLOSING_RULE: the first CDA for a deal is revision 0' USING ERRCODE = 'ZD001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- What has already been paid to this payee under voided revisions carries forward
ALTER TABLE "ClosingAgentPayout" ADD COLUMN "carriedForward" DECIMAL(12, 2) NOT NULL DEFAULT 0;

-- ── Third-party payables: co-op brokerages and referrals ─────────────────────

CREATE TYPE "PayableType" AS ENUM ('COOP_BROKERAGE', 'REFERRAL');

CREATE TABLE "ClosingPayable" (
  "id"             UUID NOT NULL,
  "closingId"      UUID NOT NULL,
  "payeeType"      "PayableType" NOT NULL,
  "payeeName"      TEXT NOT NULL,
  "amount"         DECIMAL(12, 2) NOT NULL,
  "hst"            DECIMAL(12, 2) NOT NULL,
  "carriedForward" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  CONSTRAINT "ClosingPayable_pkey" PRIMARY KEY ("id"),
  CONSTRAINT payable_amounts CHECK ("amount" >= 0 AND "hst" >= 0 AND "hst" <= "amount" AND "carriedForward" >= 0)
);
CREATE INDEX "ClosingPayable_closingId_idx" ON "ClosingPayable"("closingId");
ALTER TABLE "ClosingPayable" ADD CONSTRAINT "ClosingPayable_closingId_fkey"
  FOREIGN KEY ("closingId") REFERENCES "ClosingStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TRIGGER closing_payable_immutable BEFORE UPDATE OR DELETE ON "ClosingPayable"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- ── One payout event history ─────────────────────────────────────────────────

DROP TRIGGER agent_payout_event_before_insert ON "AgentPayoutEvent";
DROP TRIGGER agent_payout_event_immutable ON "AgentPayoutEvent";
DROP TRIGGER agent_payout_event_no_truncate ON "AgentPayoutEvent";
DROP FUNCTION agent_payout_event_before_insert();
DROP INDEX "AgentPayoutEvent_payoutId_kind_key";
ALTER TABLE "AgentPayoutEvent" RENAME TO "PayoutEvent";
ALTER TABLE "PayoutEvent" RENAME CONSTRAINT "AgentPayoutEvent_pkey" TO "PayoutEvent_pkey";
ALTER TABLE "PayoutEvent" RENAME CONSTRAINT "AgentPayoutEvent_payoutId_fkey" TO "PayoutEvent_payoutId_fkey";
ALTER TABLE "PayoutEvent" RENAME CONSTRAINT "AgentPayoutEvent_actorId_fkey" TO "PayoutEvent_actorId_fkey";

ALTER TABLE "PayoutEvent"
  ALTER COLUMN "payoutId" DROP NOT NULL,
  ADD COLUMN "payableId"             UUID,
  ADD COLUMN "seq"                   INTEGER,
  ADD COLUMN "amount"                DECIMAL(12, 2),
  ADD COLUMN "payFromTrustAccountId" UUID,
  ADD COLUMN "payFromOperatingAccountId" UUID,
  ADD COLUMN "balanceStatementId"    UUID,
  ADD COLUMN "segregationException"  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "exceptionReason"       TEXT;
UPDATE "PayoutEvent" e SET seq = CASE WHEN e.kind = 'APPROVED' THEN 1 ELSE 2 END,
                           amount = (SELECT p."netPayout" FROM "ClosingAgentPayout" p WHERE p.id = e."payoutId");
ALTER TABLE "PayoutEvent" ALTER COLUMN "seq" SET NOT NULL;
ALTER TABLE "PayoutEvent" ADD CONSTRAINT payout_event_target CHECK (("payoutId" IS NULL) <> ("payableId" IS NULL));
CREATE UNIQUE INDEX "PayoutEvent_payoutId_seq_key" ON "PayoutEvent"("payoutId", "seq");
CREATE UNIQUE INDEX "PayoutEvent_payableId_seq_key" ON "PayoutEvent"("payableId", "seq");
ALTER TABLE "PayoutEvent" ADD CONSTRAINT "PayoutEvent_payableId_fkey"
  FOREIGN KEY ("payableId") REFERENCES "ClosingPayable"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayoutEvent" ADD CONSTRAINT "PayoutEvent_payFromTrustAccountId_fkey"
  FOREIGN KEY ("payFromTrustAccountId") REFERENCES "TrustAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayoutEvent" ADD CONSTRAINT "PayoutEvent_payFromOperatingAccountId_fkey"
  FOREIGN KEY ("payFromOperatingAccountId") REFERENCES "OperatingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayoutEvent" ADD CONSTRAINT "PayoutEvent_balanceStatementId_fkey"
  FOREIGN KEY ("balanceStatementId") REFERENCES "BankStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The current state of a payout or payable is its last event
CREATE FUNCTION payout_last_event(p_payout UUID, p_payable UUID) RETURNS "PayoutEvent" AS $$
  SELECT * FROM "PayoutEvent"
   WHERE ("payoutId" = p_payout OR "payableId" = p_payable)
   ORDER BY seq DESC LIMIT 1
$$ LANGUAGE sql STABLE;

-- The approval currently in force (the last APPROVED, unless cancelled since)
CREATE FUNCTION payout_open_approval(p_payout UUID, p_payable UUID) RETURNS "PayoutEvent" AS $$
  SELECT a.* FROM "PayoutEvent" a
   WHERE (a."payoutId" = p_payout OR a."payableId" = p_payable) AND a.kind = 'APPROVED'
     AND NOT EXISTS (SELECT 1 FROM "PayoutEvent" c WHERE (c."payoutId" = p_payout OR c."payableId" = p_payable)
                      AND c.kind = 'CANCELLED' AND c.seq > a.seq)
   ORDER BY a.seq DESC LIMIT 1
$$ LANGUAGE sql STABLE;

-- Money committed out of an account: approved and not yet paid, or paid since the balance was taken
CREATE FUNCTION account_committed(p_trust UUID, p_operating UUID, since DATE) RETURNS DECIMAL(14, 2) AS $$
  WITH latest AS (
    SELECT DISTINCT ON (COALESCE(e."payoutId", e."payableId")) e.*
      FROM "PayoutEvent" e
     ORDER BY COALESCE(e."payoutId", e."payableId"), e.seq DESC
  ), approval AS (
    SELECT l.*, (SELECT a FROM "PayoutEvent" a WHERE COALESCE(a."payoutId", a."payableId") = COALESCE(l."payoutId", l."payableId")
                  AND a.kind = 'APPROVED' ORDER BY a.seq DESC LIMIT 1) AS ap
      FROM latest l
  )
  SELECT COALESCE(SUM((ap).amount), 0)::DECIMAL(14, 2) FROM approval
   WHERE (ap).id IS NOT NULL
     AND (ap)."payFromTrustAccountId" IS NOT DISTINCT FROM p_trust
     AND (ap)."payFromOperatingAccountId" IS NOT DISTINCT FROM p_operating
     AND (kind IN ('APPROVED', 'PAYMENT_REVERSED') OR (kind = 'PAID' AND "eventDate" >= since))
$$ LANGUAGE sql STABLE;

CREATE FUNCTION payout_event_before_insert() RETURNS trigger AS $$
DECLARE
  actor_role   "UserRole";
  actor_active boolean;
  closing      UUID;
  remaining    DECIMAL(12, 2);
  last_ev      "PayoutEvent";
  approval     "PayoutEvent";
  snapshot     "BankStatement"%ROWTYPE;
  available    DECIMAL(14, 2);
  third_party  boolean := NEW."payableId" IS NOT NULL;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT role, "isActive" INTO actor_role, actor_active FROM "User" WHERE id = NEW."actorId";
  IF third_party THEN
    SELECT "closingId", amount - "carriedForward" INTO closing, remaining FROM "ClosingPayable" WHERE id = NEW."payableId";
  ELSE
    SELECT "closingId", "netPayout" - "carriedForward" INTO closing, remaining FROM "ClosingAgentPayout" WHERE id = NEW."payoutId";
  END IF;
  PERFORM 1 FROM "ClosingStatement" WHERE id = closing FOR UPDATE; -- serializes every event on this closing

  last_ev := payout_last_event(NEW."payoutId", NEW."payableId");
  NEW.seq := COALESCE(last_ev.seq, 0) + 1;

  -- Allowed transitions
  IF NOT (
       (NEW.kind = 'APPROVED' AND (last_ev.kind IS NULL OR last_ev.kind = 'CANCELLED'))
    OR (NEW.kind = 'PAID' AND last_ev.kind IN ('APPROVED', 'PAYMENT_REVERSED'))
    OR (NEW.kind = 'PAYMENT_REVERSED' AND last_ev.kind = 'PAID')
    OR (NEW.kind = 'CANCELLED' AND last_ev.kind IN ('APPROVED', 'PAYMENT_REVERSED'))) THEN
    RAISE EXCEPTION 'PAYOUT_RULE: can''t record % after %', NEW.kind, COALESCE(last_ev.kind::text, 'nothing') USING ERRCODE = 'ZD004';
  END IF;

  IF NEW.kind IN ('APPROVED', 'PAID') AND EXISTS (SELECT 1 FROM "ClosingVoid" WHERE "closingId" = closing) THEN
    RAISE EXCEPTION 'PAYOUT_RULE: this CDA was voided; use the reissued CDA' USING ERRCODE = 'ZD004';
  END IF;
  IF NEW.kind IN ('APPROVED', 'PAID') AND third_party AND NOT policy_enabled('THIRD_PARTY_PAYABLES') THEN
    RAISE EXCEPTION 'POLICY_NOT_APPROVED: co-op and referral payments stay disabled until counsel and the accountant approve how those funds are held'
      USING ERRCODE = 'ZP001';
  END IF;

  IF NEW.kind IN ('APPROVED', 'PAID') THEN
    -- The commission must be in, not reversed, and verified at the bank, at approval and again at payment
    IF closing_amount_received(closing) < closing_amount_due(closing) THEN
      RAISE EXCEPTION 'PAYOUT_RULE: the commission for this closing has not been received in full (% of %)',
        closing_amount_received(closing), closing_amount_due(closing) USING ERRCODE = 'ZD004';
    END IF;
    IF NOT closing_receipts_cleared(closing) THEN
      RAISE EXCEPTION 'FUNDS_NOT_CLEARED: the commission received hasn''t been verified against a bank record'
        USING ERRCODE = 'ZT007';
    END IF;
  END IF;

  IF NEW.kind = 'APPROVED' THEN
    IF actor_role IS DISTINCT FROM 'MANAGING_BROKER' OR actor_active IS NOT TRUE THEN
      RAISE EXCEPTION 'PAYOUT_UNAUTHORIZED: only an active managing broker can approve a payout' USING ERRCODE = 'ZD002';
    END IF;
    -- Whoever recorded or matched the commission can't approve paying it out
    IF EXISTS (SELECT 1 FROM "CommissionReceipt" r JOIN "ClosingStatement" c ON c.id = r."closingId"
                WHERE c."transactionId" = (SELECT "transactionId" FROM "ClosingStatement" WHERE id = closing)
                  AND (r."recordedById" = NEW."actorId"
                       OR EXISTS (SELECT 1 FROM "BankMatch" m WHERE m."commissionReceiptId" = r.id AND m."matchedById" = NEW."actorId"))) THEN
      NEW."segregationException" := require_separate_people(NEW."actorId", NEW."actorId", NEW."exceptionReason",
        'Approving a payout (whoever recorded or matched the commission)');
    END IF;
    IF (NEW."payFromTrustAccountId" IS NULL) = (NEW."payFromOperatingAccountId" IS NULL) THEN
      RAISE EXCEPTION 'PAYOUT_RULE: say which account the payment will come from' USING ERRCODE = 'ZD004';
    END IF;
    IF NEW."payFromTrustAccountId" IS NOT NULL
       AND (SELECT kind FROM "TrustAccount" WHERE id = NEW."payFromTrustAccountId") <> 'COMMISSION_TRUST' THEN
      RAISE EXCEPTION 'PAYOUT_RULE: payouts never come straight from the real estate trust account' USING ERRCODE = 'ZD004';
    END IF;
    NEW.amount := remaining;
    IF remaining <= 0 THEN
      RAISE EXCEPTION 'PAYOUT_RULE: nothing is owed on this payout (already paid % under an earlier CDA)', -remaining USING ERRCODE = 'ZD004';
    END IF;

    -- Funds actually available: a verified bank balance no more than 3 days old, less everything already committed from that account
    PERFORM pg_advisory_xact_lock(hashtext('payout-account:' || COALESCE(NEW."payFromTrustAccountId", NEW."payFromOperatingAccountId")::text));
    SELECT s.* INTO snapshot FROM "BankStatement" s JOIN "BankStatementVerification" v ON v."statementId" = s.id
     WHERE s.id = NEW."balanceStatementId"
       AND s."trustAccountId" IS NOT DISTINCT FROM NEW."payFromTrustAccountId"
       AND s."operatingAccountId" IS NOT DISTINCT FROM NEW."payFromOperatingAccountId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'FUNDS_NOT_AVAILABLE: approval needs a verified bank balance for the paying account' USING ERRCODE = 'ZT008';
    END IF;
    IF snapshot."periodEnd" < NEW."eventDate" - 3 THEN
      RAISE EXCEPTION 'FUNDS_NOT_AVAILABLE: the latest verified balance is from %; import today''s bank balance first', snapshot."periodEnd"
        USING ERRCODE = 'ZT008';
    END IF;
    IF EXISTS (SELECT 1 FROM "BankStatement" s JOIN "BankStatementVerification" v ON v."statementId" = s.id
                WHERE s."trustAccountId" IS NOT DISTINCT FROM NEW."payFromTrustAccountId"
                  AND s."operatingAccountId" IS NOT DISTINCT FROM NEW."payFromOperatingAccountId"
                  AND (s."periodEnd", s."importedAt") > (snapshot."periodEnd", snapshot."importedAt")) THEN
      RAISE EXCEPTION 'FUNDS_NOT_AVAILABLE: a newer verified balance exists for this account; use it' USING ERRCODE = 'ZT008';
    END IF;
    available := snapshot."closingBalance" - account_committed(NEW."payFromTrustAccountId", NEW."payFromOperatingAccountId", snapshot."periodEnd");
    IF available < NEW.amount THEN
      RAISE EXCEPTION 'FUNDS_NOT_AVAILABLE: % is available in the paying account after other approved payments; % was requested', available, NEW.amount
        USING ERRCODE = 'ZT008';
    END IF;
    -- A commission trust account holds each closing's money separately
    IF NEW."payFromTrustAccountId" IS NOT NULL AND (
         SELECT COALESCE(SUM(r.amount), 0) FROM "CommissionReceipt" r JOIN "ClosingStatement" c ON c.id = r."closingId"
          WHERE c."transactionId" = (SELECT "transactionId" FROM "ClosingStatement" WHERE id = closing)
            AND r."trustAccountId" = NEW."payFromTrustAccountId"
            AND NOT EXISTS (SELECT 1 FROM "CommissionReceiptReversal" x WHERE x."receiptId" = r.id))
       < NEW.amount + (
         SELECT COALESCE(SUM((payout_open_approval(p."payoutId", p."payableId")).amount), 0) FROM (
           SELECT id AS "payoutId", NULL::uuid AS "payableId" FROM "ClosingAgentPayout" WHERE "closingId" = closing
           UNION ALL SELECT NULL::uuid, id FROM "ClosingPayable" WHERE "closingId" = closing) p
          WHERE (payout_open_approval(p."payoutId", p."payableId"))."payFromTrustAccountId" = NEW."payFromTrustAccountId") THEN
      RAISE EXCEPTION 'FUNDS_NOT_AVAILABLE: this closing''s money in the commission trust account doesn''t cover the payout' USING ERRCODE = 'ZT008';
    END IF;

  ELSIF NEW.kind = 'PAID' THEN
    IF actor_role NOT IN ('ADMIN', 'MANAGING_BROKER') OR actor_active IS NOT TRUE THEN
      RAISE EXCEPTION 'PAYOUT_UNAUTHORIZED: only an active admin or managing broker can record a payment' USING ERRCODE = 'ZD002';
    END IF;
    approval := payout_open_approval(NEW."payoutId", NEW."payableId");
    NEW."segregationException" := require_separate_people(NEW."actorId", approval."actorId", NEW."exceptionReason",
      'Recording the payment (the approver can''t also release it)');
    NEW.amount := approval.amount;
    NEW."payFromTrustAccountId" := approval."payFromTrustAccountId";
    NEW."payFromOperatingAccountId" := approval."payFromOperatingAccountId";

  ELSIF NEW.kind = 'PAYMENT_REVERSED' THEN
    IF actor_role NOT IN ('ADMIN', 'MANAGING_BROKER') OR actor_active IS NOT TRUE THEN
      RAISE EXCEPTION 'PAYOUT_UNAUTHORIZED: only an active admin or managing broker can record a returned payment' USING ERRCODE = 'ZD002';
    END IF;
    IF NULLIF(btrim(NEW.reference), '') IS NULL OR NULLIF(btrim(NEW.note), '') IS NULL THEN
      RAISE EXCEPTION 'PAYOUT_RULE: a returned payment needs the bank reference and the reason' USING ERRCODE = 'ZD004';
    END IF;
    NEW.amount := last_ev.amount;

  ELSE -- CANCELLED
    IF actor_role IS DISTINCT FROM 'MANAGING_BROKER' OR actor_active IS NOT TRUE THEN
      RAISE EXCEPTION 'PAYOUT_UNAUTHORIZED: only an active managing broker can cancel an approval' USING ERRCODE = 'ZD002';
    END IF;
    IF NULLIF(btrim(NEW.note), '') IS NULL THEN
      RAISE EXCEPTION 'PAYOUT_RULE: say why the approval is cancelled' USING ERRCODE = 'ZD004';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER payout_event_before_insert BEFORE INSERT ON "PayoutEvent" FOR EACH ROW EXECUTE FUNCTION payout_event_before_insert();
CREATE TRIGGER payout_event_immutable BEFORE UPDATE OR DELETE ON "PayoutEvent" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER payout_event_no_truncate BEFORE TRUNCATE ON "PayoutEvent" FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

-- Match removal also has to respect the new event table
CREATE OR REPLACE FUNCTION bank_match_before_delete() RETURNS trigger AS $$
DECLARE
  entry   "TrustLedgerEntry"%ROWTYPE;
  account UUID;
  covered DATE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: UPDATE on BankMatch is not allowed; remove the match and match again' USING ERRCODE = 'ZD003';
  END IF;
  IF OLD.basis = 'PRE_CUTOVER' THEN
    RAISE EXCEPTION 'BANK_RULE: a pre-cutover attestation can''t be removed' USING ERRCODE = 'ZB001';
  END IF;
  IF OLD."trustEntryId" IS NOT NULL THEN
    SELECT * INTO entry FROM "TrustLedgerEntry" WHERE id = OLD."trustEntryId";
    account := entry."trustAccountId";
    IF EXISTS (SELECT 1 FROM "TrustLedgerEntry" e
                WHERE e."transactionId" = entry."transactionId" AND e.direction = -1
                  AND e."entryType" <> 'REVERSAL' AND e."createdAt" > OLD."matchedAt") THEN
      RAISE EXCEPTION 'BANK_RULE: funds have already been paid out against this match' USING ERRCODE = 'ZB001';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM "PayoutEvent" ev
                 LEFT JOIN "ClosingAgentPayout" p ON p.id = ev."payoutId"
                 LEFT JOIN "ClosingPayable" q ON q.id = ev."payableId"
                 JOIN "ClosingStatement" c ON c.id = COALESCE(p."closingId", q."closingId")
                 JOIN "CommissionReceipt" r ON r.id = OLD."commissionReceiptId"
                 JOIN "ClosingStatement" rc ON rc.id = r."closingId"
                WHERE c."transactionId" = rc."transactionId" AND ev.kind = 'APPROVED' AND ev."createdAt" > OLD."matchedAt") THEN
      RAISE EXCEPTION 'BANK_RULE: payouts have already been approved against this receipt' USING ERRCODE = 'ZB001';
    END IF;
  END IF;
  IF account IS NOT NULL THEN
    SELECT MAX(r."periodEnd") INTO covered FROM "TrustReconciliation" r
     WHERE r."trustAccountId" = account AND r."signedAt" IS NOT NULL;
    IF covered IS NOT NULL AND EXISTS (SELECT 1 FROM "BankTransaction" t WHERE t.id = OLD."bankTransactionId" AND t."postedDate" <= covered) THEN
      RAISE EXCEPTION 'BANK_RULE: this match is part of a signed reconciliation (to %)', covered USING ERRCODE = 'ZB001';
    END IF;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

-- ── Restricted application role ──────────────────────────────────────────────
-- The application should connect as a login role that is a member of
-- zareh_app, never as the table owner: it can't disable triggers, alter
-- tables, truncate, or update and delete the financial record.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zareh_app') THEN
    CREATE ROLE zareh_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO zareh_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO zareh_app;
REVOKE UPDATE ON
  "TrustLedgerEntry", "ClosingStatement", "ClosingAgentPayout", "ClosingPayable", "ClosingVoid",
  "CommissionReceipt", "CommissionReceiptReversal", "PayoutEvent",
  "BankStatement", "BankTransaction", "BankStatementVerification", "BankMatch",
  "TrustIncident", "TrustIncidentEvent", "FinancialPolicyDecision", "TrustReconciliation", "BrokerOfRecordDesignation",
  "DocumentFile", "DocumentReview"
  FROM zareh_app;
GRANT UPDATE ("signedById", "signedAt", "signatureNote", "signSegregationException", "signExceptionReason")
  ON "TrustReconciliation" TO zareh_app;
GRANT UPDATE ("effectiveTo") ON "BrokerOfRecordDesignation" TO zareh_app;
GRANT DELETE ON "BankMatch" TO zareh_app;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM zareh_app;

COMMIT;
