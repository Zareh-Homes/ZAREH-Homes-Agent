-- 008 – Bank statements, cleared funds and monthly trust reconciliation
--
--   • BankStatement / BankTransaction: monthly statements imported from the
--     bank's CSV, for the trust account or the brokerage's operating
--     (general) account. Consecutive periods only, each opening balance must
--     equal the previous closing balance, and the lines must add up.
--     Append-only.
--   • BankMatch: evidence that a ledger entry (or a commission receipt) went
--     through the bank: a statement line of the same account and amount.
--     PRE_CUTOVER lets a managing broker attest to history from before the
--     first imported statement (the Lone Wolf migration).
--   • Cleared funds: money can only leave trust against deposits that have
--     been matched to the bank. A recorded deposit is not proof of money.
--     Agent payouts can only be approved once the commission receipt is
--     matched to the operating account.
--   • TrustReconciliation (replaces the unused v1 table): the monthly
--     reconciliation of O. Reg. 579/05 s.13. The bank's balance adjusted for
--     outstanding items, against the ledger, against the total owed to each
--     deal. Prepared by admin, signed by an active managing broker. Frozen
--     once signed.
--
-- New SQLSTATEs: ZT007 funds not cleared; ZB001 bank / reconciliation rule.
--
-- Applies on top of 007.

BEGIN;

-- ── Accounts ─────────────────────────────────────────────────────────────────

CREATE TABLE "OperatingAccount" (
  "id"           UUID NOT NULL,
  "name"         TEXT NOT NULL,
  "bankName"     TEXT NOT NULL,
  "accountLast4" TEXT NOT NULL,
  "isActive"     BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "OperatingAccount_pkey" PRIMARY KEY ("id")
);

CREATE FUNCTION require_bank_staff(actor UUID, broker_only boolean, action TEXT) RETURNS void AS $$
DECLARE
  actor_role   "UserRole";
  actor_active boolean;
BEGIN
  SELECT role, "isActive" INTO actor_role, actor_active FROM "User" WHERE id = actor;
  IF actor_active IS NOT TRUE
     OR (broker_only AND actor_role <> 'MANAGING_BROKER')
     OR (NOT broker_only AND actor_role NOT IN ('ADMIN', 'MANAGING_BROKER')) THEN
    RAISE EXCEPTION 'BANK_UNAUTHORIZED: % requires an active %', action,
      CASE WHEN broker_only THEN 'managing broker' ELSE 'admin or managing broker' END USING ERRCODE = 'ZD002';
  END IF;
END $$ LANGUAGE plpgsql;

-- ── Statements ───────────────────────────────────────────────────────────────

CREATE TABLE "BankStatement" (
  "id"                 UUID NOT NULL,
  "trustAccountId"     UUID,
  "operatingAccountId" UUID,
  "periodStart"        DATE NOT NULL,
  "periodEnd"          DATE NOT NULL,
  "openingBalance"     DECIMAL(14, 2) NOT NULL,
  "closingBalance"     DECIMAL(14, 2) NOT NULL,
  "fileName"           TEXT NOT NULL,
  "fileSha256"         TEXT NOT NULL,
  "importedById"       UUID NOT NULL,
  "importedAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT statement_one_account CHECK (("trustAccountId" IS NULL) <> ("operatingAccountId" IS NULL)),
  CONSTRAINT statement_period CHECK ("periodEnd" >= "periodStart")
);
CREATE INDEX "BankStatement_trustAccountId_periodEnd_idx" ON "BankStatement"("trustAccountId", "periodEnd");
CREATE INDEX "BankStatement_operatingAccountId_periodEnd_idx" ON "BankStatement"("operatingAccountId", "periodEnd");
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_trustAccountId_fkey"
  FOREIGN KEY ("trustAccountId") REFERENCES "TrustAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_operatingAccountId_fkey"
  FOREIGN KEY ("operatingAccountId") REFERENCES "OperatingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_importedById_fkey"
  FOREIGN KEY ("importedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "BankTransaction" (
  "id"          UUID NOT NULL,
  "statementId" UUID NOT NULL,
  "lineNumber"  INTEGER NOT NULL,
  "postedDate"  DATE NOT NULL,
  "amount"      DECIMAL(14, 2) NOT NULL,
  "description" TEXT NOT NULL,
  "reference"   TEXT,
  CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT bank_line_nonzero CHECK ("amount" <> 0)
);
CREATE UNIQUE INDEX "BankTransaction_statementId_lineNumber_key" ON "BankTransaction"("statementId", "lineNumber");
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_statementId_fkey"
  FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION bank_statement_before_insert() RETURNS trigger AS $$
