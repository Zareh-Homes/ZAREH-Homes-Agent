-- 014 – Commission engine: effective-dated plans, adjustments, recoveries, sales tax by province and date
--
--   • CommissionPlanVersion: an agent's plan (cap, cap year, fees, standard split) from a date.
--     Changes are new versions, approved by a managing broker other than whoever proposed them,
--     and can't reach back into a closing already issued. The closing uses the version in force
--     on the deal's close date. The old one-row-per-agent CommissionPlan is copied in and frozen.
--   • CommissionAdjustment: per-deal bonuses and deductions for an agent, approved by a second
--     person, locked once the CDA is issued (void and reissue to change them).
--   • AgentRecovery: money an agent owes back (a commission recalled after the agent was paid,
--     an overpayment). Recovered by a deduction on a later closing, or repaid directly.
--   • SalesTaxRate: GST/HST by province and date. The rate on a commission is the property's
--     province on the close date; no rate on file means no CDA (never a default).
--
-- Applies on top of 013.

BEGIN;

-- ── Province of the property ─────────────────────────────────────────────────

ALTER TABLE "Transaction" ADD COLUMN "province" CHAR(2) NOT NULL DEFAULT 'ON';
ALTER TABLE "Transaction" ADD CONSTRAINT transaction_province
  CHECK ("province" IN ('ON', 'QC', 'NS', 'NB', 'MB', 'BC', 'PE', 'SK', 'AB', 'NL', 'YT', 'NT', 'NU'));

-- ── Sales tax rates ──────────────────────────────────────────────────────────

CREATE TABLE "SalesTaxRate" (
  "province"      CHAR(2) NOT NULL,
  "effectiveFrom" DATE NOT NULL,
  "rateBps"       INTEGER NOT NULL,
  "taxName"       TEXT NOT NULL,
  "source"        TEXT NOT NULL,
  CONSTRAINT "SalesTaxRate_pkey" PRIMARY KEY ("province", "effectiveFrom"),
  CONSTRAINT tax_rate_range CHECK ("rateBps" BETWEEN 0 AND 3000),
  CONSTRAINT tax_name CHECK ("taxName" IN ('HST', 'GST'))
);

-- Only rates confirmed in docs/regulatory-references.md §8. Earlier dates for provinces other than
-- Ontario weren't confirmed, so a deal there before 2025-04-01 gets no CDA until a rate is added.
INSERT INTO "SalesTaxRate" VALUES
  ('ON', '2010-07-01', 1300, 'HST', 'Ontario HST 13% (8% provincial + 5% federal) from 2010-07-01'),
  ('NS', '2025-04-01', 1400, 'HST', 'CRA Notice 342: Nova Scotia HST 14% from 2025-04-01'),
  ('NB', '2025-04-01', 1500, 'HST', 'CRA GST/HST rates (checked 2026); earlier dates not confirmed'),
  ('NL', '2025-04-01', 1500, 'HST', 'CRA GST/HST rates (checked 2026); earlier dates not confirmed'),
  ('PE', '2025-04-01', 1500, 'HST', 'CRA GST/HST rates (checked 2026); earlier dates not confirmed'),
  ('AB', '2025-04-01', 500, 'GST', 'CRA GST/HST rates (checked 2026); PST/QST not in scope'),
  ('BC', '2025-04-01', 500, 'GST', 'CRA GST/HST rates (checked 2026); PST/QST not in scope'),
  ('MB', '2025-04-01', 500, 'GST', 'CRA GST/HST rates (checked 2026); PST/QST not in scope'),
  ('SK', '2025-04-01', 500, 'GST', 'CRA GST/HST rates (checked 2026); PST/QST not in scope'),
  ('QC', '2025-04-01', 500, 'GST', 'CRA GST/HST rates (checked 2026); PST/QST not in scope'),
  ('YT', '2025-04-01', 500, 'GST', 'CRA GST/HST rates (checked 2026)'),
  ('NT', '2025-04-01', 500, 'GST', 'CRA GST/HST rates (checked 2026)'),
  ('NU', '2025-04-01', 500, 'GST', 'CRA GST/HST rates (checked 2026)');

