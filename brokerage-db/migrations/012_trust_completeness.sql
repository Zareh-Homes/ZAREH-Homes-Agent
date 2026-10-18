-- 012 – Trust completeness
--
--   • ProclaimedHoliday: days proclaimed as public holidays (Legislation Act s.87),
--     entered by the broker of record with the proclamation reference. The
--     statutory holidays are generated in code (backend/src/lib/ontario-calendar.ts).
--   • Shortfall cause and the RECO Bulletin 8.2 service-fee exception: a
--     shortfall caused solely by financial institution service fees and
--     eliminated as soon as it is discovered can be resolved without a
--     registrar notice. The cause is a broker-of-record decision backed by the
--     bank lines; it is never inferred.
--   • Amended reconciliations: a signed reconciliation is never changed. A
--     correction is a new reconciliation that names the one it supersedes and why.
--   • Statement integrity: interim bank records that are missing from, or
--     differ from, the monthly statement are flagged at import, and the
--     verifier must say how each was resolved.
--   • Commission trust account ledger and reconciliation, behind the
--     COMMISSION_TRUST_ACCOUNT policy (the legal basis is unverified).
--   • Bank matches for payments and returned receipts: a payment matched to a
--     bank line is independently confirmed.
--   • Unclaimed trust money register (TRESA s.27(4); RECO Bulletin 8.1).
--     Remitting to RECO is a policy-gated record of a payment made outside this
--     system; nothing is sent.
--
-- Applies on top of 011.

ALTER TYPE "TrustIncidentEventKind" ADD VALUE IF NOT EXISTS 'CAUSE_DETERMINED';

BEGIN;

-- ── Policies ─────────────────────────────────────────────────────────────────

ALTER TABLE "FinancialPolicyDecision" DROP CONSTRAINT policy_known;
ALTER TABLE "FinancialPolicyDecision" ADD CONSTRAINT policy_known CHECK ("policy" IN (
  'SOLE_OPERATOR_EXCEPTION', 'THIRD_PARTY_PAYABLES', 'COMMISSION_TRUST_ACCOUNT', 'CIVIC_HOLIDAY_IS_HOLIDAY',
  'UNCLAIMED_MONEY_REMITTANCE'));

-- ── Proclaimed holidays ──────────────────────────────────────────────────────

CREATE TABLE "ProclaimedHoliday" (
  "date"      DATE NOT NULL,
  "name"      TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "addedById" UUID NOT NULL,
  "addedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "ProclaimedHoliday_pkey" PRIMARY KEY ("date"),
  CONSTRAINT proclaimed_text CHECK (btrim("name") <> '' AND btrim("reference") <> '')
);
ALTER TABLE "ProclaimedHoliday" ADD CONSTRAINT "ProclaimedHoliday_addedById_fkey"
  FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION proclaimed_holiday_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."addedAt" := clock_timestamp();
  PERFORM require_broker_of_record(NEW."addedById", 'Adding a proclaimed holiday');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER proclaimed_holiday_before_insert BEFORE INSERT ON "ProclaimedHoliday"
  FOR EACH ROW EXECUTE FUNCTION proclaimed_holiday_before_insert();
CREATE TRIGGER proclaimed_holiday_immutable BEFORE UPDATE OR DELETE ON "ProclaimedHoliday"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- ── Shortfall cause and the service-fee exception ────────────────────────────

ALTER TABLE "TrustIncidentEvent" ADD COLUMN "cause" TEXT;
ALTER TABLE "TrustIncidentEvent" ADD CONSTRAINT incident_cause CHECK (
  ("kind" = 'CAUSE_DETERMINED') = ("cause" IS NOT NULL)
  AND ("cause" IS NULL OR "cause" IN ('BANK_SERVICE_FEE', 'OTHER'))
  AND ("cause" IS DISTINCT FROM 'BANK_SERVICE_FEE' OR "bankTransactionId" IS NOT NULL)
  AND ("kind" <> 'CAUSE_DETERMINED' OR NULLIF(btrim("note"), '') IS NOT NULL));

