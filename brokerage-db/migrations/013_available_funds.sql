-- 013 – Available funds and payment confirmation
--
--   • Available funds for a payout account =
--         verified bank balance at date B
--       − payments sent that the bank hadn't paid by B (unpresented cheques, EFTs in flight)
--       − payments approved and not yet sent
--       − payments returned and still owed
--       − the account's other obligations (payroll, HST, rent: anything this system doesn't pay),
--         from an obligations figure no more than 7 days old that a second person has attested
--     An operating account with no current attested obligations figure can't fund an approval:
--     the check fails closed.
--   • Obligations figures come from the accounting system (through the adapter) or, only if the
--     broker of record enables MANUAL_OBLIGATIONS_PROCEDURE, from the documented manual procedure.
--   • A payment is "sent" when recorded (PAID). It is "confirmed" only when matched to a line of a
--     bank file verified by someone other than the person who recorded the payment.
--
-- Applies on top of 012.

BEGIN;

ALTER TABLE "FinancialPolicyDecision" DROP CONSTRAINT policy_known;
ALTER TABLE "FinancialPolicyDecision" ADD CONSTRAINT policy_known CHECK ("policy" IN (
  'SOLE_OPERATOR_EXCEPTION', 'THIRD_PARTY_PAYABLES', 'COMMISSION_TRUST_ACCOUNT', 'CIVIC_HOLIDAY_IS_HOLIDAY',
  'UNCLAIMED_MONEY_REMITTANCE', 'MANUAL_OBLIGATIONS_PROCEDURE'));

CREATE TABLE "FundsObligationSnapshot" (
  "id"                 UUID NOT NULL,
  "operatingAccountId" UUID NOT NULL,
  "asOf"               DATE NOT NULL,
  "amount"             DECIMAL(14, 2) NOT NULL,
  "source"             TEXT NOT NULL,
  "sourceReference"    TEXT NOT NULL,
  "lines"              JSONB NOT NULL DEFAULT '[]',
  "preparedById"       UUID NOT NULL,
  "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "FundsObligationSnapshot_pkey" PRIMARY KEY ("id"),
  CONSTRAINT obligation_amount CHECK ("amount" >= 0),
  CONSTRAINT obligation_source CHECK ("source" IN ('ACCOUNTING_SYSTEM', 'MANUAL')),
  CONSTRAINT obligation_reference CHECK (btrim("sourceReference") <> '')
);
CREATE INDEX "FundsObligationSnapshot_operatingAccountId_asOf_idx" ON "FundsObligationSnapshot"("operatingAccountId", "asOf");
ALTER TABLE "FundsObligationSnapshot" ADD CONSTRAINT "FundsObligationSnapshot_operatingAccountId_fkey"
  FOREIGN KEY ("operatingAccountId") REFERENCES "OperatingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FundsObligationSnapshot" ADD CONSTRAINT "FundsObligationSnapshot_preparedById_fkey"
  FOREIGN KEY ("preparedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "FundsObligationAttestation" (
  "snapshotId"           UUID NOT NULL,
  "attestedById"         UUID NOT NULL,
  "note"                 TEXT NOT NULL,
  "segregationException" BOOLEAN NOT NULL DEFAULT false,
  "exceptionReason"      TEXT,
  "attestedAt"           TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "FundsObligationAttestation_pkey" PRIMARY KEY ("snapshotId"),
  CONSTRAINT attestation_note CHECK (btrim("note") <> '')
);
ALTER TABLE "FundsObligationAttestation" ADD CONSTRAINT "FundsObligationAttestation_snapshotId_fkey"
  FOREIGN KEY ("snapshotId") REFERENCES "FundsObligationSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FundsObligationAttestation" ADD CONSTRAINT "FundsObligationAttestation_attestedById_fkey"
  FOREIGN KEY ("attestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION obligation_snapshot_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."preparedById", false, 'recording the operating account''s obligations');
  IF NEW.source = 'MANUAL' AND NOT policy_enabled('MANUAL_OBLIGATIONS_PROCEDURE') THEN
    RAISE EXCEPTION 'POLICY_NOT_APPROVED: obligations come from the accounting system unless the broker of record enables the manual procedure'
      USING ERRCODE = 'ZP001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER obligation_snapshot_before_insert BEFORE INSERT ON "FundsObligationSnapshot"
  FOR EACH ROW EXECUTE FUNCTION obligation_snapshot_before_insert();

CREATE FUNCTION obligation_attestation_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."attestedAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."attestedById", false, 'attesting to the operating account''s obligations');
  NEW."segregationException" := require_separate_people(NEW."attestedById",
    (SELECT "preparedById" FROM "FundsObligationSnapshot" WHERE id = NEW."snapshotId"), NEW."exceptionReason",
    'Attesting to an obligations figure (the preparer can''t attest their own)');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER obligation_attestation_before_insert BEFORE INSERT ON "FundsObligationAttestation"
  FOR EACH ROW EXECUTE FUNCTION obligation_attestation_before_insert();
CREATE TRIGGER obligation_snapshot_immutable BEFORE UPDATE OR DELETE ON "FundsObligationSnapshot"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER obligation_attestation_immutable BEFORE UPDATE OR DELETE ON "FundsObligationAttestation"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- The latest attested obligations figure no more than 7 days before `on_date`; NULL if there isn't one
CREATE FUNCTION account_obligations(p_operating UUID, on_date DATE) RETURNS DECIMAL(14, 2) AS $$
  SELECT s.amount FROM "FundsObligationSnapshot" s JOIN "FundsObligationAttestation" a ON a."snapshotId" = s.id
   WHERE s."operatingAccountId" = p_operating AND s."asOf" BETWEEN on_date - 7 AND on_date
   ORDER BY s."asOf" DESC, s."createdAt" DESC LIMIT 1
$$ LANGUAGE sql STABLE;

-- A payment counts as presented at `on_date` once matched to a bank line posted by then
CREATE FUNCTION payout_event_presented(ev UUID, on_date DATE) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "BankMatch" m JOIN "BankTransaction" b ON b.id = m."bankTransactionId"
                  WHERE m."payoutEventId" = ev AND b."postedDate" <= on_date)
