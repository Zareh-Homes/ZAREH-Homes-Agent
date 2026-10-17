-- 005 – Closing and Commission Disbursement Authorization (CDA)
--
--   • Agent commission plans (annual cap + per-deal fees)
--   • Deal fields the closing needs: co-op commission, outside referral, GCI share per agent
--   • Finalized closing statements and per-agent payout rows: append-only,
--     finalized only by an active managing broker
--
-- Applies on top of 004.

BEGIN;

-- ── Deal fields ──────────────────────────────────────────────────────────────

ALTER TABLE "TransactionAgent" ADD COLUMN "gciSharePct" DECIMAL(5, 2) NOT NULL DEFAULT 100;
ALTER TABLE "TransactionAgent" ADD CONSTRAINT agent_gci_share_range CHECK ("gciSharePct" > 0 AND "gciSharePct" <= 100);
ALTER TABLE "TransactionAgent" ADD CONSTRAINT agent_split_range CHECK ("splitPct" >= 0 AND "splitPct" <= 100);

ALTER TABLE "Transaction"
  ADD COLUMN "coopCommission"       DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN "outsideReferralPayee" TEXT,
  ADD COLUMN "outsideReferralPct"   DECIMAL(5, 2);
ALTER TABLE "Transaction" ADD CONSTRAINT txn_coop_commission CHECK (
  "coopCommission" >= 0 AND ("coopCommission" = 0 OR side = 'LISTING'));
ALTER TABLE "Transaction" ADD CONSTRAINT txn_outside_referral CHECK (
  ("outsideReferralPct" IS NULL) = (NULLIF(btrim("outsideReferralPayee"), '') IS NULL)
  AND ("outsideReferralPct" IS NULL OR ("outsideReferralPct" > 0 AND "outsideReferralPct" < 100)));

-- ── Commission plans ─────────────────────────────────────────────────────────

CREATE TABLE "CommissionPlan" (
  "id"                UUID NOT NULL,
  "userId"            UUID NOT NULL,
  "annualCap"         DECIMAL(12, 2),
  "capYearStartMonth" INTEGER NOT NULL DEFAULT 1,
  "capYearStartDay"   INTEGER NOT NULL DEFAULT 1,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommissionPlan_pkey" PRIMARY KEY ("id"),
  CONSTRAINT plan_cap_positive CHECK ("annualCap" IS NULL OR "annualCap" > 0),
  -- Days 1–28 so the cap year starts on a real date every year
  CONSTRAINT plan_cap_year_start CHECK ("capYearStartMonth" BETWEEN 1 AND 12 AND "capYearStartDay" BETWEEN 1 AND 28)
);
CREATE UNIQUE INDEX "CommissionPlan_userId_key" ON "CommissionPlan"("userId");
ALTER TABLE "CommissionPlan" ADD CONSTRAINT "CommissionPlan_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CommissionPlanFee" (
  "id"     UUID NOT NULL,
  "planId" UUID NOT NULL,
  "name"   TEXT NOT NULL,
  "amount" DECIMAL(12, 2) NOT NULL,
  CONSTRAINT "CommissionPlanFee_pkey" PRIMARY KEY ("id"),
  CONSTRAINT plan_fee_positive CHECK ("amount" > 0 AND NULLIF(btrim("name"), '') IS NOT NULL)
);
CREATE INDEX "CommissionPlanFee_planId_idx" ON "CommissionPlanFee"("planId");
ALTER TABLE "CommissionPlanFee" ADD CONSTRAINT "CommissionPlanFee_planId_fkey"
  FOREIGN KEY ("planId") REFERENCES "CommissionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Closing statements ───────────────────────────────────────────────────────

