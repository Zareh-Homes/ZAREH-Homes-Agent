-- 018 – Lease transactions (TRESA "trade" includes leases)
--
-- Lease deals (LANDLORD / TENANT sides) already exist for the deal record, conditions, offers and the
-- trade record sheet. This adds what their money and paperwork need:
--   • DISBURSEMENT_TO_LANDLORD: on a landlord-side lease our brokerage usually holds the first and last
--     month's rent; at commencement the commission is applied from it and the balance goes to the landlord
--     (on a sale, the balance goes to the seller's lawyer instead).
--   • Deal commission figures (total GCI, co-op commission) amendable with a recorded reason.
--   • Lease forms in the compliance checklist. FINTRAC's identification and record-keeping obligations for
--     real estate apply to purchases and sales, not leases, so no FINTRAC slots are added for lease sides.
--     Form numbers are as published by OREA; the broker of record confirms the brokerage's current set.
--
-- Applies on top of 017.

-- A new enum value can't be used in the transaction that adds it
ALTER TYPE "TrustEntryType" ADD VALUE IF NOT EXISTS 'DISBURSEMENT_TO_LANDLORD' AFTER 'DISBURSEMENT_TO_LAWYER';

BEGIN;

ALTER TABLE "TrustLedgerEntry" DROP CONSTRAINT trust_disbursement_authorized;
ALTER TABLE "TrustLedgerEntry" ADD CONSTRAINT trust_disbursement_authorized CHECK (
  "entryType" NOT IN ('DISBURSEMENT_TO_GENERAL', 'DISBURSEMENT_TO_COOP', 'DISBURSEMENT_TO_LAWYER', 'DISBURSEMENT_TO_LANDLORD', 'REFUND_TO_PAYER')
  OR "authorizationMethod" IS NOT NULL);

INSERT INTO "DocumentType" (id, code, name, "formNumber", "requiredFor", "slotScope", "metadataKind", "sortOrder") VALUES
  (gen_random_uuid(), 'LEASE_LISTING', 'Listing Agreement – Authority to Offer for Lease (Form 272)', '272',
     ARRAY['LANDLORD']::"DealSide"[], 'DEAL', 'NONE', 12),
  (gen_random_uuid(), 'AGREEMENT_TO_LEASE', 'Agreement to Lease (Form 400)', '400',
     ARRAY['LANDLORD', 'TENANT']::"DealSide"[], 'DEAL', 'NONE', 22)
ON CONFLICT (code) DO NOTHING;

-- A landlord-side lease is a listing: the co-operating (tenant's) brokerage is paid from it
ALTER TABLE "Transaction" DROP CONSTRAINT txn_coop_commission;
ALTER TABLE "Transaction" ADD CONSTRAINT txn_coop_commission CHECK (
  "coopCommission" >= 0 AND ("coopCommission" = 0 OR side IN ('LISTING', 'LANDLORD')));

-- Commission figures can be corrected after the deal is opened, as a recorded amendment like any other term
-- (the API limits these two to managing brokers and admins)
ALTER TABLE "DealAmendment" DROP CONSTRAINT amendment_field;
ALTER TABLE "DealAmendment" ADD CONSTRAINT amendment_field CHECK ("field" IN
  ('SALE_PRICE', 'CLOSE_DATE', 'DEPOSIT_AMOUNT', 'DEPOSIT_DUE_DATE', 'TOTAL_GCI', 'COOP_COMMISSION', 'OTHER'));

-- Form 320 confirms co-operation and representation on leases too
UPDATE "DocumentType" SET "requiredFor" = "requiredFor" || ARRAY['TENANT']::"DealSide"[]
 WHERE code = 'FORM_320' AND NOT ('TENANT' = ANY ("requiredFor"));

COMMIT;