-- Total of the bank fee lines a broker has attributed the shortfall to; NULL if any other cause was recorded
CREATE FUNCTION incident_fee_total(incident UUID) RETURNS DECIMAL(14, 2) AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM "TrustIncidentEvent" WHERE "incidentId" = incident AND cause = 'OTHER') THEN NULL
              ELSE (SELECT COALESCE(SUM(-b.amount), 0) FROM "TrustIncidentEvent" e JOIN "BankTransaction" b ON b.id = e."bankTransactionId"
                     WHERE e."incidentId" = incident AND e.cause = 'BANK_SERVICE_FEE') END
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION trust_incident_event_before_insert() RETURNS trigger AS $$
DECLARE
  inc          "TrustIncident"%ROWTYPE;
  replenished  DECIMAL(14, 2);
  worst        DECIMAL(14, 2);
  fees         DECIMAL(14, 2);
  covered_on   DATE;
  line         "BankTransaction"%ROWTYPE;
  line_account UUID;
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
  PERFORM require_broker_of_record(NEW."actorId", 'Recording a shortfall cause, regulator notification, replenishment or resolution');

  IF NEW.kind = 'CAUSE_DETERMINED' THEN
    IF inc.kind <> 'SHORTFALL' THEN
      RAISE EXCEPTION 'BANK_RULE: a cause is recorded on a shortfall' USING ERRCODE = 'ZB001';
    END IF;
    IF NEW.cause = 'BANK_SERVICE_FEE' THEN
      SELECT * INTO line FROM "BankTransaction" WHERE id = NEW."bankTransactionId";
      SELECT "trustAccountId" INTO line_account FROM "BankStatement" WHERE id = line."statementId";
      IF line_account IS DISTINCT FROM inc."trustAccountId" OR line.amount >= 0 THEN
        RAISE EXCEPTION 'BANK_RULE: a service fee is a withdrawal on this trust account''s bank statement' USING ERRCODE = 'ZB001';
      END IF;
      IF EXISTS (SELECT 1 FROM "BankMatch" m WHERE m."bankTransactionId" = line.id) THEN
        RAISE EXCEPTION 'BANK_RULE: that bank line is matched to a ledger entry, so it isn''t an unrecorded fee' USING ERRCODE = 'ZB001';
      END IF;
      IF EXISTS (SELECT 1 FROM "TrustIncidentEvent" WHERE "incidentId" = inc.id AND "bankTransactionId" = line.id AND kind = 'CAUSE_DETERMINED') THEN
        RAISE EXCEPTION 'BANK_RULE: that fee is already recorded on this incident' USING ERRCODE = 'ZB001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kind = 'RESOLVED' AND inc.kind = 'SHORTFALL' THEN
    SELECT COALESCE(SUM(amount), 0) INTO replenished FROM "TrustIncidentEvent" WHERE "incidentId" = inc.id AND kind = 'REPLENISHED';
    SELECT GREATEST(inc.amount, COALESCE(MAX(amount), 0)) INTO worst FROM "TrustIncidentEvent" WHERE "incidentId" = inc.id AND kind = 'OBSERVED';
    fees := incident_fee_total(inc.id);
    -- The day the replenishments first covered the worst shortfall
    SELECT MIN(d) INTO covered_on FROM (
      SELECT "eventDate" AS d, SUM(amount) OVER (ORDER BY "eventDate", "createdAt") AS running
        FROM "TrustIncidentEvent" WHERE "incidentId" = inc.id AND kind = 'REPLENISHED') x WHERE running >= worst;
    IF NOT (
         -- s.14: reported and made good
         (EXISTS (SELECT 1 FROM "TrustIncidentEvent" WHERE "incidentId" = inc.id AND kind = 'REGISTRAR_NOTIFIED') AND replenished >= worst)
         -- Bulletin 8.2: solely bank service fees, eliminated as soon as discovered (by the next day)
         OR (fees IS NOT NULL AND fees >= worst AND covered_on IS NOT NULL AND covered_on <= (inc."detectedAt" AT TIME ZONE 'America/Toronto')::date + 1)
         -- A later balanced reconciliation shows it was a ledger error
         OR (NEW."reconciliationId" IS NOT NULL AND EXISTS (
               SELECT 1 FROM "TrustReconciliation" r WHERE r.id = NEW."reconciliationId" AND r."trustAccountId" = inc."trustAccountId"
                  AND r."isBalanced" AND r."preparedAt" > inc."detectedAt"))) THEN
      RAISE EXCEPTION 'BANK_RULE: a shortfall is resolved only once the registrar has been notified and at least % has been replenished, or it was caused solely by bank service fees and replenished by the day after it was found, or a later balanced reconciliation shows there was no shortfall', worst
        USING ERRCODE = 'ZB001';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ── Statement integrity ──────────────────────────────────────────────────────