CREATE TABLE "ClosingStatement" (
  "id"             UUID NOT NULL,
  "transactionId"  UUID NOT NULL,
  "cdaNumber"      TEXT NOT NULL,
  "computation"    JSONB NOT NULL,
  "computationSha" TEXT NOT NULL,
  "lawyerHtml"     TEXT NOT NULL,
  "internalHtml"   TEXT NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "finalizedById"  UUID NOT NULL,
  "finalizedAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "ClosingStatement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ClosingStatement_transactionId_key"  ON "ClosingStatement"("transactionId");
CREATE UNIQUE INDEX "ClosingStatement_cdaNumber_key"      ON "ClosingStatement"("cdaNumber");
CREATE UNIQUE INDEX "ClosingStatement_idempotencyKey_key" ON "ClosingStatement"("idempotencyKey");
ALTER TABLE "ClosingStatement" ADD CONSTRAINT "ClosingStatement_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClosingStatement" ADD CONSTRAINT "ClosingStatement_finalizedById_fkey"
  FOREIGN KEY ("finalizedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ClosingAgentPayout" (
  "id"               UUID NOT NULL,
  "closingId"        UUID NOT NULL,
  "userId"           UUID NOT NULL,
  "closeDate"        DATE NOT NULL,
  "payeeName"        TEXT NOT NULL,
  "allocatedBaseGci" DECIMAL(12, 2) NOT NULL,
  "houseSplitBase"   DECIMAL(12, 2) NOT NULL,
  "agentSplitBase"   DECIMAL(12, 2) NOT NULL,
  "agentSplitHst"    DECIMAL(12, 2) NOT NULL,
  "feesBase"         DECIMAL(12, 2) NOT NULL,
  "feesHst"          DECIMAL(12, 2) NOT NULL,
  "netPayout"        DECIMAL(12, 2) NOT NULL,
  "wiredByLawyer"    DECIMAL(12, 2) NOT NULL,
  "paidByBrokerage"  DECIMAL(12, 2) NOT NULL,
  CONSTRAINT "ClosingAgentPayout_pkey" PRIMARY KEY ("id"),
  CONSTRAINT payout_parts CHECK ("wiredByLawyer" >= 0 AND "paidByBrokerage" >= 0
                                 AND "wiredByLawyer" + "paidByBrokerage" = "netPayout")
);
CREATE INDEX "ClosingAgentPayout_userId_closeDate_idx" ON "ClosingAgentPayout"("userId", "closeDate");
ALTER TABLE "ClosingAgentPayout" ADD CONSTRAINT "ClosingAgentPayout_closingId_fkey"
  FOREIGN KEY ("closingId") REFERENCES "ClosingStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClosingAgentPayout" ADD CONSTRAINT "ClosingAgentPayout_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Triggers ─────────────────────────────────────────────────────────────────

CREATE FUNCTION closing_statement_before_insert() RETURNS trigger AS $$
DECLARE
  actor_role   "UserRole";
  actor_active boolean;
BEGIN
  NEW."finalizedAt" := clock_timestamp();
  SELECT role, "isActive" INTO actor_role, actor_active FROM "User" WHERE id = NEW."finalizedById";
  IF actor_role IS DISTINCT FROM 'MANAGING_BROKER' OR actor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'CLOSING_UNAUTHORIZED: only an active managing broker can finalize a closing'
      USING ERRCODE = 'ZT003';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Transaction" WHERE id = NEW."transactionId" AND status = 'CLOSED') THEN
    RAISE EXCEPTION 'CLOSING_RULE: deal % is not CLOSED', NEW."transactionId" USING ERRCODE = 'ZD001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER closing_statement_before_insert
  BEFORE INSERT ON "ClosingStatement" FOR EACH ROW EXECUTE FUNCTION closing_statement_before_insert();

CREATE TRIGGER closing_statement_immutable BEFORE UPDATE OR DELETE ON "ClosingStatement"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER closing_statement_no_truncate BEFORE TRUNCATE ON "ClosingStatement"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER closing_payout_immutable BEFORE UPDATE OR DELETE ON "ClosingAgentPayout"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER closing_payout_no_truncate BEFORE TRUNCATE ON "ClosingAgentPayout"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

COMMIT;