DECLARE
  prev "BankStatement"%ROWTYPE;
BEGIN
  NEW."importedAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."importedById", false, 'importing a bank statement');
  -- One import at a time per account
  PERFORM pg_advisory_xact_lock(hashtext('bank-statement:' || COALESCE(NEW."trustAccountId", NEW."operatingAccountId")::text));
  SELECT * INTO prev FROM "BankStatement"
   WHERE "trustAccountId" IS NOT DISTINCT FROM NEW."trustAccountId"
     AND "operatingAccountId" IS NOT DISTINCT FROM NEW."operatingAccountId"
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

CREATE TRIGGER bank_statement_before_insert
  BEFORE INSERT ON "BankStatement" FOR EACH ROW EXECUTE FUNCTION bank_statement_before_insert();

-- Checked at commit, after the lines are in
CREATE FUNCTION bank_statement_balances() RETURNS trigger AS $$
DECLARE
  lines DECIMAL(14, 2);
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO lines FROM "BankTransaction" WHERE "statementId" = NEW.id;
  IF NEW."openingBalance" + lines <> NEW."closingBalance" THEN
    RAISE EXCEPTION 'BANK_RULE: opening % + transactions % = %, but the statement closes at %',
      NEW."openingBalance", lines, NEW."openingBalance" + lines, NEW."closingBalance" USING ERRCODE = 'ZB001';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER bank_statement_balances
  AFTER INSERT ON "BankStatement" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bank_statement_balances();

CREATE FUNCTION bank_transaction_before_insert() RETURNS trigger AS $$
DECLARE
  s "BankStatement"%ROWTYPE;
BEGIN
  SELECT * INTO s FROM "BankStatement" WHERE id = NEW."statementId";
  IF NEW."postedDate" < s."periodStart" OR NEW."postedDate" > s."periodEnd" THEN
    RAISE EXCEPTION 'BANK_RULE: line % is dated %, outside the statement period % to %',
      NEW."lineNumber", NEW."postedDate", s."periodStart", s."periodEnd" USING ERRCODE = 'ZB001';
  END IF;
  IF s."importedAt" < clock_timestamp() - interval '1 hour' THEN
    RAISE EXCEPTION 'BANK_RULE: lines can only be added when the statement is imported' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER bank_transaction_before_insert
  BEFORE INSERT ON "BankTransaction" FOR EACH ROW EXECUTE FUNCTION bank_transaction_before_insert();

CREATE TRIGGER bank_statement_immutable BEFORE UPDATE OR DELETE ON "BankStatement"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER bank_statement_no_truncate BEFORE TRUNCATE ON "BankStatement"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER bank_transaction_immutable BEFORE UPDATE OR DELETE ON "BankTransaction"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER bank_transaction_no_truncate BEFORE TRUNCATE ON "BankTransaction"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

-- ── Matches ──────────────────────────────────────────────────────────────────

CREATE TYPE "ClearanceBasis" AS ENUM ('BANK_STATEMENT', 'PRE_CUTOVER');

