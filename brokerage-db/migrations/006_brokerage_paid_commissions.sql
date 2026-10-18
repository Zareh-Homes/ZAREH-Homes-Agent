-- 006 – Commission is paid to the brokerage, and the brokerage pays its agents
--
--   • Closing payers (lawyers, listing brokerages) pay the brokerage only: a
--     finalized closing can no longer record any part of an agent's payout as
--     wired directly by the lawyer.
--   • CommissionReceipt: the commission payment the brokerage actually received
--     for a finalized closing (amount, date, bank reference). Append-only.
--   • AgentPayoutEvent: each agent payout is APPROVED by an active managing
--     broker, then marked PAID with a payment reference. Calculating a payout
--     and approving it are separate actions. A payout can't be approved until
--     the closing's commission has been received in full. Append-only.
--
-- Applies on top of 005.

BEGIN;

-- ── No direct-to-agent payments ──────────────────────────────────────────────

ALTER TABLE "ClosingAgentPayout" ADD CONSTRAINT payout_paid_by_brokerage
  CHECK ("wiredByLawyer" = 0 AND "paidByBrokerage" = "netPayout") NOT VALID;

-- ── Commission received ──────────────────────────────────────────────────────

CREATE TABLE "CommissionReceipt" (
  "id"           UUID NOT NULL,
  "closingId"    UUID NOT NULL,
  "amount"       DECIMAL(12, 2) NOT NULL,
  "receivedDate" DATE NOT NULL,
  "reference"    TEXT NOT NULL,
  "recordedById" UUID NOT NULL,
  "recordedAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "CommissionReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT receipt_amount_positive CHECK ("amount" > 0),
  CONSTRAINT receipt_reference_present CHECK (btrim("reference") <> '')
);
CREATE INDEX "CommissionReceipt_closingId_idx" ON "CommissionReceipt"("closingId");
ALTER TABLE "CommissionReceipt" ADD CONSTRAINT "CommissionReceipt_closingId_fkey"
  FOREIGN KEY ("closingId") REFERENCES "ClosingStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CommissionReceipt" ADD CONSTRAINT "CommissionReceipt_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What the payer owes the brokerage under a finalized closing
CREATE FUNCTION closing_amount_due(closing UUID) RETURNS DECIMAL(12, 2) AS $$
  SELECT (COALESCE((computation ->> 'wiresTotal')::bigint, 0) / 100.0)::DECIMAL(12, 2)
    FROM "ClosingStatement" WHERE id = closing
$$ LANGUAGE sql STABLE;

CREATE FUNCTION closing_amount_received(closing UUID) RETURNS DECIMAL(12, 2) AS $$
  SELECT COALESCE(SUM(amount), 0)::DECIMAL(12, 2) FROM "CommissionReceipt" WHERE "closingId" = closing
$$ LANGUAGE sql STABLE;

CREATE FUNCTION commission_receipt_before_insert() RETURNS trigger AS $$
DECLARE
  actor_role   "UserRole";
  actor_active boolean;
  due          DECIMAL(12, 2);
  received     DECIMAL(12, 2);
BEGIN
  NEW."recordedAt" := clock_timestamp();
  SELECT role, "isActive" INTO actor_role, actor_active FROM "User" WHERE id = NEW."recordedById";
  IF actor_role NOT IN ('ADMIN', 'MANAGING_BROKER') OR actor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'PAYOUT_UNAUTHORIZED: only an active admin or managing broker can record commission received'
      USING ERRCODE = 'ZD002';
  END IF;
  PERFORM 1 FROM "ClosingStatement" WHERE id = NEW."closingId" FOR UPDATE;
  due := closing_amount_due(NEW."closingId");
  received := closing_amount_received(NEW."closingId");
  IF received + NEW.amount > due THEN
    RAISE EXCEPTION 'PAYOUT_RULE: receipts of % would exceed the % due under this closing', received + NEW.amount, due
      USING ERRCODE = 'ZD004';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER commission_receipt_before_insert
  BEFORE INSERT ON "CommissionReceipt" FOR EACH ROW EXECUTE FUNCTION commission_receipt_before_insert();
CREATE TRIGGER commission_receipt_immutable BEFORE UPDATE OR DELETE ON "CommissionReceipt"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER commission_receipt_no_truncate BEFORE TRUNCATE ON "CommissionReceipt"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

-- ── Payout approval and payment ──────────────────────────────────────────────

CREATE TYPE "PayoutEventKind" AS ENUM ('APPROVED', 'PAID');

CREATE TABLE "AgentPayoutEvent" (
  "id"         UUID NOT NULL,
  "payoutId"   UUID NOT NULL,
  "kind"       "PayoutEventKind" NOT NULL,
  "actorId"    UUID NOT NULL,
  "eventDate"  DATE NOT NULL,
  "reference"  TEXT,
  "note"       TEXT,
  "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "AgentPayoutEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT payout_paid_needs_reference CHECK ("kind" <> 'PAID' OR NULLIF(btrim("reference"), '') IS NOT NULL)
);
CREATE UNIQUE INDEX "AgentPayoutEvent_payoutId_kind_key" ON "AgentPayoutEvent"("payoutId", "kind");
ALTER TABLE "AgentPayoutEvent" ADD CONSTRAINT "AgentPayoutEvent_payoutId_fkey"
  FOREIGN KEY ("payoutId") REFERENCES "ClosingAgentPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentPayoutEvent" ADD CONSTRAINT "AgentPayoutEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION agent_payout_event_before_insert() RETURNS trigger AS $$
DECLARE
  actor_role   "UserRole";
  actor_active boolean;
  closing      UUID;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT role, "isActive" INTO actor_role, actor_active FROM "User" WHERE id = NEW."actorId";
  SELECT "closingId" INTO closing FROM "ClosingAgentPayout" WHERE id = NEW."payoutId" FOR UPDATE;

  IF NEW.kind = 'APPROVED' THEN
    IF actor_role IS DISTINCT FROM 'MANAGING_BROKER' OR actor_active IS NOT TRUE THEN
      RAISE EXCEPTION 'PAYOUT_UNAUTHORIZED: only an active managing broker can approve an agent payout'
        USING ERRCODE = 'ZD002';
    END IF;
    IF closing_amount_received(closing) < closing_amount_due(closing) THEN
      RAISE EXCEPTION 'PAYOUT_RULE: the commission for this closing has not been received in full (% of %)',
        closing_amount_received(closing), closing_amount_due(closing) USING ERRCODE = 'ZD004';
    END IF;
  ELSE
    IF actor_role NOT IN ('ADMIN', 'MANAGING_BROKER') OR actor_active IS NOT TRUE THEN
      RAISE EXCEPTION 'PAYOUT_UNAUTHORIZED: only an active admin or managing broker can record a payment'
        USING ERRCODE = 'ZD002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "AgentPayoutEvent" WHERE "payoutId" = NEW."payoutId" AND kind = 'APPROVED') THEN
      RAISE EXCEPTION 'PAYOUT_RULE: a payout must be approved before it is paid' USING ERRCODE = 'ZD004';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_payout_event_before_insert
  BEFORE INSERT ON "AgentPayoutEvent" FOR EACH ROW EXECUTE FUNCTION agent_payout_event_before_insert();
CREATE TRIGGER agent_payout_event_immutable BEFORE UPDATE OR DELETE ON "AgentPayoutEvent"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER agent_payout_event_no_truncate BEFORE TRUNCATE ON "AgentPayoutEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

COMMIT;