CREATE TRIGGER sales_tax_rate_immutable BEFORE UPDATE OR DELETE ON "SalesTaxRate"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

CREATE FUNCTION sales_tax_on(p_province CHAR(2), on_date DATE) RETURNS "SalesTaxRate" AS $$
  SELECT * FROM "SalesTaxRate" WHERE province = p_province AND "effectiveFrom" <= on_date ORDER BY "effectiveFrom" DESC LIMIT 1
$$ LANGUAGE sql STABLE;

-- ── Plan versions ────────────────────────────────────────────────────────────

CREATE TABLE "CommissionPlanVersion" (
  "id"                UUID NOT NULL,
  "userId"            UUID NOT NULL,
  "effectiveFrom"     DATE NOT NULL,
  "splitBps"          INTEGER,
  "annualCap"         DECIMAL(12, 2),
  "capYearStartMonth" INTEGER NOT NULL DEFAULT 1,
  "capYearStartDay"   INTEGER NOT NULL DEFAULT 1,
  "fees"              JSONB NOT NULL DEFAULT '[]',
  "reason"            TEXT NOT NULL,
  "source"            TEXT NOT NULL DEFAULT 'APP',
  "createdById"       UUID,
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "approvedById"      UUID,
  "approvedAt"        TIMESTAMPTZ(6),
  "segregationException" BOOLEAN NOT NULL DEFAULT false,
  "exceptionReason"   TEXT,
  CONSTRAINT "CommissionPlanVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT plan_split CHECK ("splitBps" IS NULL OR "splitBps" BETWEEN 0 AND 10000),
  CONSTRAINT plan_cap CHECK ("annualCap" IS NULL OR "annualCap" >= 0),
  CONSTRAINT plan_cap_year CHECK ("capYearStartMonth" BETWEEN 1 AND 12 AND "capYearStartDay" BETWEEN 1 AND 28),
  CONSTRAINT plan_fees CHECK (jsonb_typeof("fees") = 'array'),
  CONSTRAINT plan_source CHECK ("source" IN ('APP', 'LEGACY_PLAN') AND ("source" = 'LEGACY_PLAN' OR "createdById" IS NOT NULL)),
  CONSTRAINT plan_approval CHECK (("approvedAt" IS NULL) = ("approvedById" IS NULL) OR "source" = 'LEGACY_PLAN')
);
CREATE UNIQUE INDEX "CommissionPlanVersion_userId_effectiveFrom_key" ON "CommissionPlanVersion"("userId", "effectiveFrom");
ALTER TABLE "CommissionPlanVersion" ADD CONSTRAINT "CommissionPlanVersion_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionPlanVersion" ADD CONSTRAINT "CommissionPlanVersion_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionPlanVersion" ADD CONSTRAINT "CommissionPlanVersion_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing plans carry over as in force from the start, exactly as they were
INSERT INTO "CommissionPlanVersion" (id, "userId", "effectiveFrom", "annualCap", "capYearStartMonth", "capYearStartDay", fees, reason, source)
SELECT gen_random_uuid(), p."userId", '1900-01-01', p."annualCap", p."capYearStartMonth", LEAST(p."capYearStartDay", 28),
       COALESCE((SELECT jsonb_agg(jsonb_build_object('name', f.name, 'amount', f.amount::text) ORDER BY f.name)
                   FROM "CommissionPlanFee" f WHERE f."planId" = p.id), '[]'),
       'Carried over from the plan in force before effective-dated plans (migration 014)', 'LEGACY_PLAN'
  FROM "CommissionPlan" p;

-- The old tables are history now
CREATE FUNCTION reject_legacy_plan_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY: commission plans are effective-dated versions now (CommissionPlanVersion)' USING ERRCODE = 'ZD003';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER commission_plan_frozen BEFORE INSERT OR UPDATE OR DELETE ON "CommissionPlan"
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_plan_change();
CREATE TRIGGER commission_plan_fee_frozen BEFORE INSERT OR UPDATE OR DELETE ON "CommissionPlanFee"
  FOR EACH ROW EXECUTE FUNCTION reject_legacy_plan_change();