ALTER TABLE "BankStatement" ADD COLUMN "integrityExceptions" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "BankStatementVerification" ADD COLUMN "exceptionsReviewed" TEXT;

CREATE OR REPLACE FUNCTION statement_verification_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."verifiedAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."verifiedById", false, 'verifying a bank statement');
  NEW."segregationException" := require_separate_people(
    NEW."verifiedById", (SELECT "importedById" FROM "BankStatement" WHERE id = NEW."statementId"), NEW."exceptionReason",
    'Verifying a bank file against the bank (the importer can''t verify their own import)');
  IF (SELECT jsonb_array_length("integrityExceptions") FROM "BankStatement" WHERE id = NEW."statementId") > 0
     AND NULLIF(btrim(NEW."exceptionsReviewed"), '') IS NULL THEN
    RAISE EXCEPTION 'BANK_RULE: this file differs from earlier bank records; say how each difference was checked with the bank before verifying it'
      USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ── Amended reconciliations ──────────────────────────────────────────────────

ALTER TABLE "TrustReconciliation"
  ADD COLUMN "supersedesId"    UUID,
  ADD COLUMN "amendmentReason" TEXT;
ALTER TABLE "TrustReconciliation" ADD CONSTRAINT "TrustReconciliation_supersedesId_fkey"
  FOREIGN KEY ("supersedesId") REFERENCES "TrustReconciliation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TrustReconciliation" ADD CONSTRAINT recon_amendment
  CHECK (("supersedesId" IS NULL) = (NULLIF(btrim("amendmentReason"), '') IS NULL));
CREATE UNIQUE INDEX "TrustReconciliation_supersedesId_key" ON "TrustReconciliation"("supersedesId");
-- One signed reconciliation per statement becomes a chain: each correction supersedes the latest signed one
DROP INDEX "TrustReconciliation_signed_statement_key";

