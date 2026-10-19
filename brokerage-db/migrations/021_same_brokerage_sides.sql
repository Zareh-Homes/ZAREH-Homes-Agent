-- 021 – Same-brokerage deals: each side's commission and agents, and who may record consent
--
-- When our brokerage acts for both seller and buyer (side DUAL), each side earns its own remuneration under
-- its own representation agreement, and the agents on each side are paid from that side only:
--   "Transaction"."listingSideGci" / "buyerSideGci"  each side's commission before tax (DUAL only; they add up
--                                                  to totalGci, so the commission is billed and counted once)
--   "TransactionAgent".side                         LISTING, BUYER or BOTH (one agent, or a team, on both sides)
--   "TransactionAgent"."gciSharePct"                the agent's share of their side's commission (of the whole
--                                                  commission on other deals); shares in each group add up to 100
--
-- Whether the deal is multiple representation is decided from the representation agreements (brokerage,
-- designated, mixed), not from DUAL alone; see backend/src/obligations/tresa.ts.
--
-- Written consent to multiple representation is a decision the brokerage confirms, not one an agent can
-- record for their own deal: only an active managing broker or compliance admin may record it, after seeing
-- the signed consent. The same applies to the new competing-buyers consent (two buyers we represent making
-- offers on the same property), recorded against the offer.
--
-- Applies on top of 020.

-- Enum additions can't run inside the transaction that uses them
ALTER TYPE "DisclosureKind" ADD VALUE IF NOT EXISTS 'COMPETING_BUYERS_CONSENT';

BEGIN;

CREATE TYPE "DealAgentSide" AS ENUM ('LISTING', 'BUYER', 'BOTH');
ALTER TABLE "TransactionAgent" ADD COLUMN "side" "DealAgentSide";

ALTER TABLE "Transaction" ADD COLUMN "listingSideGci" DECIMAL(12, 2), ADD COLUMN "buyerSideGci" DECIMAL(12, 2);
ALTER TABLE "Transaction" ADD CONSTRAINT deal_side_gci CHECK (
  ("listingSideGci" IS NULL) = ("buyerSideGci" IS NULL)
  AND ("listingSideGci" IS NULL OR (side = 'DUAL' AND "listingSideGci" >= 0 AND "buyerSideGci" >= 0
                                    AND "listingSideGci" + "buyerSideGci" = "totalGci")));

ALTER TABLE "TresaDisclosure" DROP CONSTRAINT disclosure_target;
ALTER TABLE "TresaDisclosure" ADD CONSTRAINT disclosure_target CHECK (
  ("kind" IN ('COMPETING_OFFERS_NUMBER', 'COMPETING_OFFERS_CONTENT', 'SAME_BROKERAGE_REPRESENTATION', 'COMPETING_BUYERS_CONSENT')) = ("offerId" IS NOT NULL)
  AND ("offerId" IS NULL OR "partyId" IS NULL)
  AND ("kind" NOT IN ('INFORMATION_GUIDE', 'SELF_REPRESENTED_PARTY_FORM', 'MULTIPLE_REPRESENTATION_DISCLOSURE', 'MULTIPLE_REPRESENTATION_CONSENT')
       OR "partyId" IS NOT NULL));
ALTER TABLE "TresaDisclosure" ADD CONSTRAINT disclosure_consent_written CHECK (
  "kind" <> 'COMPETING_BUYERS_CONSENT' OR ("acknowledgedAt" IS NOT NULL AND NULLIF(btrim("content"), '') IS NOT NULL));

-- Each side's commission is amended under its own agreement (the deal's commission follows their total)
ALTER TABLE "DealAmendment" DROP CONSTRAINT amendment_field;
ALTER TABLE "DealAmendment" ADD CONSTRAINT amendment_field CHECK ("field" IN
  ('SALE_PRICE', 'CLOSE_DATE', 'DEPOSIT_AMOUNT', 'DEPOSIT_DUE_DATE', 'TOTAL_GCI', 'COOP_COMMISSION', 'LISTING_SIDE_GCI', 'BUYER_SIDE_GCI', 'OTHER'));

CREATE FUNCTION tresa_consent_recorder() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IN ('MULTIPLE_REPRESENTATION_CONSENT', 'COMPETING_BUYERS_CONSENT')
     AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = NEW."recordedById" AND u."isActive"
                      AND u.role IN ('MANAGING_BROKER', 'COMPLIANCE_ADMIN')) THEN
    RAISE EXCEPTION 'CONSENT_UNAUTHORIZED: written consent to multiple representation is recorded by a managing broker or compliance admin after seeing the signed consent'
      USING ERRCODE = 'ZD002';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER tresa_consent_recorder BEFORE INSERT ON "TresaDisclosure" FOR EACH ROW EXECUTE FUNCTION tresa_consent_recorder();

COMMIT;