CREATE TABLE "BankMatch" (
  "id"                  UUID NOT NULL,
  "basis"               "ClearanceBasis" NOT NULL,
  "bankTransactionId"   UUID,
  "trustEntryId"        UUID,
  "commissionReceiptId" UUID,
  "note"                TEXT,
  "matchedById"         UUID NOT NULL,
  "matchedAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "BankMatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT match_one_target CHECK (("trustEntryId" IS NULL) <> ("commissionReceiptId" IS NULL)),
  CONSTRAINT match_basis CHECK (
    ("basis" = 'BANK_STATEMENT' AND "bankTransactionId" IS NOT NULL)
    OR ("basis" = 'PRE_CUTOVER' AND "bankTransactionId" IS NULL AND "trustEntryId" IS NOT NULL
        AND NULLIF(btrim("note"), '') IS NOT NULL))
);
CREATE UNIQUE INDEX "BankMatch_bankTransactionId_key" ON "BankMatch"("bankTransactionId");
CREATE UNIQUE INDEX "BankMatch_trustEntryId_key" ON "BankMatch"("trustEntryId");
CREATE UNIQUE INDEX "BankMatch_commissionReceiptId_key" ON "BankMatch"("commissionReceiptId");
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_bankTransactionId_fkey"
  FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_trustEntryId_fkey"
  FOREIGN KEY ("trustEntryId") REFERENCES "TrustLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_commissionReceiptId_fkey"
  FOREIGN KEY ("commissionReceiptId") REFERENCES "CommissionReceipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_matchedById_fkey"
  FOREIGN KEY ("matchedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION bank_match_before_insert() RETURNS trigger AS $$
DECLARE
  line    "BankTransaction"%ROWTYPE;
  stmt    "BankStatement"%ROWTYPE;
  entry   "TrustLedgerEntry"%ROWTYPE;
  receipt "CommissionReceipt"%ROWTYPE;
  first_period DATE;
BEGIN
  NEW."matchedAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."matchedById", NEW.basis = 'PRE_CUTOVER',
    CASE WHEN NEW.basis = 'PRE_CUTOVER' THEN 'attesting to pre-cutover history' ELSE 'matching a bank transaction' END);

  IF NEW."trustEntryId" IS NOT NULL THEN
    SELECT * INTO entry FROM "TrustLedgerEntry" WHERE id = NEW."trustEntryId";
    PERFORM 1 FROM "Transaction" WHERE id = entry."transactionId" FOR UPDATE; -- same lock as ledger writes
  ELSE
    SELECT * INTO receipt FROM "CommissionReceipt" WHERE id = NEW."commissionReceiptId";
  END IF;

  IF NEW.basis = 'PRE_CUTOVER' THEN
    SELECT MIN("periodStart") INTO first_period FROM "BankStatement" WHERE "trustAccountId" = entry."trustAccountId";
    IF first_period IS NOT NULL AND entry."effectiveDate" >= first_period THEN
      RAISE EXCEPTION 'BANK_RULE: entry dated % is covered by imported statements (from %); match it to a statement line',
        entry."effectiveDate", first_period USING ERRCODE = 'ZB001';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO line FROM "BankTransaction" WHERE id = NEW."bankTransactionId";
  SELECT * INTO stmt FROM "BankStatement" WHERE id = line."statementId";
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
    IF stmt."operatingAccountId" IS NULL THEN
      RAISE EXCEPTION 'BANK_RULE: commission receipts match to the operating account, not trust' USING ERRCODE = 'ZB001';
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

CREATE TRIGGER bank_match_before_insert
  BEFORE INSERT ON "BankMatch" FOR EACH ROW EXECUTE FUNCTION bank_match_before_insert();

-- A wrong match can be undone, but not once money has moved on the strength of
-- it, and not inside a signed reconciliation
CREATE FUNCTION bank_match_before_delete() RETURNS trigger AS $$
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
    IF EXISTS (SELECT 1 FROM "AgentPayoutEvent" ev JOIN "ClosingAgentPayout" p ON p.id = ev."payoutId"
                JOIN "CommissionReceipt" r ON r."closingId" = p."closingId"
                WHERE r.id = OLD."commissionReceiptId" AND ev.kind = 'APPROVED') THEN
      RAISE EXCEPTION 'BANK_RULE: agent payouts have already been approved against this receipt' USING ERRCODE = 'ZB001';
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

-- ── Reconciliation ───────────────────────────────────────────────────────────

DROP TABLE "TrustReconciliation";