CREATE OR REPLACE FUNCTION trust_reconciliation_guard() RETURNS trigger AS $$
DECLARE
  latest_signed UUID;
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
    PERFORM pg_advisory_xact_lock(hashtext('reconciliation:' || NEW."statementId"::text));
    SELECT r.id INTO latest_signed FROM "TrustReconciliation" r
     WHERE r."statementId" = NEW."statementId" AND r."signedAt" IS NOT NULL ORDER BY r."signedAt" DESC LIMIT 1;
    -- Once a month is signed, a new reconciliation is a correction of the latest signed one
    IF latest_signed IS NOT NULL AND NEW."supersedesId" IS DISTINCT FROM latest_signed THEN
      RAISE EXCEPTION 'BANK_RULE: this month is signed; a new reconciliation must supersede the signed one (%) and say why', latest_signed
        USING ERRCODE = 'ZB001';
    END IF;
    IF latest_signed IS NULL AND NEW."supersedesId" IS NOT NULL THEN
      RAISE EXCEPTION 'BANK_RULE: only a signed reconciliation can be superseded' USING ERRCODE = 'ZB001';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR OLD."signedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'APPEND_ONLY: % on a % reconciliation is not allowed', TG_OP,
      CASE WHEN TG_OP = 'DELETE' THEN 'trust' ELSE 'signed' END USING ERRCODE = 'ZD003';
  END IF;
  IF (NEW.id, NEW."trustAccountId", NEW."statementId", NEW."periodEnd", NEW."bankClosingBalance", NEW."outstandingDeposits",
      NEW."outstandingDisbursements", NEW."unrecordedBankItems", NEW."adjustedBankBalance", NEW."ledgerBalance",
      NEW."clientLiabilities", NEW.difference, NEW."isBalanced", NEW.details, NEW.explanation, NEW."preparedById", NEW."preparedAt",
      NEW."supersedesId", NEW."amendmentReason")
     IS DISTINCT FROM
     (OLD.id, OLD."trustAccountId", OLD."statementId", OLD."periodEnd", OLD."bankClosingBalance", OLD."outstandingDeposits",
      OLD."outstandingDisbursements", OLD."unrecordedBankItems", OLD."adjustedBankBalance", OLD."ledgerBalance",
      OLD."clientLiabilities", OLD.difference, OLD."isBalanced", OLD.details, OLD.explanation, OLD."preparedById", OLD."preparedAt",
      OLD."supersedesId", OLD."amendmentReason") THEN
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

-- ── Bank matches for payments and returned receipts ──────────────────────────

ALTER TABLE "BankMatch"
  ADD COLUMN "payoutEventId"     UUID,
  ADD COLUMN "receiptReversalId" UUID;
ALTER TABLE "BankMatch" DROP CONSTRAINT match_one_target;
ALTER TABLE "BankMatch" ADD CONSTRAINT match_one_target
  CHECK (num_nonnulls("trustEntryId", "commissionReceiptId", "payoutEventId", "receiptReversalId") = 1);
