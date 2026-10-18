-- 016 – TRESA consumer-protection records and the FINTRAC obligations engine
--
-- TRESA / O. Reg. 567/05 (see docs/regulatory-references.md §5):
--   • How each principal is represented: our client, represented by another brokerage, or
--     self-represented.
--   • Disclosures, with delivery, explanation and acknowledgement (or best efforts): the RECO
--     Information Guide (s.13), the self-represented party form, multiple representation
--     disclosure and each client's written consent (s.22), and, on listings, the number of
--     competing offers, their content (only on the seller's written direction) and that the
--     brokerage also represents a buyer (s.22.7, s.22.0.3).
--   • Representation agreements with the terms s.13.4 requires.
--   • The seller's written direction on sharing offer content, versioned.
--
-- FINTRAC (PCMLTFA; §7):
--   • Determinations per party: PEP/HIO and risk, business relationship purpose, beneficial
--     ownership measures, entity existence (within 30 days).
--   • Receipt of funds record for every deposit (any amount, real estate).
--   • Report tasks: large cash (≥ $10,000 in 24 h, 15 days), large virtual currency, suspicious
--     transaction (as soon as practicable), listed/terrorist property (immediately). Filed by a
--     person in FINTRAC's own system; this records the reference. Nothing is sent.
--   • Compliance program: officer, approved policies, risk assessment, training, two-year
--     effectiveness review.
--
-- Applies on top of 015.

ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CASH';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'VIRTUAL_CURRENCY';

BEGIN;

ALTER TABLE "TransactionParty" ADD COLUMN "representation" TEXT;
ALTER TABLE "TransactionParty" ADD CONSTRAINT party_representation
  CHECK ("representation" IS NULL OR "representation" IN ('OUR_CLIENT', 'REPRESENTED_ELSEWHERE', 'SELF_REPRESENTED'));

ALTER TABLE "Offer" ADD COLUMN "fromOurBrokerage" BOOLEAN NOT NULL DEFAULT false;

-- Cash and virtual currency are recorded as received (FINTRAC reporting follows), never refused at the ledger
ALTER TABLE "TrustLedgerEntry" DROP CONSTRAINT trust_deposit_fields;
ALTER TABLE "TrustLedgerEntry" ADD CONSTRAINT trust_deposit_fields CHECK (
  "entryType" <> 'DEPOSIT_RECEIVED' OR (
    "receivedDate" IS NOT NULL
    AND "receiptNumber" IS NOT NULL
    AND NULLIF(btrim("referenceNo"), '') IS NOT NULL
    AND "effectiveDate" >= "receivedDate"
    AND method IN ('BANK_DRAFT', 'WIRE', 'CERTIFIED_CHEQUE', 'CASH', 'VIRTUAL_CURRENCY')
  ));

-- ── TRESA disclosures ────────────────────────────────────────────────────────

CREATE TYPE "DisclosureKind" AS ENUM (
  'INFORMATION_GUIDE', 'SELF_REPRESENTED_PARTY_FORM', 'MULTIPLE_REPRESENTATION_DISCLOSURE', 'MULTIPLE_REPRESENTATION_CONSENT',
  'COMPETING_OFFERS_NUMBER', 'COMPETING_OFFERS_CONTENT', 'SAME_BROKERAGE_REPRESENTATION');

CREATE TABLE "TresaDisclosure" (
  "id"             UUID NOT NULL,
  "transactionId"  UUID NOT NULL,
  "kind"           "DisclosureKind" NOT NULL,
  "partyId"        UUID,
  "offerId"        UUID,
  "deliveredAt"    TIMESTAMPTZ(6) NOT NULL,
  "method"         TEXT NOT NULL,
  "explainedAt"    TIMESTAMPTZ(6),
  "acknowledgedAt" TIMESTAMPTZ(6),
  "bestEffortsNote" TEXT,
  "formVersion"    TEXT,
  "numberDisclosed" INTEGER,
  "content"        TEXT,
  "directionId"    UUID,
  "documentFileId" UUID,
  "recordedById"   UUID NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "TresaDisclosure_pkey" PRIMARY KEY ("id"),
  CONSTRAINT disclosure_target CHECK (
    ("kind" IN ('COMPETING_OFFERS_NUMBER', 'COMPETING_OFFERS_CONTENT', 'SAME_BROKERAGE_REPRESENTATION')) = ("offerId" IS NOT NULL)
    AND ("offerId" IS NULL OR "partyId" IS NULL)
    AND ("kind" NOT IN ('INFORMATION_GUIDE', 'SELF_REPRESENTED_PARTY_FORM', 'MULTIPLE_REPRESENTATION_DISCLOSURE', 'MULTIPLE_REPRESENTATION_CONSENT')
         OR "partyId" IS NOT NULL)),
  CONSTRAINT disclosure_fields CHECK (
    ("kind" <> 'COMPETING_OFFERS_NUMBER' OR COALESCE("numberDisclosed" >= 0, false))
    AND ("kind" <> 'COMPETING_OFFERS_CONTENT' OR (NULLIF(btrim("content"), '') IS NOT NULL AND "directionId" IS NOT NULL))
    AND ("kind" <> 'SELF_REPRESENTED_PARTY_FORM' OR COALESCE("formVersion" IN ('BROKERAGE_REPRESENTATION', 'DESIGNATED_REPRESENTATION'), false))
    AND ("kind" <> 'MULTIPLE_REPRESENTATION_CONSENT' OR "acknowledgedAt" IS NOT NULL)
    AND btrim("method") <> '')
);
CREATE INDEX "TresaDisclosure_transactionId_idx" ON "TresaDisclosure"("transactionId");

CREATE TABLE "SellerOfferDirection" (
  "id"             UUID NOT NULL,
  "listingDealId"  UUID NOT NULL,
  "givenAt"        TIMESTAMPTZ(6) NOT NULL,
  "shareContent"   BOOLEAN NOT NULL,
  "scope"          TEXT,
  "documentFileId" UUID,
  "recordedById"   UUID NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "SellerOfferDirection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT direction_scope CHECK (NOT "shareContent" OR NULLIF(btrim("scope"), '') IS NOT NULL)
);
CREATE INDEX "SellerOfferDirection_listingDealId_idx" ON "SellerOfferDirection"("listingDealId");

ALTER TABLE "TresaDisclosure" ADD CONSTRAINT "TresaDisclosure_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TresaDisclosure" ADD CONSTRAINT "TresaDisclosure_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "TransactionParty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TresaDisclosure" ADD CONSTRAINT "TresaDisclosure_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TresaDisclosure" ADD CONSTRAINT "TresaDisclosure_directionId_fkey" FOREIGN KEY ("directionId") REFERENCES "SellerOfferDirection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TresaDisclosure" ADD CONSTRAINT "TresaDisclosure_documentFileId_fkey" FOREIGN KEY ("documentFileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TresaDisclosure" ADD CONSTRAINT "TresaDisclosure_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerOfferDirection" ADD CONSTRAINT "SellerOfferDirection_listingDealId_fkey" FOREIGN KEY ("listingDealId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerOfferDirection" ADD CONSTRAINT "SellerOfferDirection_documentFileId_fkey" FOREIGN KEY ("documentFileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SellerOfferDirection" ADD CONSTRAINT "SellerOfferDirection_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Content shared only under a direction in force, given before the disclosure
CREATE FUNCTION tresa_disclosure_before_insert() RETURNS trigger AS $$
DECLARE
  latest "SellerOfferDirection"%ROWTYPE;
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_deal_staff(NEW."transactionId", NEW."recordedById", 'recording a disclosure');
  IF NEW.kind = 'COMPETING_OFFERS_CONTENT' THEN
    SELECT * INTO latest FROM "SellerOfferDirection" WHERE "listingDealId" = NEW."transactionId" AND "givenAt" <= NEW."deliveredAt"
     ORDER BY "givenAt" DESC, "createdAt" DESC LIMIT 1;
    IF latest.id IS DISTINCT FROM NEW."directionId" OR NOT latest."shareContent" THEN
      RAISE EXCEPTION 'BANK_RULE: offer content can only be shared under the seller''s written direction in force at the time' USING ERRCODE = 'ZB001';
    END IF;
  END IF;
  IF NEW."offerId" IS NOT NULL AND (SELECT "listingDealId" FROM "Offer" WHERE id = NEW."offerId") <> NEW."transactionId" THEN
    RAISE EXCEPTION 'BANK_RULE: that offer is on another listing' USING ERRCODE = 'ZB001';
  END IF;
  IF NEW."partyId" IS NOT NULL AND (SELECT "transactionId" FROM "TransactionParty" WHERE id = NEW."partyId") <> NEW."transactionId" THEN
    RAISE EXCEPTION 'BANK_RULE: that party is on another deal' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tresa_disclosure_before_insert BEFORE INSERT ON "TresaDisclosure" FOR EACH ROW EXECUTE FUNCTION tresa_disclosure_before_insert();

CREATE FUNCTION seller_direction_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_deal_staff(NEW."listingDealId", NEW."recordedById", 'recording the seller''s direction');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER seller_direction_before_insert BEFORE INSERT ON "SellerOfferDirection" FOR EACH ROW EXECUTE FUNCTION seller_direction_before_insert();

-- ── Representation agreements (s.13.4) ───────────────────────────────────────

CREATE TABLE "RepresentationAgreement" (
  "id"               UUID NOT NULL,
  "transactionId"    UUID NOT NULL,
  "partyId"          UUID NOT NULL,
  "type"             TEXT NOT NULL,
  "designatedRepresentativeIds" UUID[] NOT NULL DEFAULT '{}',
  "signedAt"         TIMESTAMPTZ(6) NOT NULL,
  "effectiveFrom"    DATE NOT NULL,
  "expiresOn"        DATE NOT NULL,
  "remunerationTerms" TEXT NOT NULL,
  "services"         TEXT NOT NULL,
  "terminationTerms" TEXT NOT NULL,
  "documentFileId"   UUID,
  "recordedById"     UUID NOT NULL,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "RepresentationAgreement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT agreement_type CHECK ("type" IN ('BROKERAGE', 'DESIGNATED')),
  CONSTRAINT agreement_designated CHECK ("type" = 'BROKERAGE' OR cardinality("designatedRepresentativeIds") > 0),
  CONSTRAINT agreement_dates CHECK ("expiresOn" >= "effectiveFrom"),
  CONSTRAINT agreement_terms CHECK (btrim("remunerationTerms") <> '' AND btrim("services") <> '' AND btrim("terminationTerms") <> '')
);
CREATE INDEX "RepresentationAgreement_partyId_idx" ON "RepresentationAgreement"("partyId");
ALTER TABLE "RepresentationAgreement" ADD CONSTRAINT "RepresentationAgreement_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RepresentationAgreement" ADD CONSTRAINT "RepresentationAgreement_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "TransactionParty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RepresentationAgreement" ADD CONSTRAINT "RepresentationAgreement_documentFileId_fkey" FOREIGN KEY ("documentFileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RepresentationAgreement" ADD CONSTRAINT "RepresentationAgreement_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION agreement_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_deal_staff(NEW."transactionId", NEW."recordedById", 'recording a representation agreement');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER agreement_before_insert BEFORE INSERT ON "RepresentationAgreement" FOR EACH ROW EXECUTE FUNCTION agreement_before_insert();

-- ── FINTRAC ──────────────────────────────────────────────────────────────────

CREATE TYPE "FintracDeterminationKind" AS ENUM ('PEP_HIO', 'BUSINESS_RELATIONSHIP', 'BENEFICIAL_OWNERSHIP_CONFIRMED', 'ENTITY_EXISTENCE_CONFIRMED');

CREATE TABLE "FintracDetermination" (
  "id"           UUID NOT NULL,
  "partyId"      UUID NOT NULL,
  "kind"         "FintracDeterminationKind" NOT NULL,
  "determinedAt" TIMESTAMPTZ(6) NOT NULL,
  "result"       TEXT NOT NULL,
  "riskRating"   TEXT,
  "details"      TEXT NOT NULL,
  "recordedById" UUID NOT NULL,
  "createdAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "FintracDetermination_pkey" PRIMARY KEY ("id"),
  CONSTRAINT determination_risk CHECK ("riskRating" IS NULL OR "riskRating" IN ('LOW', 'MEDIUM', 'HIGH')),
  CONSTRAINT determination_pep CHECK ("kind" <> 'PEP_HIO' OR ("result" IN ('NONE', 'FOREIGN_PEP', 'DOMESTIC_PEP', 'HIO', 'FAMILY_OR_CLOSE_ASSOCIATE') AND "riskRating" IS NOT NULL)),
  CONSTRAINT determination_foreign_pep CHECK ("result" <> 'FOREIGN_PEP' OR "riskRating" = 'HIGH'),
  CONSTRAINT determination_details CHECK (btrim("details") <> '' AND btrim("result") <> '')
);
CREATE INDEX "FintracDetermination_partyId_idx" ON "FintracDetermination"("partyId");
ALTER TABLE "FintracDetermination" ADD CONSTRAINT "FintracDetermination_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "TransactionParty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FintracDetermination" ADD CONSTRAINT "FintracDetermination_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION fintrac_determination_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_deal_staff((SELECT "transactionId" FROM "TransactionParty" WHERE id = NEW."partyId"), NEW."recordedById", 'recording a FINTRAC determination');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER fintrac_determination_before_insert BEFORE INSERT ON "FintracDetermination" FOR EACH ROW EXECUTE FUNCTION fintrac_determination_before_insert();

-- Receipt of funds: every deposit, any amount. Personal details are encrypted by the application.
CREATE TABLE "ReceiptOfFundsRecord" (
  "trustEntryId"   UUID NOT NULL,
  "payerType"      TEXT NOT NULL,
  "payerName"      TEXT NOT NULL,
  "payerDetailsEnc" TEXT,
  "cashAmount"     DECIMAL(14, 2) NOT NULL DEFAULT 0,
  "currency"       TEXT NOT NULL DEFAULT 'CAD',
  "sourceAccount"  TEXT,
  "onBehalfOf"     TEXT,
  "exemptReason"   TEXT,
  "recordedById"   UUID NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "ReceiptOfFundsRecord_pkey" PRIMARY KEY ("trustEntryId"),
  CONSTRAINT rof_payer CHECK ("payerType" IN ('PERSON', 'ENTITY', 'FINANCIAL_ENTITY', 'PUBLIC_BODY') AND btrim("payerName") <> ''),
  CONSTRAINT rof_cash CHECK ("cashAmount" >= 0),
  CONSTRAINT rof_details CHECK ("payerType" IN ('FINANCIAL_ENTITY', 'PUBLIC_BODY') OR "payerDetailsEnc" IS NOT NULL),
  CONSTRAINT rof_exempt CHECK (("payerType" IN ('FINANCIAL_ENTITY', 'PUBLIC_BODY')) = (NULLIF(btrim("exemptReason"), '') IS NOT NULL))
);
ALTER TABLE "ReceiptOfFundsRecord" ADD CONSTRAINT "ReceiptOfFundsRecord_trustEntryId_fkey" FOREIGN KEY ("trustEntryId") REFERENCES "TrustLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReceiptOfFundsRecord" ADD CONSTRAINT "ReceiptOfFundsRecord_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION rof_before_insert() RETURNS trigger AS $$
DECLARE
  entry "TrustLedgerEntry"%ROWTYPE;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT * INTO entry FROM "TrustLedgerEntry" WHERE id = NEW."trustEntryId";
  IF entry."entryType" <> 'DEPOSIT_RECEIVED' THEN
    RAISE EXCEPTION 'BANK_RULE: a receipt of funds record is for money received' USING ERRCODE = 'ZB001';
  END IF;
  IF NEW."cashAmount" > entry.amount THEN
    RAISE EXCEPTION 'BANK_RULE: the cash part can''t exceed the deposit' USING ERRCODE = 'ZB001';
  END IF;
  PERFORM require_deal_staff(entry."transactionId", NEW."recordedById", 'recording a receipt of funds');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER rof_before_insert BEFORE INSERT ON "ReceiptOfFundsRecord" FOR EACH ROW EXECUTE FUNCTION rof_before_insert();

CREATE TYPE "FintracReportKind" AS ENUM ('LARGE_CASH', 'LARGE_VIRTUAL_CURRENCY', 'SUSPICIOUS_TRANSACTION', 'LISTED_PERSON_PROPERTY');
CREATE TYPE "FintracReportStatus" AS ENUM ('OPEN', 'FILED', 'NOT_REQUIRED');

CREATE TABLE "FintracReport" (
  "id"            UUID NOT NULL,
  "kind"          "FintracReportKind" NOT NULL,
  "transactionId" UUID,
  "trustEntryIds" UUID[] NOT NULL DEFAULT '{}',
  "triggeredAt"   TIMESTAMPTZ(6) NOT NULL,
  "dueAt"         TIMESTAMPTZ(6) NOT NULL,
  "summary"       TEXT NOT NULL,
  "openedById"    UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "FintracReport_pkey" PRIMARY KEY ("id"),
  CONSTRAINT report_summary CHECK (btrim("summary") <> '')
);
CREATE INDEX "FintracReport_transactionId_idx" ON "FintracReport"("transactionId");
ALTER TABLE "FintracReport" ADD CONSTRAINT "FintracReport_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FintracReport" ADD CONSTRAINT "FintracReport_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "FintracReportEvent" (
  "id"        UUID NOT NULL,
  "reportId"  UUID NOT NULL,
  "status"    "FintracReportStatus" NOT NULL,
  "reference" TEXT,
  "note"      TEXT NOT NULL,
  "actorId"   UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "FintracReportEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT report_event_reference CHECK ("status" <> 'FILED' OR NULLIF(btrim("reference"), '') IS NOT NULL),
  CONSTRAINT report_event_note CHECK (btrim("note") <> '')
);
CREATE INDEX "FintracReportEvent_reportId_idx" ON "FintracReportEvent"("reportId");
ALTER TABLE "FintracReportEvent" ADD CONSTRAINT "FintracReportEvent_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "FintracReport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FintracReportEvent" ADD CONSTRAINT "FintracReportEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION require_compliance_staff(actor UUID, action TEXT) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE id = actor AND "isActive" AND role IN ('MANAGING_BROKER', 'COMPLIANCE_ADMIN')) THEN
    RAISE EXCEPTION 'COMPLIANCE_UNAUTHORIZED: % is for the compliance officer or a managing broker', action USING ERRCODE = 'ZD002';
  END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION fintrac_report_event_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_compliance_staff(NEW."actorId", 'recording a FINTRAC report');
  IF EXISTS (SELECT 1 FROM "FintracReportEvent" WHERE "reportId" = NEW."reportId") THEN
    RAISE EXCEPTION 'BANK_RULE: this report task is already closed' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER fintrac_report_event_before_insert BEFORE INSERT ON "FintracReportEvent" FOR EACH ROW EXECUTE FUNCTION fintrac_report_event_before_insert();