-- An agent's latest issued closing date, on CDAs that weren't voided
CREATE FUNCTION agent_last_closing(agent UUID) RETURNS DATE AS $$
  SELECT MAX(p."closeDate") FROM "ClosingAgentPayout" p
   WHERE p."userId" = agent AND NOT EXISTS (SELECT 1 FROM "ClosingVoid" v WHERE v."closingId" = p."closingId")
$$ LANGUAGE sql STABLE;

CREATE FUNCTION plan_version_guard() RETURNS trigger AS $$
DECLARE
  fee jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    IF NEW.source <> 'APP' THEN
      RAISE EXCEPTION 'BANK_RULE: plan versions are proposed in the application' USING ERRCODE = 'ZB001';
    END IF;
    PERFORM require_bank_staff(NEW."createdById", false, 'proposing a commission plan');
    IF NEW."approvedById" IS NOT NULL THEN
      RAISE EXCEPTION 'BANK_RULE: a plan is approved after it is proposed' USING ERRCODE = 'ZB001';
    END IF;
    IF NULLIF(btrim(NEW.reason), '') IS NULL THEN
      RAISE EXCEPTION 'BANK_RULE: say why the plan is changing' USING ERRCODE = 'ZB001';
    END IF;
    FOR fee IN SELECT * FROM jsonb_array_elements(NEW.fees) LOOP
      IF NULLIF(btrim(fee->>'name'), '') IS NULL OR (fee->>'amount') !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' THEN
        RAISE EXCEPTION 'BANK_RULE: each fee needs a name and an amount' USING ERRCODE = 'ZB001';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR OLD."approvedAt" IS NOT NULL OR OLD.source = 'LEGACY_PLAN' THEN
    RAISE EXCEPTION 'APPEND_ONLY: an approved plan is changed by a new version, never edited' USING ERRCODE = 'ZD003';
  END IF;
  IF (NEW.id, NEW."userId", NEW."effectiveFrom", NEW."splitBps", NEW."annualCap", NEW."capYearStartMonth", NEW."capYearStartDay",
      NEW.fees, NEW.reason, NEW.source, NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM
     (OLD.id, OLD."userId", OLD."effectiveFrom", OLD."splitBps", OLD."annualCap", OLD."capYearStartMonth", OLD."capYearStartDay",
      OLD.fees, OLD.reason, OLD.source, OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'APPEND_ONLY: a proposed plan can only be approved, not changed' USING ERRCODE = 'ZD003';
  END IF;
  IF (SELECT role FROM "User" WHERE id = NEW."approvedById") IS DISTINCT FROM 'MANAGING_BROKER'
     OR (SELECT "isActive" FROM "User" WHERE id = NEW."approvedById") IS NOT TRUE THEN
    RAISE EXCEPTION 'PAYOUT_UNAUTHORIZED: only an active managing broker can approve a commission plan' USING ERRCODE = 'ZD002';
  END IF;
  NEW."segregationException" := require_separate_people(NEW."approvedById", NEW."createdById", NEW."exceptionReason",
    'Approving a commission plan (whoever proposed it can''t approve it)');
  IF NEW."approvedById" = NEW."userId" THEN
    RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: nobody approves their own commission plan' USING ERRCODE = 'ZD002';
  END IF;
  -- A plan can't change what an issued CDA already paid
  IF NEW."effectiveFrom" <= agent_last_closing(NEW."userId") THEN
    RAISE EXCEPTION 'BANK_RULE: this plan would apply from %, but a CDA for this agent was already issued for a closing on %; date it after that, or void and reissue that CDA',
      NEW."effectiveFrom", agent_last_closing(NEW."userId") USING ERRCODE = 'ZB001';
  END IF;
  NEW."approvedAt" := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER plan_version_guard BEFORE INSERT OR UPDATE OR DELETE ON "CommissionPlanVersion"
  FOR EACH ROW EXECUTE FUNCTION plan_version_guard();

-- The approved version in force on a date
CREATE FUNCTION plan_in_force(agent UUID, on_date DATE) RETURNS "CommissionPlanVersion" AS $$
  SELECT * FROM "CommissionPlanVersion"
   WHERE "userId" = agent AND "effectiveFrom" <= on_date AND ("approvedAt" IS NOT NULL OR source = 'LEGACY_PLAN')
   ORDER BY "effectiveFrom" DESC LIMIT 1
$$ LANGUAGE sql STABLE;

-- ── Recoveries (chargebacks) ─────────────────────────────────────────────────

CREATE TYPE "RecoveryReason" AS ENUM ('COMMISSION_RECALLED', 'OVERPAYMENT', 'OTHER');

CREATE TABLE "AgentRecovery" (
  "id"              UUID NOT NULL,
  "userId"          UUID NOT NULL,
  "sourceClosingId" UUID,
  "amount"          DECIMAL(12, 2) NOT NULL,
  "reason"          "RecoveryReason" NOT NULL,
  "note"            TEXT NOT NULL,
  "createdById"     UUID NOT NULL,
  "createdAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "AgentRecovery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT recovery_amount CHECK ("amount" > 0),
  CONSTRAINT recovery_note CHECK (btrim("note") <> '')
);
CREATE INDEX "AgentRecovery_userId_idx" ON "AgentRecovery"("userId");
ALTER TABLE "AgentRecovery" ADD CONSTRAINT "AgentRecovery_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentRecovery" ADD CONSTRAINT "AgentRecovery_sourceClosingId_fkey"
  FOREIGN KEY ("sourceClosingId") REFERENCES "ClosingStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentRecovery" ADD CONSTRAINT "AgentRecovery_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "AgentRecoveryRepayment" (
  "id"          UUID NOT NULL,
  "recoveryId"  UUID NOT NULL,
  "amount"      DECIMAL(12, 2) NOT NULL,
  "paidDate"    DATE NOT NULL,
  "reference"   TEXT NOT NULL,
  "actorId"     UUID NOT NULL,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "AgentRecoveryRepayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT repayment_amount CHECK ("amount" > 0),
  CONSTRAINT repayment_reference CHECK (btrim("reference") <> '')
);
ALTER TABLE "AgentRecoveryRepayment" ADD CONSTRAINT "AgentRecoveryRepayment_recoveryId_fkey"
  FOREIGN KEY ("recoveryId") REFERENCES "AgentRecovery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentRecoveryRepayment" ADD CONSTRAINT "AgentRecoveryRepayment_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Per-deal adjustments ─────────────────────────────────────────────────────

CREATE TYPE "AdjustmentKind" AS ENUM ('BONUS', 'DEDUCTION', 'RECOVERY');

CREATE TABLE "CommissionAdjustment" (
  "id"            UUID NOT NULL,
  "transactionId" UUID NOT NULL,
  "userId"        UUID NOT NULL,
  "kind"          "AdjustmentKind" NOT NULL,
  "description"   TEXT NOT NULL,
  "amount"        DECIMAL(12, 2) NOT NULL,
  "taxable"       BOOLEAN NOT NULL,
  "recoveryId"    UUID,
  "createdById"   UUID NOT NULL,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "approvedById"  UUID,
  "approvedAt"    TIMESTAMPTZ(6),
  "withdrawnAt"   TIMESTAMPTZ(6),
  "withdrawnById" UUID,
  CONSTRAINT "CommissionAdjustment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT adjustment_amount CHECK ("amount" > 0),
  CONSTRAINT adjustment_description CHECK (btrim("description") <> ''),
  CONSTRAINT adjustment_recovery CHECK (("kind" = 'RECOVERY') = ("recoveryId" IS NOT NULL) AND ("kind" <> 'RECOVERY' OR NOT "taxable")),
  CONSTRAINT adjustment_approval CHECK (("approvedAt" IS NULL) = ("approvedById" IS NULL)),
  CONSTRAINT adjustment_withdrawal CHECK (("withdrawnAt" IS NULL) = ("withdrawnById" IS NULL))
);
CREATE INDEX "CommissionAdjustment_transactionId_idx" ON "CommissionAdjustment"("transactionId");
ALTER TABLE "CommissionAdjustment" ADD CONSTRAINT "CommissionAdjustment_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionAdjustment" ADD CONSTRAINT "CommissionAdjustment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionAdjustment" ADD CONSTRAINT "CommissionAdjustment_recoveryId_fkey"
  FOREIGN KEY ("recoveryId") REFERENCES "AgentRecovery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionAdjustment" ADD CONSTRAINT "CommissionAdjustment_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionAdjustment" ADD CONSTRAINT "CommissionAdjustment_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionAdjustment" ADD CONSTRAINT "CommissionAdjustment_withdrawnById_fkey"
  FOREIGN KEY ("withdrawnById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What's still owed on a recovery: amount − repaid − deducted on issued (not voided) CDAs
CREATE FUNCTION recovery_outstanding(recovery UUID) RETURNS DECIMAL(12, 2) AS $$
  SELECT r.amount
       - COALESCE((SELECT SUM(amount) FROM "AgentRecoveryRepayment" WHERE "recoveryId" = r.id), 0)
       - COALESCE((SELECT SUM(a.amount) FROM "CommissionAdjustment" a
                    WHERE a."recoveryId" = r.id AND a."approvedAt" IS NOT NULL AND a."withdrawnAt" IS NULL
                      AND EXISTS (SELECT 1 FROM "ClosingStatement" c WHERE c."transactionId" = a."transactionId"
                                    AND NOT EXISTS (SELECT 1 FROM "ClosingVoid" v WHERE v."closingId" = c.id))), 0)
    FROM "AgentRecovery" r WHERE r.id = recovery
$$ LANGUAGE sql STABLE;

-- The deal's CDA is in force (issued and not voided): its adjustments are locked
CREATE FUNCTION deal_has_issued_cda(deal UUID) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "ClosingStatement" c WHERE c."transactionId" = deal
                  AND NOT EXISTS (SELECT 1 FROM "ClosingVoid" v WHERE v."closingId" = c.id))
$$ LANGUAGE sql STABLE;

CREATE FUNCTION adjustment_guard() RETURNS trigger AS $$
DECLARE
  rec "AgentRecovery"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: an adjustment is withdrawn, never deleted' USING ERRCODE = 'ZD003';
  END IF;
  IF deal_has_issued_cda(COALESCE(NEW."transactionId", OLD."transactionId")) THEN
    RAISE EXCEPTION 'PAYOUT_RULE: this deal''s CDA is issued; void and reissue it to change its adjustments' USING ERRCODE = 'ZD004';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := clock_timestamp();
    PERFORM require_bank_staff(NEW."createdById", false, 'adding a commission adjustment');
    IF NEW."approvedById" IS NOT NULL OR NEW."withdrawnById" IS NOT NULL THEN
      RAISE EXCEPTION 'BANK_RULE: an adjustment is approved after it is added' USING ERRCODE = 'ZB001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "TransactionAgent" WHERE "transactionId" = NEW."transactionId" AND "userId" = NEW."userId") THEN
      RAISE EXCEPTION 'BANK_RULE: that agent isn''t on this deal' USING ERRCODE = 'ZB001';
    END IF;
    IF NEW.kind = 'RECOVERY' THEN
      SELECT * INTO rec FROM "AgentRecovery" WHERE id = NEW."recoveryId" FOR UPDATE;
      IF rec."userId" <> NEW."userId" THEN
        RAISE EXCEPTION 'BANK_RULE: that recovery is owed by a different agent' USING ERRCODE = 'ZB001';
      END IF;
      IF NEW.amount > recovery_outstanding(rec.id) - COALESCE((
           SELECT SUM(a.amount) FROM "CommissionAdjustment" a WHERE a."recoveryId" = rec.id AND a."withdrawnAt" IS NULL
              AND NOT deal_has_issued_cda(a."transactionId")), 0) THEN
        RAISE EXCEPTION 'PAYOUT_RULE: more than is still owed on that recovery' USING ERRCODE = 'ZD004';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW."transactionId", NEW."userId", NEW.kind, NEW.description, NEW.amount, NEW.taxable, NEW."recoveryId", NEW."createdById", NEW."createdAt")
     IS DISTINCT FROM
     (OLD.id, OLD."transactionId", OLD."userId", OLD.kind, OLD.description, OLD.amount, OLD.taxable, OLD."recoveryId", OLD."createdById", OLD."createdAt") THEN
    RAISE EXCEPTION 'APPEND_ONLY: an adjustment can only be approved or withdrawn' USING ERRCODE = 'ZD003';
  END IF;
  IF OLD."withdrawnAt" IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_RULE: this adjustment was withdrawn' USING ERRCODE = 'ZB001';
  END IF;
  IF NEW."withdrawnById" IS NOT NULL THEN
    PERFORM require_bank_staff(NEW."withdrawnById", false, 'withdrawing a commission adjustment');
    NEW."withdrawnAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD."approvedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_RULE: already approved' USING ERRCODE = 'ZB001';
  END IF;
  PERFORM require_bank_staff(NEW."approvedById", true, 'approving a commission adjustment');
  PERFORM require_separate_people(NEW."approvedById", NEW."createdById", NULL, 'Approving a commission adjustment (whoever added it can''t approve it)');
  IF NEW."approvedById" = NEW."userId" THEN
    RAISE EXCEPTION 'SEGREGATION_OF_DUTIES: nobody approves an adjustment to their own commission' USING ERRCODE = 'ZD002';
  END IF;
  NEW."approvedAt" := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER adjustment_guard BEFORE INSERT OR UPDATE OR DELETE ON "CommissionAdjustment"
  FOR EACH ROW EXECUTE FUNCTION adjustment_guard();

