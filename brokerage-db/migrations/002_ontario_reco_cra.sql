-- 002 – Ontario compliance: PRECs, HST (CRA) and TRESA deposit holder (RECO)
-- Applies on top of schema.prisma v1 + constraints.sql. Runs in one transaction.

BEGIN;

-- ── 1. Users: Personal Real Estate Corporations + HST registration ─────────
ALTER TABLE "User"
  ADD COLUMN "isPrec"        BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN "precLegalName" VARCHAR(200),
  ADD COLUMN "hstNumber"     VARCHAR(15);

-- A PREC has to be paid in its registered legal name
ALTER TABLE "User" ADD CONSTRAINT user_prec_needs_legal_name
  CHECK (NOT "isPrec" OR NULLIF(btrim("precLegalName"), '') IS NOT NULL);

-- CRA format: 9-digit business number + RT program + 4-digit account
ALTER TABLE "User" ADD CONSTRAINT user_hst_number_format
  CHECK ("hstNumber" IS NULL OR "hstNumber" ~ '^[0-9]{9}RT[0-9]{4}$');

-- ── 2. Transactions: HST collected on gross commission ────────────────────
ALTER TABLE "Transaction"
  ADD COLUMN "hstOnGci" DECIMAL(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE "Transaction" ADD CONSTRAINT txn_hst_range
  CHECK ("hstOnGci" >= 0 AND "hstOnGci" <= "totalGci");

-- Backfill existing deals at 13% Ontario HST. Review any out-of-province
-- or zero-rated deals by hand after running.
UPDATE "Transaction" SET "hstOnGci" = round("totalGci" * 0.13, 2);

-- ── 3. Transactions: who legally holds the deposit (TRESA) ───────────────
-- The column already existed as "depositHolder" with OUR_BROKERAGE /
-- COOP_BROKERAGE / LAWYER / BUILDER. Renamed instead of duplicated so
-- existing data is kept and there is one source of truth. BUILDER stays
-- for pre-construction deposits.
ALTER TABLE "Transaction" RENAME COLUMN "depositHolder" TO "trustDepositHolder";

COMMIT;
