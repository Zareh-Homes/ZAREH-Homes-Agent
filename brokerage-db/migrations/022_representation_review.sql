-- 022 – Review of same-brokerage deals: consent evidence, how each of our buyers is represented, who pays each
--        side's commission, and trade record item 10
--
-- Consent to multiple representation (per client, or per offer) now needs:
--   "situationAroseOn"   when the multiple representation arose, so a consent signed later is reviewed against
--                        that date rather than the offer date
--   "documentFileId"     the signed disclosure and consent, uploaded to the deal's "Representation disclosures and
--                        consents" slot (the file must be on this deal)
-- The written disclosure of multiple representation records what it explained ("confirms"): the changes in
-- duties, services and remuneration, and the advice to get independent professional advice.
-- Two new disclosures: each client's written disclosure of the remuneration terms in both representation
-- agreements (RECO Bulletin 3.3), and, per written offer, the seller's remuneration terms that change with who
-- represents the buyer.
--
-- Offers from a buyer this brokerage represents record how that buyer is represented ("buyerRepresentation",
-- "buyerAgentIds"), so multiple representation between competing buyers, or between the seller and a buyer, is
-- decided from who actually represents whom.
--
-- Both-sides deals record who pays the buyer side: "buyerSideSellerPays" is the part of the buyer-side commission
-- the seller agreed to pay (the buyer pays the rest under their own agreement), with "remunerationSource" saying
-- where each obligation is written. Nothing is assumed: both are required on a both-sides deal.
--
-- Trade record item 10 (O. Reg. 579/05 s.17(1)): the scheduled completion date and any amended completion date.
--
-- Applies on top of 021.

ALTER TYPE "DisclosureKind" ADD VALUE IF NOT EXISTS 'REMUNERATION_DISCLOSURE';
ALTER TYPE "DisclosureKind" ADD VALUE IF NOT EXISTS 'VARIABLE_REMUNERATION_DISCLOSURE';

BEGIN;

-- ── Consent evidence ────────────────────────────────────────────────────────
ALTER TABLE "TresaDisclosure" ADD COLUMN "situationAroseOn" DATE, ADD COLUMN "confirms" TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE "TresaDisclosure" DROP CONSTRAINT disclosure_target;
ALTER TABLE "TresaDisclosure" ADD CONSTRAINT disclosure_target CHECK (
  ("kind" IN ('COMPETING_OFFERS_NUMBER', 'COMPETING_OFFERS_CONTENT', 'SAME_BROKERAGE_REPRESENTATION', 'COMPETING_BUYERS_CONSENT',
              'VARIABLE_REMUNERATION_DISCLOSURE')) = ("offerId" IS NOT NULL)
  AND ("offerId" IS NULL OR "partyId" IS NULL)
  AND ("kind" NOT IN ('INFORMATION_GUIDE', 'SELF_REPRESENTED_PARTY_FORM', 'MULTIPLE_REPRESENTATION_DISCLOSURE', 'MULTIPLE_REPRESENTATION_CONSENT',
                      'REMUNERATION_DISCLOSURE')
       OR "partyId" IS NOT NULL));

ALTER TABLE "TresaDisclosure" ADD CONSTRAINT disclosure_consent_evidence CHECK (
  "kind" NOT IN ('MULTIPLE_REPRESENTATION_CONSENT', 'COMPETING_BUYERS_CONSENT')
  OR ("acknowledgedAt" IS NOT NULL AND "situationAroseOn" IS NOT NULL AND "documentFileId" IS NOT NULL));
ALTER TABLE "TresaDisclosure" ADD CONSTRAINT disclosure_multiple_representation_explained CHECK (
  "kind" <> 'MULTIPLE_REPRESENTATION_DISCLOSURE'
  OR "confirms" @> ARRAY['DUTIES', 'SERVICES', 'REMUNERATION', 'INDEPENDENT_ADVICE']);
ALTER TABLE "TresaDisclosure" ADD CONSTRAINT disclosure_remuneration_content CHECK (
  "kind" NOT IN ('REMUNERATION_DISCLOSURE', 'VARIABLE_REMUNERATION_DISCLOSURE') OR NULLIF(btrim("content"), '') IS NOT NULL);

