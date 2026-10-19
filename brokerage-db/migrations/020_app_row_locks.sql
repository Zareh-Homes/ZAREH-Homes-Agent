-- 020 – Row locks for the application login
--
-- Several triggers serialize work on one record with SELECT ... FOR UPDATE (a CDA while it's voided or
-- its payouts change, a payout, a trust incident, an agent recovery, a trade record sheet, an unclaimed
-- fund). PostgreSQL only lets a role lock a row it may update, and zareh_app had INSERT and SELECT only
-- on these append-only tables, so under the restricted production login those actions failed with
-- "permission denied" (found by the staging rehearsal: voiding a CDA). Tests had run as the owner.
--
-- Granting UPDATE lets the login take the lock. It doesn't make the records changeable: every one of
-- these tables already has a BEFORE UPDATE trigger that refuses the change (reject_append_only_change)
-- or allows only the guarded status changes (trade_record_guard).
--
-- Applies on top of 019.

BEGIN;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ClosingStatement', 'ClosingAgentPayout', 'TrustIncident', 'AgentRecovery', 'TradeRecordSheet', 'UnclaimedTrustFund'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
                    WHERE c.relname = t AND NOT g.tgisinternal AND (g.tgtype & 16) = 16) THEN
      RAISE EXCEPTION 'refusing to grant UPDATE on %: it has no BEFORE UPDATE guard', t;
    END IF;
    EXECUTE format('GRANT UPDATE ON %I TO zareh_app', t);
  END LOOP;
END $$;

COMMIT;