CREATE UNIQUE INDEX "BankMatch_payoutEventId_matchKind_key" ON "BankMatch"("payoutEventId", "matchKind");
CREATE UNIQUE INDEX "BankMatch_receiptReversalId_matchKind_key" ON "BankMatch"("receiptReversalId", "matchKind");
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_payoutEventId_fkey"
  FOREIGN KEY ("payoutEventId") REFERENCES "PayoutEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankMatch" ADD CONSTRAINT "BankMatch_receiptReversalId_fkey"
  FOREIGN KEY ("receiptReversalId") REFERENCES "CommissionReceiptReversal"("receiptId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Which account a payout event moved money in, and by how much (signed: a payment is negative)
CREATE FUNCTION payout_event_money(ev "PayoutEvent") RETURNS TABLE (trust_account UUID, operating_account UUID, signed DECIMAL(14, 2)) AS $$
  SELECT CASE WHEN ev.kind = 'PAID' THEN ev."payFromTrustAccountId" ELSE p."payFromTrustAccountId" END,
         CASE WHEN ev.kind = 'PAID' THEN ev."payFromOperatingAccountId" ELSE p."payFromOperatingAccountId" END,
         CASE WHEN ev.kind = 'PAID' THEN -ev.amount ELSE ev.amount END
    FROM (SELECT 1) one
    LEFT JOIN "PayoutEvent" p ON ev.kind = 'PAYMENT_REVERSED' AND p.seq = ev.seq - 1
         AND p."payoutId" IS NOT DISTINCT FROM ev."payoutId" AND p."payableId" IS NOT DISTINCT FROM ev."payableId"
   WHERE ev.kind IN ('PAID', 'PAYMENT_REVERSED')
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION bank_match_before_insert() RETURNS trigger AS $$
DECLARE
  line      "BankTransaction"%ROWTYPE;
  stmt      "BankStatement"%ROWTYPE;
  entry     "TrustLedgerEntry"%ROWTYPE;
  receipt   "CommissionReceipt"%ROWTYPE;
  ev        "PayoutEvent"%ROWTYPE;
  reversal  "CommissionReceiptReversal"%ROWTYPE;
  t_account UUID;
  o_account UUID;
  expected  DECIMAL(14, 2);
  dated     DATE;
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
    t_account := entry."trustAccountId"; expected := entry.amount * entry.direction; dated := entry."effectiveDate";
  ELSIF NEW."commissionReceiptId" IS NOT NULL THEN
    SELECT * INTO receipt FROM "CommissionReceipt" WHERE id = NEW."commissionReceiptId";
    PERFORM 1 FROM "ClosingStatement" WHERE id = receipt."closingId" FOR UPDATE; -- same lock as payout approvals
    t_account := receipt."trustAccountId"; o_account := receipt."operatingAccountId"; expected := receipt.amount; dated := receipt."receivedDate";
  ELSIF NEW."receiptReversalId" IS NOT NULL THEN
    SELECT * INTO reversal FROM "CommissionReceiptReversal" WHERE "receiptId" = NEW."receiptReversalId";
    SELECT * INTO receipt FROM "CommissionReceipt" WHERE id = reversal."receiptId";
    t_account := receipt."trustAccountId"; o_account := receipt."operatingAccountId"; expected := -receipt.amount; dated := reversal."reversedDate";
  ELSE
    SELECT * INTO ev FROM "PayoutEvent" WHERE id = NEW."payoutEventId";
    IF ev.kind NOT IN ('PAID', 'PAYMENT_REVERSED') THEN
      RAISE EXCEPTION 'BANK_RULE: only a payment or a returned payment is matched to the bank' USING ERRCODE = 'ZB001';
    END IF;
    SELECT trust_account, operating_account, signed INTO t_account, o_account, expected FROM payout_event_money(ev);
    dated := ev."eventDate";
  END IF;

  IF NEW.basis = 'PRE_CUTOVER' THEN
    IF NEW."trustEntryId" IS NULL THEN
      RAISE EXCEPTION 'BANK_RULE: only real estate trust history is attested as pre-cutover' USING ERRCODE = 'ZB001';
    END IF;
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
  IF stmt."trustAccountId" IS DISTINCT FROM t_account OR stmt."operatingAccountId" IS DISTINCT FROM o_account THEN
    RAISE EXCEPTION 'BANK_RULE: the statement line is not from the account this money moved in' USING ERRCODE = 'ZB001';
  END IF;
  IF line.amount <> expected THEN
    RAISE EXCEPTION 'BANK_RULE: bank amount % doesn''t equal the recorded amount %', line.amount, expected USING ERRCODE = 'ZB001';
  END IF;
  IF line."postedDate" < dated - 7 THEN
    RAISE EXCEPTION 'BANK_RULE: bank line dated % is more than a week before the record (%)', line."postedDate", dated
      USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

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
    IF EXISTS (SELECT 1 FROM "TrustLedgerEntry" e
                WHERE e."transactionId" = entry."transactionId" AND e.direction = -1
                  AND e."entryType" <> 'REVERSAL' AND e."createdAt" > OLD."matchedAt") THEN
      RAISE EXCEPTION 'BANK_RULE: funds have already been paid out against this match' USING ERRCODE = 'ZB001';
    END IF;
  ELSIF OLD."commissionReceiptId" IS NOT NULL THEN
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
  SELECT s."trustAccountId" INTO account FROM "BankTransaction" t JOIN "BankStatement" s ON s.id = t."statementId" WHERE t.id = OLD."bankTransactionId";
  IF account IS NOT NULL THEN
    SELECT MAX(r."periodEnd") INTO covered FROM "TrustReconciliation" r
     WHERE r."trustAccountId" = account AND r."signedAt" IS NOT NULL;
    IF covered IS NOT NULL AND EXISTS (SELECT 1 FROM "BankTransaction" t WHERE t.id = OLD."bankTransactionId" AND t."postedDate" <= covered) THEN
      RAISE EXCEPTION 'BANK_RULE: this match is part of a signed reconciliation (to %)', covered USING ERRCODE = 'ZB001';
    END IF;
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

-- A payment counts as confirmed only when matched to verified bank evidence
CREATE FUNCTION payout_event_confirmed(ev UUID) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "BankMatch" m WHERE m."payoutEventId" = ev AND bank_match_is_cleared(m))
$$ LANGUAGE sql STABLE;

