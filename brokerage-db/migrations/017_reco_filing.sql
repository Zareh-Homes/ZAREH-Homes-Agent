-- 017 – RECO annual financial filing preparation (TRESA s.48.1; docs/regulatory-references.md §6)
--
-- The filing is made by the broker of record in RECO's MyWeb portal. This only prepares it:
--   • RecoFilingYear: the brokerage's fiscal year (the due date follows from it).
--   • RecoFilingInput: figures that come from the financial statements (cash, assets,
--     liabilities, equity, revenue, gross profit, expenses, net income, trust interest retained,
--     bank branch details), each with its source document. Corrections are new rows.
--   • RecoAttestationReview: the broker of record's review of the evidence behind each
--     attestation before attesting in MyWeb.
--   • RecoFilingSubmission: a record that the broker of record filed in MyWeb, with RECO's
--     confirmation. Nothing is sent from this system.
--
-- Applies on top of 016.

BEGIN;

CREATE TABLE "RecoFilingYear" (
  "fiscalYearEnd"   DATE NOT NULL,
  "fiscalYearStart" DATE NOT NULL,
  "createdById"     UUID NOT NULL,
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "RecoFilingYear_pkey" PRIMARY KEY ("fiscalYearEnd"),
  CONSTRAINT filing_year_length CHECK ("fiscalYearStart" < "fiscalYearEnd" AND "fiscalYearEnd" - "fiscalYearStart" <= 371)
);
ALTER TABLE "RecoFilingYear" ADD CONSTRAINT "RecoFilingYear_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RecoFilingInput" (
  "id"             UUID NOT NULL,
  "fiscalYearEnd"  DATE NOT NULL,
  "field"          TEXT NOT NULL,
  "amount"         DECIMAL(16, 2),
  "text"           TEXT,
  "source"         TEXT NOT NULL,
  "documentFileId" UUID,
  "enteredById"    UUID NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "RecoFilingInput_pkey" PRIMARY KEY ("id"),
  CONSTRAINT filing_input_field CHECK ("field" IN ('CASH', 'TOTAL_ASSETS', 'TOTAL_LIABILITIES', 'EQUITY', 'REVENUE', 'GROSS_PROFIT', 'EXPENSES',
    'NET_INCOME', 'TRUST_INTEREST_RETAINED') OR "field" LIKE 'BANK_BRANCH:%'),
  CONSTRAINT filing_input_value CHECK (("amount" IS NULL) <> ("text" IS NULL) AND ("field" NOT LIKE 'BANK_BRANCH:%' OR "text" IS NOT NULL)
    AND ("field" LIKE 'BANK_BRANCH:%' OR "amount" IS NOT NULL)),
  CONSTRAINT filing_input_source CHECK (btrim("source") <> '')
);
CREATE INDEX "RecoFilingInput_fiscalYearEnd_field_idx" ON "RecoFilingInput"("fiscalYearEnd", "field");
ALTER TABLE "RecoFilingInput" ADD CONSTRAINT "RecoFilingInput_fiscalYearEnd_fkey" FOREIGN KEY ("fiscalYearEnd") REFERENCES "RecoFilingYear"("fiscalYearEnd") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoFilingInput" ADD CONSTRAINT "RecoFilingInput_documentFileId_fkey" FOREIGN KEY ("documentFileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoFilingInput" ADD CONSTRAINT "RecoFilingInput_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RecoAttestationReview" (
  "id"            UUID NOT NULL,
  "fiscalYearEnd" DATE NOT NULL,
  "item"          TEXT NOT NULL,
  "note"          TEXT NOT NULL,
  "reviewedById"  UUID NOT NULL,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "RecoAttestationReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT attestation_item CHECK ("item" IN ('TRUST_SUFFICIENCY', 'SEPARATION_OF_FUNDS', 'MONTHLY_RECONCILIATIONS', 'SHORTFALLS_REPORTED',
    'NOTICE_OF_CHANGES', 'ACCURACY')),
  CONSTRAINT attestation_note CHECK (btrim("note") <> '')
);
ALTER TABLE "RecoAttestationReview" ADD CONSTRAINT "RecoAttestationReview_fiscalYearEnd_fkey" FOREIGN KEY ("fiscalYearEnd") REFERENCES "RecoFilingYear"("fiscalYearEnd") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoAttestationReview" ADD CONSTRAINT "RecoAttestationReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "RecoFilingSubmission" (
  "fiscalYearEnd" DATE NOT NULL,
  "submittedOn"   DATE NOT NULL,
  "reference"     TEXT NOT NULL,
  "note"          TEXT,
  "submittedById" UUID NOT NULL,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "RecoFilingSubmission_pkey" PRIMARY KEY ("fiscalYearEnd"),
  CONSTRAINT submission_reference CHECK (btrim("reference") <> '')
);
ALTER TABLE "RecoFilingSubmission" ADD CONSTRAINT "RecoFilingSubmission_fiscalYearEnd_fkey" FOREIGN KEY ("fiscalYearEnd") REFERENCES "RecoFilingYear"("fiscalYearEnd") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecoFilingSubmission" ADD CONSTRAINT "RecoFilingSubmission_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reco_year_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."createdById", false, 'setting up a RECO filing year');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reco_year_before_insert BEFORE INSERT ON "RecoFilingYear" FOR EACH ROW EXECUTE FUNCTION reco_year_before_insert();

CREATE FUNCTION reco_input_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."enteredById", false, 'entering RECO filing figures');
  IF EXISTS (SELECT 1 FROM "RecoFilingSubmission" WHERE "fiscalYearEnd" = NEW."fiscalYearEnd") THEN
    RAISE EXCEPTION 'BANK_RULE: this year''s filing is recorded as submitted' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reco_input_before_insert BEFORE INSERT ON "RecoFilingInput" FOR EACH ROW EXECUTE FUNCTION reco_input_before_insert();

CREATE FUNCTION reco_review_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_broker_of_record(NEW."reviewedById", 'Reviewing RECO filing attestations');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reco_review_before_insert BEFORE INSERT ON "RecoAttestationReview" FOR EACH ROW EXECUTE FUNCTION reco_review_before_insert();

CREATE FUNCTION reco_submission_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_broker_of_record(NEW."submittedById", 'Recording the RECO filing');
  IF (SELECT COUNT(DISTINCT item) FROM "RecoAttestationReview" WHERE "fiscalYearEnd" = NEW."fiscalYearEnd") < 6 THEN
    RAISE EXCEPTION 'BANK_RULE: review the evidence for all six attestations before recording the filing' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reco_submission_before_insert BEFORE INSERT ON "RecoFilingSubmission" FOR EACH ROW EXECUTE FUNCTION reco_submission_before_insert();

CREATE TRIGGER reco_year_immutable BEFORE UPDATE OR DELETE ON "RecoFilingYear" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER reco_input_immutable BEFORE UPDATE OR DELETE ON "RecoFilingInput" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER reco_review_immutable BEFORE UPDATE OR DELETE ON "RecoAttestationReview" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER reco_submission_immutable BEFORE UPDATE OR DELETE ON "RecoFilingSubmission" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

GRANT SELECT, INSERT ON "RecoFilingYear", "RecoFilingInput", "RecoAttestationReview", "RecoFilingSubmission" TO zareh_app;

COMMIT;