CREATE FUNCTION fintrac_report_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  -- Large cash / virtual currency tasks are opened by the system; suspicion and listed-person reports by compliance staff
  IF NEW.kind IN ('SUSPICIOUS_TRANSACTION', 'LISTED_PERSON_PROPERTY') THEN
    PERFORM require_compliance_staff(NEW."openedById", 'opening a FINTRAC report');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER fintrac_report_before_insert BEFORE INSERT ON "FintracReport" FOR EACH ROW EXECUTE FUNCTION fintrac_report_before_insert();

CREATE TYPE "ComplianceProgramKind" AS ENUM ('COMPLIANCE_OFFICER', 'POLICIES_APPROVED', 'RISK_ASSESSMENT', 'TRAINING', 'EFFECTIVENESS_REVIEW');

CREATE TABLE "ComplianceProgramRecord" (
  "id"             UUID NOT NULL,
  "kind"           "ComplianceProgramKind" NOT NULL,
  "effectiveDate"  DATE NOT NULL,
  "subjectUserId"  UUID,
  "title"          TEXT NOT NULL,
  "details"        TEXT NOT NULL,
  "documentFileId" UUID,
  "recordedById"   UUID NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "ComplianceProgramRecord_pkey" PRIMARY KEY ("id"),
  CONSTRAINT program_subject CHECK ("kind" NOT IN ('COMPLIANCE_OFFICER', 'TRAINING') OR "subjectUserId" IS NOT NULL),
  CONSTRAINT program_text CHECK (btrim("title") <> '' AND btrim("details") <> '')
);
CREATE INDEX "ComplianceProgramRecord_kind_effectiveDate_idx" ON "ComplianceProgramRecord"("kind", "effectiveDate");
ALTER TABLE "ComplianceProgramRecord" ADD CONSTRAINT "ComplianceProgramRecord_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplianceProgramRecord" ADD CONSTRAINT "ComplianceProgramRecord_documentFileId_fkey" FOREIGN KEY ("documentFileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComplianceProgramRecord" ADD CONSTRAINT "ComplianceProgramRecord_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION program_record_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_compliance_staff(NEW."recordedById", 'recording the FINTRAC compliance program');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER program_record_before_insert BEFORE INSERT ON "ComplianceProgramRecord" FOR EACH ROW EXECUTE FUNCTION program_record_before_insert();

-- ── Append-only ──────────────────────────────────────────────────────────────

CREATE TRIGGER tresa_disclosure_immutable BEFORE UPDATE OR DELETE ON "TresaDisclosure" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER seller_direction_immutable BEFORE UPDATE OR DELETE ON "SellerOfferDirection" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER agreement_immutable BEFORE UPDATE OR DELETE ON "RepresentationAgreement" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER fintrac_determination_immutable BEFORE UPDATE OR DELETE ON "FintracDetermination" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER rof_immutable BEFORE UPDATE OR DELETE ON "ReceiptOfFundsRecord" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER fintrac_report_immutable BEFORE UPDATE OR DELETE ON "FintracReport" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER fintrac_report_event_immutable BEFORE UPDATE OR DELETE ON "FintracReportEvent" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER program_record_immutable BEFORE UPDATE OR DELETE ON "ComplianceProgramRecord" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

GRANT SELECT, INSERT ON "TresaDisclosure", "SellerOfferDirection", "RepresentationAgreement", "FintracDetermination",
  "ReceiptOfFundsRecord", "FintracReport", "FintracReportEvent", "ComplianceProgramRecord" TO zareh_app;

COMMIT;