-- ── Commission trust account ─────────────────────────────────────────────────

-- Using a commission trust account at all needs the broker of record's policy decision
CREATE FUNCTION require_commission_trust_policy(account UUID) RETURNS void AS $$
BEGIN
  IF account IS NOT NULL AND (SELECT kind FROM "TrustAccount" WHERE id = account) = 'COMMISSION_TRUST'
     AND NOT policy_enabled('COMMISSION_TRUST_ACCOUNT') THEN
    RAISE EXCEPTION 'POLICY_NOT_APPROVED: the commission trust account stays disabled until the broker of record records counsel''s and the accountant''s approval'
      USING ERRCODE = 'ZP001';
  END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION commission_receipt_cta_policy() RETURNS trigger AS $$
BEGIN
  PERFORM require_commission_trust_policy(NEW."trustAccountId");
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER commission_receipt_cta_policy BEFORE INSERT ON "CommissionReceipt"
  FOR EACH ROW EXECUTE FUNCTION commission_receipt_cta_policy();

CREATE FUNCTION payout_event_cta_policy() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IN ('APPROVED', 'PAID') THEN
    PERFORM require_commission_trust_policy(NEW."payFromTrustAccountId");
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payout_event_z_cta_policy BEFORE INSERT ON "PayoutEvent"
  FOR EACH ROW EXECUTE FUNCTION payout_event_cta_policy();

-- Every movement of a commission trust account, as a ledger: receipts in,
-- returned receipts out, payments out, returned payments back in
CREATE FUNCTION commission_trust_ledger(account UUID, upto DATE)
RETURNS TABLE (id UUID, kind TEXT, deal_id UUID, deal_number TEXT, signed DECIMAL(14, 2), effective_date DATE,
               reference TEXT, counterparty TEXT, match_posted DATE) AS $$
  SELECT r.id, 'COMMISSION_RECEIVED', t.id, t."dealNumber", r.amount, r."receivedDate", r.reference, NULL::text,
         (SELECT b."postedDate" FROM "BankMatch" m JOIN "BankTransaction" b ON b.id = m."bankTransactionId"
           WHERE m."commissionReceiptId" = r.id AND m."matchKind" = 'MONTHLY')
    FROM "CommissionReceipt" r JOIN "ClosingStatement" c ON c.id = r."closingId" JOIN "Transaction" t ON t.id = c."transactionId"
   WHERE r."trustAccountId" = account AND r."receivedDate" <= upto
  UNION ALL
  SELECT r.id, 'RECEIPT_RETURNED', t.id, t."dealNumber", -r.amount, x."reversedDate", x.reference, NULL,
         (SELECT b."postedDate" FROM "BankMatch" m JOIN "BankTransaction" b ON b.id = m."bankTransactionId"
           WHERE m."receiptReversalId" = x."receiptId" AND m."matchKind" = 'MONTHLY')
    FROM "CommissionReceiptReversal" x JOIN "CommissionReceipt" r ON r.id = x."receiptId"
    JOIN "ClosingStatement" c ON c.id = r."closingId" JOIN "Transaction" t ON t.id = c."transactionId"
   WHERE r."trustAccountId" = account AND x."reversedDate" <= upto
  UNION ALL
  SELECT ev.id, CASE WHEN ev.kind = 'PAID' THEN 'PAYMENT' ELSE 'PAYMENT_RETURNED' END, t.id, t."dealNumber", mv.signed, ev."eventDate",
         ev.reference, COALESCE(u."firstName" || ' ' || u."lastName", q."payeeName"),
         (SELECT b."postedDate" FROM "BankMatch" m JOIN "BankTransaction" b ON b.id = m."bankTransactionId"
           WHERE m."payoutEventId" = ev.id AND m."matchKind" = 'MONTHLY')
    FROM "PayoutEvent" ev
    CROSS JOIN LATERAL payout_event_money(ev) mv
    LEFT JOIN "ClosingAgentPayout" p ON p.id = ev."payoutId"
    LEFT JOIN "User" u ON u.id = p."userId"
    LEFT JOIN "ClosingPayable" q ON q.id = ev."payableId"
    JOIN "ClosingStatement" c ON c.id = COALESCE(p."closingId", q."closingId")
    JOIN "Transaction" t ON t.id = c."transactionId"
   WHERE mv.trust_account = account AND ev."eventDate" <= upto