$$ LANGUAGE sql STABLE;

-- Everything that will come out of an account beyond what the bank balance at `since` already reflects
CREATE OR REPLACE FUNCTION account_committed(p_trust UUID, p_operating UUID, since DATE) RETURNS DECIMAL(14, 2) AS $$
  WITH latest AS (
    SELECT DISTINCT ON (COALESCE(e."payoutId", e."payableId")) e.*
      FROM "PayoutEvent" e
     ORDER BY COALESCE(e."payoutId", e."payableId"), e.seq DESC
  ), approval AS (
    SELECT l.*, (SELECT a FROM "PayoutEvent" a WHERE COALESCE(a."payoutId", a."payableId") = COALESCE(l."payoutId", l."payableId")
                  AND a.kind = 'APPROVED' ORDER BY a.seq DESC LIMIT 1) AS ap
      FROM latest l
  )
  SELECT (COALESCE(SUM((ap).amount), 0) + CASE WHEN p_operating IS NULL THEN 0 ELSE COALESCE(account_obligations(p_operating, since), 0) END)::DECIMAL(14, 2)
    FROM approval
   WHERE (ap).id IS NOT NULL
     AND (ap)."payFromTrustAccountId" IS NOT DISTINCT FROM p_trust
     AND (ap)."payFromOperatingAccountId" IS NOT DISTINCT FROM p_operating
     AND (kind IN ('APPROVED', 'PAYMENT_REVERSED') OR (kind = 'PAID' AND NOT payout_event_presented(id, since)))
$$ LANGUAGE sql STABLE;

-- Fails closed: no approval from an operating account without a current attested obligations figure
CREATE FUNCTION payout_event_obligations() RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'APPROVED' AND NEW."payFromOperatingAccountId" IS NOT NULL
     AND account_obligations(NEW."payFromOperatingAccountId", NEW."eventDate") IS NULL THEN
    RAISE EXCEPTION 'FUNDS_NOT_AVAILABLE: no attested obligations figure for the operating account in the last 7 days; import it from the accounting system and have it attested'
      USING ERRCODE = 'ZT008';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER payout_event_zz_obligations BEFORE INSERT ON "PayoutEvent"
  FOR EACH ROW EXECUTE FUNCTION payout_event_obligations();

-- Confirmed: matched to a verified bank line, verified by someone other than whoever recorded the payment
CREATE OR REPLACE FUNCTION payout_event_confirmed(ev UUID) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "BankMatch" m
      JOIN "BankTransaction" b ON b.id = m."bankTransactionId"
      JOIN "BankStatementVerification" v ON v."statementId" = b."statementId"
      JOIN "PayoutEvent" p ON p.id = m."payoutEventId"
     WHERE m."payoutEventId" = ev AND v."verifiedById" <> p."actorId")
$$ LANGUAGE sql STABLE;

GRANT SELECT, INSERT ON "FundsObligationSnapshot", "FundsObligationAttestation" TO zareh_app;

COMMIT;
