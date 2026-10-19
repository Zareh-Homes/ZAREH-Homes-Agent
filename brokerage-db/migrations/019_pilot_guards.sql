-- 019 – Pilot guards
--
--   • LEASE_SETTLEMENT policy, off by default. Lease deals can still be recorded (deal, documents,
--     offers, trade record) and their deposit received into trust, but nothing is paid out of trust
--     for a lease and no lease CDA can be issued until the broker of record turns this on, citing
--     counsel's sign-off on three open questions (docs/pilot-scope.md):
--       1. whether commission may be taken from the first and last month's rent held in trust, and on
--          what written direction from the landlord;
--       2. how the tenant's entitlement to that money is protected if the lease doesn't proceed, and
--          that the last month's rent deposit is passed to the landlord intact (Residential Tenancies
--          Act s.106);
--       3. that the commission used is the one in the signed listing / commission agreement.
--     A refund of the deposit to the payer (with a mutual release or court order) stays allowed: it
--     protects the tenant.
--     Historical lease payouts loaded by the Lone Wolf migration tool (run as the schema owner, which
--     sets zareh.historical_import) are records of the past, not new settlements, and are allowed.
--     The application's restricted login can never use that exemption.
--   • A commission receipt can't be recorded twice for the same closing with the same reference: a
--     double-submitted form, or the same cheque entered twice, is refused instead of counted twice.
--
-- Applies on top of 018.

BEGIN;

ALTER TABLE "FinancialPolicyDecision" DROP CONSTRAINT policy_known;
ALTER TABLE "FinancialPolicyDecision" ADD CONSTRAINT policy_known CHECK ("policy" IN (
  'SOLE_OPERATOR_EXCEPTION', 'THIRD_PARTY_PAYABLES', 'COMMISSION_TRUST_ACCOUNT', 'CIVIC_HOLIDAY_IS_HOLIDAY',
  'UNCLAIMED_MONEY_REMITTANCE', 'MANUAL_OBLIGATIONS_PROCEDURE', 'LEASE_SETTLEMENT'));

CREATE FUNCTION require_lease_settlement_policy(deal UUID, what TEXT) RETURNS void AS $$
BEGIN
  IF current_setting('zareh.historical_import', true) = 'lonewolf' AND NOT pg_has_role(current_user, 'zareh_app', 'MEMBER') THEN
    RETURN;
  END IF;
  IF (SELECT side FROM "Transaction" WHERE id = deal) IN ('LANDLORD', 'TENANT') AND NOT policy_enabled('LEASE_SETTLEMENT') THEN
    RAISE EXCEPTION 'POLICY_NOT_APPROVED: % on a lease stays disabled until the broker of record records counsel''s sign-off (LEASE_SETTLEMENT)', what
      USING ERRCODE = 'ZP001';
  END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION lease_disbursement_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."entryType" IN ('DISBURSEMENT_TO_GENERAL', 'DISBURSEMENT_TO_COOP', 'DISBURSEMENT_TO_LAWYER', 'DISBURSEMENT_TO_LANDLORD') THEN
    PERFORM require_lease_settlement_policy(NEW."transactionId", 'Paying money out of trust');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lease_disbursement_guard BEFORE INSERT ON "TrustLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION lease_disbursement_guard();

CREATE FUNCTION lease_closing_guard() RETURNS trigger AS $$
BEGIN
  PERFORM require_lease_settlement_policy(NEW."transactionId", 'Issuing a CDA');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER lease_closing_guard BEFORE INSERT ON "ClosingStatement"
  FOR EACH ROW EXECUTE FUNCTION lease_closing_guard();

CREATE UNIQUE INDEX "CommissionReceipt_closing_reference_key" ON "CommissionReceipt"("closingId", lower(btrim(reference)));

COMMIT;