-- The signed consent must be a file on this deal
CREATE OR REPLACE FUNCTION tresa_consent_recorder() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IN ('MULTIPLE_REPRESENTATION_CONSENT', 'COMPETING_BUYERS_CONSENT') THEN
    IF NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = NEW."recordedById" AND u."isActive"
                    AND u.role IN ('MANAGING_BROKER', 'COMPLIANCE_ADMIN')) THEN
      RAISE EXCEPTION 'CONSENT_UNAUTHORIZED: written consent to multiple representation is recorded by a managing broker or compliance admin after seeing the signed consent'
        USING ERRCODE = 'ZD002';
    END IF;
    IF NEW."documentFileId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "DocumentFile" f JOIN "DocumentSlot" s ON s.id = f."slotId"
                    WHERE f.id = NEW."documentFileId" AND s."transactionId" = NEW."transactionId") THEN
      RAISE EXCEPTION 'BANK_RULE: the signed consent must be a document uploaded to this deal' USING ERRCODE = 'ZB001';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Where signed disclosures and consents are uploaded; the slot is added to a deal only when consent is needed
INSERT INTO "DocumentType" (id, code, name, "formNumber", "requiredFor", "slotScope", "metadataKind", "sortOrder") VALUES
  (gen_random_uuid(), 'REPRESENTATION_CONSENTS', 'Multiple representation: signed disclosures and consents', NULL,
     ARRAY[]::"DealSide"[], 'DEAL', 'NONE', 35)
ON CONFLICT (code) DO NOTHING;

-- ── How each buyer of ours making an offer is represented ───────────────────
ALTER TABLE "Offer" ADD COLUMN "buyerRepresentation" TEXT, ADD COLUMN "buyerAgentIds" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "Offer" ADD CONSTRAINT offer_buyer_representation CHECK (
  ("buyerRepresentation" IS NULL OR ("fromOurBrokerage" AND "buyerRepresentation" IN ('BROKERAGE', 'DESIGNATED')))
  AND ("buyerRepresentation" IS DISTINCT FROM 'DESIGNATED' OR cardinality("buyerAgentIds") > 0)
  AND ("fromOurBrokerage" OR cardinality("buyerAgentIds") = 0));

-- ── Who pays each side on a both-sides deal ─────────────────────────────────
ALTER TABLE "Transaction"
  ADD COLUMN "buyerSideSellerPays" DECIMAL(12, 2),
  ADD COLUMN "remunerationSource" TEXT,
  ADD COLUMN "sellerRemunerationVaries" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Transaction" ADD CONSTRAINT deal_buyer_side_payer CHECK (
  ("buyerSideGci" IS NULL AND "buyerSideSellerPays" IS NULL)
  OR ("buyerSideGci" IS NOT NULL AND "buyerSideSellerPays" IS NOT NULL
      AND "buyerSideSellerPays" >= 0 AND "buyerSideSellerPays" <= "buyerSideGci"
      AND NULLIF(btrim("remunerationSource"), '') IS NOT NULL));
ALTER TABLE "Transaction" ADD CONSTRAINT deal_variable_remuneration CHECK (
  NOT "sellerRemunerationVaries" OR side IN ('LISTING', 'DUAL'));

ALTER TABLE "DealAmendment" DROP CONSTRAINT amendment_field;
ALTER TABLE "DealAmendment" ADD CONSTRAINT amendment_field CHECK ("field" IN
  ('SALE_PRICE', 'CLOSE_DATE', 'DEPOSIT_AMOUNT', 'DEPOSIT_DUE_DATE', 'TOTAL_GCI', 'COOP_COMMISSION', 'LISTING_SIDE_GCI', 'BUYER_SIDE_GCI',
   'BUYER_SIDE_SELLER_PAYS', 'OTHER'));

-- ── Trade record item 10 ────────────────────────────────────────────────────
ALTER TABLE "TradeRecordCorrection" DROP CONSTRAINT trs_correction_item;
ALTER TABLE "TradeRecordCorrection" ADD CONSTRAINT trs_correction_item CHECK ("item" IN ('natureOfTrade', 'property', 'consideration',
  'parties', 'lawyers', 'registrants', 'deposit', 'brokerageRemuneration', 'otherBrokerageRemuneration', 'completionDate', 'additionalItems'));

COMMIT;
