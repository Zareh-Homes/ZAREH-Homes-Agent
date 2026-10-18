-- 007 – Where a deal's HST figure came from
--
-- Migrated history must not present an estimate as a recorded amount. Each
-- deal records the source of "hstOnGci":
--
--   CALCULATED          set by this system (new deals)
--   RECORDED            taken as-is from the legacy record
--   DERIVED_FROM_TOTAL  legacy record only had a combined total; split by arithmetic
--   MISSING             not in the legacy record; "hstOnGci" is NULL until verified
--
-- Applies on top of 006.

BEGIN;

CREATE TYPE "TaxAmountSource" AS ENUM ('CALCULATED', 'RECORDED', 'DERIVED_FROM_TOTAL', 'MISSING');

ALTER TABLE "Transaction"
  ADD COLUMN "hstSource" "TaxAmountSource" NOT NULL DEFAULT 'CALCULATED',
  ALTER COLUMN "hstOnGci" DROP NOT NULL;

ALTER TABLE "Transaction" ADD CONSTRAINT txn_hst_source CHECK (("hstOnGci" IS NULL) = ("hstSource" = 'MISSING'));

COMMIT;