$$ LANGUAGE sql STABLE;

-- ── Unclaimed trust money (TRESA s.27(4); RECO Bulletin 8.1) ─────────────────

CREATE TYPE "UnclaimedEntitlement" AS ENUM ('ENTITLED_PARTY_NOT_LOCATED', 'ENTITLEMENT_UNCLEAR', 'DISPUTED');
CREATE TYPE "UnclaimedEventKind" AS ENUM (
  'CONTACT_ATTEMPT', 'NOTE', 'INTEREST_ACCRUED', 'ENTITLEMENT_CHANGED', 'PARTY_LOCATED', 'RESOLVED_PAID_OUT', 'REMITTED_TO_RECO', 'CLOSED');

CREATE TABLE "UnclaimedTrustFund" (
  "id"             UUID NOT NULL,
  "transactionId"  UUID NOT NULL,
  "trustAccountId" UUID NOT NULL,
  "amount"         DECIMAL(14, 2) NOT NULL,
  "heldSince"      DATE NOT NULL,
  "entitledSince"  DATE,
  "entitlement"    "UnclaimedEntitlement" NOT NULL,
  "entitledParty"  TEXT,
  "reason"         TEXT NOT NULL,
  "openedById"     UUID NOT NULL,
  "openedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "UnclaimedTrustFund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT unclaimed_amount CHECK ("amount" > 0),
  CONSTRAINT unclaimed_reason CHECK (btrim("reason") <> ''),
  CONSTRAINT unclaimed_dates CHECK ("entitledSince" IS NULL OR "entitledSince" >= "heldSince")
);
CREATE UNIQUE INDEX "UnclaimedTrustFund_transactionId_trustAccountId_key" ON "UnclaimedTrustFund"("transactionId", "trustAccountId");
ALTER TABLE "UnclaimedTrustFund" ADD CONSTRAINT "UnclaimedTrustFund_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UnclaimedTrustFund" ADD CONSTRAINT "UnclaimedTrustFund_trustAccountId_fkey"
  FOREIGN KEY ("trustAccountId") REFERENCES "TrustAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UnclaimedTrustFund" ADD CONSTRAINT "UnclaimedTrustFund_openedById_fkey"
  FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "UnclaimedFundEvent" (
  "id"          UUID NOT NULL,
  "fundId"      UUID NOT NULL,
  "kind"        "UnclaimedEventKind" NOT NULL,
  "eventDate"   DATE NOT NULL,
  "method"      TEXT,
  "outcome"     TEXT,
  "entitlement" "UnclaimedEntitlement",
  "amount"      DECIMAL(14, 2),
  "reference"   TEXT,
  "note"        TEXT NOT NULL,
  "documentFileId" UUID,
  "actorId"     UUID NOT NULL,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "UnclaimedFundEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT unclaimed_event_note CHECK (btrim("note") <> ''),
  CONSTRAINT unclaimed_event_fields CHECK (
    ("kind" <> 'CONTACT_ATTEMPT' OR (NULLIF(btrim("method"), '') IS NOT NULL AND NULLIF(btrim("outcome"), '') IS NOT NULL))
    AND ("kind" <> 'ENTITLEMENT_CHANGED' OR "entitlement" IS NOT NULL)
    AND ("kind" NOT IN ('INTEREST_ACCRUED', 'REMITTED_TO_RECO') OR "amount" > 0)
    AND ("kind" NOT IN ('REMITTED_TO_RECO', 'RESOLVED_PAID_OUT') OR NULLIF(btrim("reference"), '') IS NOT NULL))
);
CREATE INDEX "UnclaimedFundEvent_fundId_idx" ON "UnclaimedFundEvent"("fundId");
ALTER TABLE "UnclaimedFundEvent" ADD CONSTRAINT "UnclaimedFundEvent_fundId_fkey"
  FOREIGN KEY ("fundId") REFERENCES "UnclaimedTrustFund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UnclaimedFundEvent" ADD CONSTRAINT "UnclaimedFundEvent_documentFileId_fkey"
  FOREIGN KEY ("documentFileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UnclaimedFundEvent" ADD CONSTRAINT "UnclaimedFundEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION unclaimed_fund_is_open(fund UUID) RETURNS boolean AS $$
  SELECT NOT EXISTS (SELECT 1 FROM "UnclaimedFundEvent" WHERE "fundId" = fund AND kind = 'CLOSED')
$$ LANGUAGE sql STABLE;

CREATE FUNCTION unclaimed_fund_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."openedAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."openedById", false, 'opening an unclaimed trust money record');
  IF (SELECT kind FROM "TrustAccount" WHERE id = NEW."trustAccountId") <> 'REAL_ESTATE_TRUST' THEN
    RAISE EXCEPTION 'BANK_RULE: unclaimed trust money is tracked in the real estate trust account' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER unclaimed_fund_before_insert BEFORE INSERT ON "UnclaimedTrustFund"
  FOR EACH ROW EXECUTE FUNCTION unclaimed_fund_before_insert();

CREATE FUNCTION unclaimed_event_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM 1 FROM "UnclaimedTrustFund" WHERE id = NEW."fundId" FOR UPDATE;
  IF NOT unclaimed_fund_is_open(NEW."fundId") THEN
    RAISE EXCEPTION 'BANK_RULE: this unclaimed money record is closed' USING ERRCODE = 'ZB001';
  END IF;
  IF NEW.kind IN ('REMITTED_TO_RECO', 'RESOLVED_PAID_OUT', 'CLOSED', 'ENTITLEMENT_CHANGED') THEN
    PERFORM require_broker_of_record(NEW."actorId", 'Changing the status of unclaimed trust money');
  ELSE
    PERFORM require_bank_staff(NEW."actorId", false, 'updating an unclaimed trust money record');
  END IF;
  IF NEW.kind = 'REMITTED_TO_RECO' AND NOT policy_enabled('UNCLAIMED_MONEY_REMITTANCE') THEN
    RAISE EXCEPTION 'POLICY_NOT_APPROVED: remitting unclaimed money to RECO stays disabled until the broker of record enables it'
      USING ERRCODE = 'ZP001';
  END IF;
  IF NEW.kind = 'CLOSED' AND NOT EXISTS (
       SELECT 1 FROM "UnclaimedFundEvent" WHERE "fundId" = NEW."fundId" AND kind IN ('REMITTED_TO_RECO', 'RESOLVED_PAID_OUT')) THEN
    RAISE EXCEPTION 'BANK_RULE: close the record once the money is paid to the person entitled or remitted to RECO' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER unclaimed_event_before_insert BEFORE INSERT ON "UnclaimedFundEvent"
  FOR EACH ROW EXECUTE FUNCTION unclaimed_event_before_insert();
CREATE TRIGGER unclaimed_fund_immutable BEFORE UPDATE OR DELETE ON "UnclaimedTrustFund"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER unclaimed_event_immutable BEFORE UPDATE OR DELETE ON "UnclaimedFundEvent"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- ── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT ON "ProclaimedHoliday", "UnclaimedTrustFund", "UnclaimedFundEvent" TO zareh_app;

COMMIT;
