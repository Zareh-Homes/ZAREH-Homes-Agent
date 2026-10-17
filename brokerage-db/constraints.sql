-- Rules Prisma can't express. Run as a migration after `prisma migrate dev`.

-- A document slot belongs to exactly one listing OR one deal
ALTER TABLE "DocumentSlot" ADD CONSTRAINT slot_one_parent
  CHECK (("listingId" IS NULL) <> ("transactionId" IS NULL));

-- Money sanity
ALTER TABLE "TrustLedgerEntry" ADD CONSTRAINT trust_amount_positive CHECK (amount > 0);
ALTER TABLE "TrustLedgerEntry" ADD CONSTRAINT receipt_only_on_deposits
  CHECK ("receiptNumber" IS NULL OR "entryType" = 'DEPOSIT_RECEIVED');
ALTER TABLE "TransactionAgent" ADD CONSTRAINT split_range CHECK ("splitPct" BETWEEN 0 AND 100);

-- Sequential trust receipt numbers
CREATE SEQUENCE trust_receipt_seq START 1000;
-- app calls nextval('trust_receipt_seq') when inserting a DEPOSIT_RECEIVED entry

-- Trust ledger is append-only: corrections are REVERSAL entries, never edits.
-- Only sign-off and bank-match fields may be filled in after insert.
CREATE OR REPLACE FUNCTION trust_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Trust ledger entries cannot be deleted';
  END IF;
  IF (NEW.amount, NEW."entryType", NEW."transactionId", NEW."trustAccountId",
      NEW."effectiveDate", NEW.counterparty, NEW."receiptNumber")
     IS DISTINCT FROM
     (OLD.amount, OLD."entryType", OLD."transactionId", OLD."trustAccountId",
      OLD."effectiveDate", OLD.counterparty, OLD."receiptNumber") THEN
    RAISE EXCEPTION 'Trust ledger entries are immutable; post a REVERSAL instead';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trust_ledger_immutable
  BEFORE UPDATE OR DELETE ON "TrustLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION trust_ledger_guard();

-- Trust balance per deal (what we're holding right now)
CREATE VIEW deal_trust_balance AS
SELECT t.id AS "transactionId",
       t."dealNumber",
       COALESCE(SUM(CASE e."entryType"
         WHEN 'DEPOSIT_RECEIVED' THEN e.amount
         WHEN 'REVERSAL' THEN
           CASE r."entryType" WHEN 'DEPOSIT_RECEIVED' THEN -e.amount ELSE e.amount END
         ELSE -e.amount END), 0) AS balance
FROM "Transaction" t
LEFT JOIN "TrustLedgerEntry" e ON e."transactionId" = t.id
LEFT JOIN "TrustLedgerEntry" r ON r.id = e."reversesEntryId"
GROUP BY t.id, t."dealNumber";

-- Fast "what's still missing" queue for file reviewers
CREATE INDEX slot_open_queue ON "DocumentSlot" ("transactionId")
  WHERE status IN ('MISSING', 'PENDING', 'REJECTED') AND "isRequired";