CREATE TABLE "TrustReconciliation" (
  "id"                       UUID NOT NULL,
  "trustAccountId"           UUID NOT NULL,
  "statementId"              UUID NOT NULL,
  "periodEnd"                DATE NOT NULL,
  "bankClosingBalance"       DECIMAL(14, 2) NOT NULL,
  "outstandingDeposits"      DECIMAL(14, 2) NOT NULL,
  "outstandingDisbursements" DECIMAL(14, 2) NOT NULL,
  "unrecordedBankItems"      DECIMAL(14, 2) NOT NULL,
  "adjustedBankBalance"      DECIMAL(14, 2) NOT NULL,
  "ledgerBalance"            DECIMAL(14, 2) NOT NULL,
  "clientLiabilities"        DECIMAL(14, 2) NOT NULL,
  "difference"               DECIMAL(14, 2) NOT NULL,
  "isBalanced"               BOOLEAN NOT NULL,
  "details"                  JSONB NOT NULL,
  "explanation"              TEXT,
  "preparedById"             UUID NOT NULL,
  "preparedAt"               TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "signedById"               UUID,
  "signedAt"                 TIMESTAMPTZ(6),
  "signatureNote"            TEXT,
  CONSTRAINT "TrustReconciliation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT recon_signed_together CHECK (("signedById" IS NULL) = ("signedAt" IS NULL)),
  CONSTRAINT recon_balanced_matches CHECK ("isBalanced" = ("difference" = 0 AND "ledgerBalance" = "clientLiabilities")),
  CONSTRAINT recon_exception_explained CHECK ("signedAt" IS NULL OR "isBalanced" OR NULLIF(btrim("explanation"), '') IS NOT NULL)
);
CREATE INDEX "TrustReconciliation_trustAccountId_periodEnd_idx" ON "TrustReconciliation"("trustAccountId", "periodEnd");
CREATE UNIQUE INDEX "TrustReconciliation_signed_statement_key" ON "TrustReconciliation"("statementId") WHERE "signedAt" IS NOT NULL;
ALTER TABLE "TrustReconciliation" ADD CONSTRAINT "TrustReconciliation_trustAccountId_fkey"
  FOREIGN KEY ("trustAccountId") REFERENCES "TrustAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustReconciliation" ADD CONSTRAINT "TrustReconciliation_statementId_fkey"
  FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustReconciliation" ADD CONSTRAINT "TrustReconciliation_preparedById_fkey"
  FOREIGN KEY ("preparedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustReconciliation" ADD CONSTRAINT "TrustReconciliation_signedById_fkey"
  FOREIGN KEY ("signedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER bank_match_before_delete
  BEFORE UPDATE OR DELETE ON "BankMatch" FOR EACH ROW EXECUTE FUNCTION bank_match_before_delete();

CREATE FUNCTION trust_reconciliation_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."preparedAt" := clock_timestamp();
    PERFORM require_bank_staff(NEW."preparedById", false, 'preparing a trust reconciliation');
    IF NEW."signedById" IS NOT NULL THEN
      RAISE EXCEPTION 'BANK_RULE: a reconciliation is signed after it is prepared' USING ERRCODE = 'ZB001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "BankStatement" s WHERE s.id = NEW."statementId"
                    AND s."trustAccountId" = NEW."trustAccountId" AND s."periodEnd" = NEW."periodEnd") THEN
      RAISE EXCEPTION 'BANK_RULE: reconciliation must be for a statement of this trust account' USING ERRCODE = 'ZB001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR OLD."signedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'APPEND_ONLY: % on a % reconciliation is not allowed', TG_OP,
      CASE WHEN TG_OP = 'DELETE' THEN 'trust' ELSE 'signed' END USING ERRCODE = 'ZD003';
  END IF;
  -- Only signing is allowed: every computed field stays as prepared
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
  PERFORM require_bank_staff(NEW."signedById", true, 'signing a trust reconciliation');
  NEW."signedAt" := clock_timestamp();
  IF EXISTS (SELECT 1 FROM "TrustReconciliation" r WHERE r."statementId" = NEW."statementId" AND r."preparedAt" > NEW."preparedAt") THEN
    RAISE EXCEPTION 'BANK_RULE: a newer reconciliation was prepared for this statement; sign that one' USING ERRCODE = 'ZB001';
  END IF;
  IF EXISTS (SELECT 1 FROM "BankStatement" s WHERE s."trustAccountId" = NEW."trustAccountId" AND s."periodEnd" < NEW."periodEnd"
              AND NOT EXISTS (SELECT 1 FROM "TrustReconciliation" r WHERE r."statementId" = s.id AND r."signedAt" IS NOT NULL)) THEN
    RAISE EXCEPTION 'BANK_RULE: earlier months must be signed first' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trust_reconciliation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "TrustReconciliation" FOR EACH ROW EXECUTE FUNCTION trust_reconciliation_guard();
CREATE TRIGGER trust_reconciliation_no_truncate BEFORE TRUNCATE ON "TrustReconciliation"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

-- ── Cleared funds ────────────────────────────────────────────────────────────

-- Money on a deal that has actually gone through the bank: deposits count only
-- once matched (and not reversed); everything paid out counts in full
CREATE FUNCTION trust_cleared_balance(deal UUID, account UUID) RETURNS DECIMAL(14, 2) AS $$
  SELECT COALESCE(SUM(CASE
           WHEN e."entryType" = 'DEPOSIT_RECEIVED' THEN
             CASE WHEN EXISTS (SELECT 1 FROM "BankMatch" m WHERE m."trustEntryId" = e.id)
                   AND NOT EXISTS (SELECT 1 FROM "TrustLedgerEntry" r WHERE r."reversesEntryId" = e.id)
                  THEN e.amount ELSE 0 END
           WHEN e."entryType" = 'REVERSAL' AND EXISTS (
                  SELECT 1 FROM "TrustLedgerEntry" o WHERE o.id = e."reversesEntryId" AND o."entryType" = 'DEPOSIT_RECEIVED') THEN 0
           ELSE e.amount * e.direction END), 0)::DECIMAL(14, 2)
    FROM "TrustLedgerEntry" e
   WHERE e."transactionId" = deal AND e."trustAccountId" = account
$$ LANGUAGE sql STABLE;

CREATE FUNCTION trust_ledger_cleared_funds() RETURNS trigger AS $$
DECLARE
  cleared DECIMAL(14, 2);
BEGIN
  IF NEW.direction = -1 AND NEW."entryType" <> 'REVERSAL' THEN
    cleared := trust_cleared_balance(NEW."transactionId", NEW."trustAccountId");
    IF cleared - NEW.amount < 0 THEN
      RAISE EXCEPTION 'FUNDS_NOT_CLEARED: only % of this deal''s trust money has cleared the bank; % was requested',
        cleared, NEW.amount USING ERRCODE = 'ZT007';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Named to fire after trust_ledger_before_insert, which sets the direction
CREATE TRIGGER trust_ledger_zz_cleared_funds
  BEFORE INSERT ON "TrustLedgerEntry" FOR EACH ROW EXECUTE FUNCTION trust_ledger_cleared_funds();

-- Agent payouts: the commission receipts must be matched to the operating account
CREATE OR REPLACE FUNCTION agent_payout_event_before_insert() RETURNS trigger AS $$
DECLARE
  actor_role   "UserRole";
  actor_active boolean;
  closing      UUID;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT role, "isActive" INTO actor_role, actor_active FROM "User" WHERE id = NEW."actorId";
  SELECT "closingId" INTO closing FROM "ClosingAgentPayout" WHERE id = NEW."payoutId" FOR UPDATE;

  IF NEW.kind = 'APPROVED' THEN
    IF actor_role IS DISTINCT FROM 'MANAGING_BROKER' OR actor_active IS NOT TRUE THEN
      RAISE EXCEPTION 'PAYOUT_UNAUTHORIZED: only an active managing broker can approve an agent payout'
        USING ERRCODE = 'ZD002';
    END IF;
    IF closing_amount_received(closing) < closing_amount_due(closing) THEN
      RAISE EXCEPTION 'PAYOUT_RULE: the commission for this closing has not been received in full (% of %)',
        closing_amount_received(closing), closing_amount_due(closing) USING ERRCODE = 'ZD004';
    END IF;
    IF EXISTS (SELECT 1 FROM "CommissionReceipt" r WHERE r."closingId" = closing
                AND NOT EXISTS (SELECT 1 FROM "BankMatch" m WHERE m."commissionReceiptId" = r.id)) THEN
      RAISE EXCEPTION 'FUNDS_NOT_CLEARED: the commission received hasn''t been matched to the operating account statement'
        USING ERRCODE = 'ZT007';
    END IF;
  ELSE
    IF actor_role NOT IN ('ADMIN', 'MANAGING_BROKER') OR actor_active IS NOT TRUE THEN
      RAISE EXCEPTION 'PAYOUT_UNAUTHORIZED: only an active admin or managing broker can record a payment'
        USING ERRCODE = 'ZD002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "AgentPayoutEvent" WHERE "payoutId" = NEW."payoutId" AND kind = 'APPROVED') THEN
      RAISE EXCEPTION 'PAYOUT_RULE: a payout must be approved before it is paid' USING ERRCODE = 'ZD004';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER operating_account_no_delete BEFORE DELETE ON "OperatingAccount"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

COMMIT;