CREATE FUNCTION recovery_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."createdById", true, 'recording money an agent owes back');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER recovery_before_insert BEFORE INSERT ON "AgentRecovery" FOR EACH ROW EXECUTE FUNCTION recovery_before_insert();

CREATE FUNCTION recovery_repayment_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_bank_staff(NEW."actorId", false, 'recording a repayment from an agent');
  PERFORM 1 FROM "AgentRecovery" WHERE id = NEW."recoveryId" FOR UPDATE;
  IF NEW.amount > recovery_outstanding(NEW."recoveryId") THEN
    RAISE EXCEPTION 'PAYOUT_RULE: more than is still owed on that recovery' USING ERRCODE = 'ZD004';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER recovery_repayment_before_insert BEFORE INSERT ON "AgentRecoveryRepayment"
  FOR EACH ROW EXECUTE FUNCTION recovery_repayment_before_insert();
CREATE TRIGGER recovery_immutable BEFORE UPDATE OR DELETE ON "AgentRecovery" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER recovery_repayment_immutable BEFORE UPDATE OR DELETE ON "AgentRecoveryRepayment"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

-- ── Grants ───────────────────────────────────────────────────────────────────

GRANT SELECT ON "SalesTaxRate" TO zareh_app;
GRANT SELECT, INSERT ON "CommissionPlanVersion", "CommissionAdjustment", "AgentRecovery", "AgentRecoveryRepayment" TO zareh_app;
GRANT UPDATE ("approvedById", "approvedAt", "segregationException", "exceptionReason") ON "CommissionPlanVersion" TO zareh_app;
GRANT UPDATE ("approvedById", "approvedAt", "withdrawnAt", "withdrawnById") ON "CommissionAdjustment" TO zareh_app;
REVOKE INSERT, UPDATE, DELETE ON "CommissionPlan", "CommissionPlanFee" FROM zareh_app;

COMMIT;
