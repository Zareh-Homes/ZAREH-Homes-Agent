-- 025 – Broker of record reviews, the full written disclosure of multiple representation, and a second trust account
--
-- "BrokerReview": a consent to multiple representation signed after the multiple representation arose stays
-- blocking until the broker of record reviews what was done for the clients in between and records the outcome:
--   NO_STEPS_TAKEN               nothing was done for either client between the conflict arising and the consent
--   STEPS_TAKEN_CONTRAVENTION    something was: kept on the deal as a contravention for the broker's follow-up
-- Only an active managing broker may record one (database rule). Append-only.
--
-- The written disclosure of multiple representation must also record that it told the client they don't have to
-- consent (and their options if they don't), and that the client was given a copy (RECO Bulletin 3.2). Applies to
-- disclosures recorded from now on.
--
-- "TrustAccount"."registrarConsentReference": a brokerage keeps one real estate trust account unless the registrar
-- consents in writing to more (O. Reg. 567/05); the second and later accounts carry that consent's reference.
--
-- Applies on top of 024.

BEGIN;

CREATE TABLE "BrokerReview" (
  "id"            UUID NOT NULL,
  "transactionId" UUID NOT NULL,
  "subject"       TEXT NOT NULL,
  "partyId"       UUID,
  "offerId"       UUID,
  "outcome"       TEXT NOT NULL,
  "note"          TEXT NOT NULL,
  "reviewedById"  UUID NOT NULL,
  "reviewedAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "BrokerReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BrokerReview_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BrokerReview_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "TransactionParty"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BrokerReview_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BrokerReview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT broker_review_subject CHECK ("subject" IN ('MULTIPLE_REPRESENTATION_LATE')),
  CONSTRAINT broker_review_outcome CHECK ("outcome" IN ('NO_STEPS_TAKEN', 'STEPS_TAKEN_CONTRAVENTION')),
  CONSTRAINT broker_review_target CHECK (("partyId" IS NULL) <> ("offerId" IS NULL)),
  CONSTRAINT broker_review_note CHECK (btrim("note") <> '')
);
CREATE INDEX "BrokerReview_transactionId_idx" ON "BrokerReview"("transactionId");

CREATE FUNCTION broker_review_by_broker() RETURNS trigger AS $$
BEGIN
  NEW."reviewedAt" := clock_timestamp();
  IF NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = NEW."reviewedById" AND u."isActive" AND u.role = 'MANAGING_BROKER') THEN
    RAISE EXCEPTION 'BROKER_REVIEW_UNAUTHORIZED: only a managing broker records this review' USING ERRCODE = 'ZD002';
  END IF;
  IF NEW."partyId" IS NOT NULL AND (SELECT "transactionId" FROM "TransactionParty" WHERE id = NEW."partyId") <> NEW."transactionId" THEN
    RAISE EXCEPTION 'BANK_RULE: that party is on another deal' USING ERRCODE = 'ZB001';
  END IF;
  IF NEW."offerId" IS NOT NULL AND (SELECT "listingDealId" FROM "Offer" WHERE id = NEW."offerId") <> NEW."transactionId" THEN
    RAISE EXCEPTION 'BANK_RULE: that offer is on another listing' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER broker_review_by_broker BEFORE INSERT ON "BrokerReview" FOR EACH ROW EXECUTE FUNCTION broker_review_by_broker();

-- The full written disclosure, for disclosures recorded from now on
ALTER TABLE "TresaDisclosure" ADD CONSTRAINT disclosure_multiple_representation_complete CHECK (
  "kind" <> 'MULTIPLE_REPRESENTATION_DISCLOSURE'
  OR "confirms" @> ARRAY['DUTIES', 'SERVICES', 'REMUNERATION', 'INDEPENDENT_ADVICE', 'NO_OBLIGATION_TO_CONSENT', 'COPY_GIVEN']) NOT VALID;

ALTER TABLE "TrustAccount" ADD COLUMN "registrarConsentReference" TEXT;

GRANT SELECT, INSERT ON "BrokerReview" TO zareh_app;

COMMIT;
