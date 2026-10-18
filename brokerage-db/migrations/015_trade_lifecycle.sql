-- 015 – Transaction lifecycle and the trade record sheet
--
--   • Deal status follows the agreement: CONDITIONAL → FIRM (only once every condition is
--     fulfilled or waived) → CLOSED; CONDITIONAL or FIRM → COLLAPSED (terminated) or CANCELLED.
--     Closed, collapsed and cancelled deals don't change status again.
--   • Conditions, each with a deadline and its outcome (fulfilled, waived, extended, failed),
--     backed by the waiver / amendment / notice document.
--   • Amendments to the agreement (price, closing date, deposit), kept as history.
--   • Termination: why, how (mutual release, failed condition, default) and the document.
--   • Offers register: every written offer received on a listing, kept at least one year from
--     receipt if it wasn't accepted (O. Reg. 579/05 s.19(2)).
--   • Trade record sheet (O. Reg. 579/05 s.17): items 1–9 generated from the deal, corrections
--     appended and initialled (earlier entries stay legible), signed by the agent once no
--     conditions remain and then by the broker of record. Frozen once the broker signs.
--
-- Applies on top of 014.

BEGIN;

-- ── Status transitions ───────────────────────────────────────────────────────

CREATE TYPE "ConditionKind" AS ENUM ('FINANCING', 'INSPECTION', 'STATUS_CERTIFICATE', 'SALE_OF_BUYERS_PROPERTY', 'LAWYER_REVIEW', 'INSURANCE', 'OTHER');
CREATE TYPE "ConditionOutcome" AS ENUM ('FULFILLED', 'WAIVED', 'EXTENDED', 'FAILED');

CREATE TABLE "DealCondition" (
  "id"            UUID NOT NULL,
  "transactionId" UUID NOT NULL,
  "kind"          "ConditionKind" NOT NULL,
  "description"   TEXT NOT NULL,
  "forBenefitOf"  TEXT NOT NULL,
  "dueAt"         TIMESTAMPTZ(6) NOT NULL,
  "createdById"   UUID NOT NULL,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "DealCondition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT condition_benefit CHECK ("forBenefitOf" IN ('BUYER', 'SELLER', 'BOTH', 'LANDLORD', 'TENANT')),
  CONSTRAINT condition_description CHECK (btrim("description") <> '')
);
CREATE INDEX "DealCondition_transactionId_idx" ON "DealCondition"("transactionId");
ALTER TABLE "DealCondition" ADD CONSTRAINT "DealCondition_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealCondition" ADD CONSTRAINT "DealCondition_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "DealConditionEvent" (
  "id"          UUID NOT NULL,
  "conditionId" UUID NOT NULL,
  "outcome"     "ConditionOutcome" NOT NULL,
  "eventAt"     TIMESTAMPTZ(6) NOT NULL,
  "newDueAt"    TIMESTAMPTZ(6),
  "reference"   TEXT NOT NULL,
  "documentFileId" UUID,
  "note"        TEXT,
  "actorId"     UUID NOT NULL,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "DealConditionEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT condition_event_extension CHECK (("outcome" = 'EXTENDED') = ("newDueAt" IS NOT NULL)),
  CONSTRAINT condition_event_reference CHECK (btrim("reference") <> '')
);
CREATE INDEX "DealConditionEvent_conditionId_idx" ON "DealConditionEvent"("conditionId");
ALTER TABLE "DealConditionEvent" ADD CONSTRAINT "DealConditionEvent_conditionId_fkey"
  FOREIGN KEY ("conditionId") REFERENCES "DealCondition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealConditionEvent" ADD CONSTRAINT "DealConditionEvent_documentFileId_fkey"
  FOREIGN KEY ("documentFileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealConditionEvent" ADD CONSTRAINT "DealConditionEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A condition's state is its last event; open = no event, or last extended
CREATE FUNCTION condition_state(cond UUID) RETURNS TEXT AS $$
  SELECT COALESCE((SELECT outcome::text FROM "DealConditionEvent" WHERE "conditionId" = cond ORDER BY "createdAt" DESC LIMIT 1), 'OPEN')
$$ LANGUAGE sql STABLE;

CREATE FUNCTION deal_open_conditions(deal UUID) RETURNS INTEGER AS $$
  SELECT COUNT(*)::int FROM "DealCondition" c WHERE c."transactionId" = deal AND condition_state(c.id) IN ('OPEN', 'EXTENDED')
$$ LANGUAGE sql STABLE;

-- Who may record lifecycle events on a deal: its agents, admin, managing brokers, compliance
CREATE FUNCTION require_deal_staff(deal UUID, actor UUID, action TEXT) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id = actor AND u."isActive"
                  AND (u.role IN ('ADMIN', 'MANAGING_BROKER', 'COMPLIANCE_ADMIN')
                       OR EXISTS (SELECT 1 FROM "TransactionAgent" a WHERE a."transactionId" = deal AND a."userId" = actor))) THEN
    RAISE EXCEPTION 'DEAL_UNAUTHORIZED: % is for the deal''s agents or the brokerage''s staff', action USING ERRCODE = 'ZD002';
  END IF;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION deal_condition_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_deal_staff(NEW."transactionId", NEW."createdById", 'adding a condition');
  IF (SELECT status FROM "Transaction" WHERE id = NEW."transactionId") <> 'CONDITIONAL' THEN
    RAISE EXCEPTION 'ILLEGAL_STATUS_CHANGE: conditions are added while the deal is conditional (amend the agreement otherwise)' USING ERRCODE = 'ZD001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER deal_condition_before_insert BEFORE INSERT ON "DealCondition" FOR EACH ROW EXECUTE FUNCTION deal_condition_before_insert();

CREATE FUNCTION condition_event_before_insert() RETURNS trigger AS $$
DECLARE
  cond "DealCondition"%ROWTYPE;
  state TEXT;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT * INTO cond FROM "DealCondition" WHERE id = NEW."conditionId";
  PERFORM 1 FROM "Transaction" WHERE id = cond."transactionId" FOR UPDATE;
  PERFORM require_deal_staff(cond."transactionId", NEW."actorId", 'recording a condition outcome');
  state := condition_state(cond.id);
  IF state NOT IN ('OPEN', 'EXTENDED') THEN
    RAISE EXCEPTION 'ILLEGAL_STATUS_CHANGE: this condition is already %', lower(state) USING ERRCODE = 'ZD001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER condition_event_before_insert BEFORE INSERT ON "DealConditionEvent" FOR EACH ROW EXECUTE FUNCTION condition_event_before_insert();

CREATE FUNCTION transaction_status_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF NOT ((OLD.status = 'CONDITIONAL' AND NEW.status IN ('FIRM', 'COLLAPSED', 'CANCELLED'))
       OR (OLD.status = 'FIRM' AND NEW.status IN ('CLOSED', 'COLLAPSED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'ILLEGAL_STATUS_CHANGE: a % deal can''t become %', OLD.status, NEW.status USING ERRCODE = 'ZD001';
  END IF;
  IF NEW.status = 'FIRM' AND deal_open_conditions(NEW.id) > 0 THEN
    RAISE EXCEPTION 'ILLEGAL_STATUS_CHANGE: % condition(s) are still open; record each as fulfilled or waived first', deal_open_conditions(NEW.id)
      USING ERRCODE = 'ZD001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER transaction_status_guard BEFORE UPDATE OF status ON "Transaction" FOR EACH ROW EXECUTE FUNCTION transaction_status_guard();

-- ── Amendments and termination ───────────────────────────────────────────────

CREATE TABLE "DealAmendment" (
  "id"            UUID NOT NULL,
  "transactionId" UUID NOT NULL,
  "field"         TEXT NOT NULL,
  "oldValue"      TEXT,
  "newValue"      TEXT NOT NULL,
  "effectiveDate" DATE NOT NULL,
  "reference"     TEXT NOT NULL,
  "documentFileId" UUID,
  "actorId"       UUID NOT NULL,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "DealAmendment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT amendment_field CHECK ("field" IN ('SALE_PRICE', 'CLOSE_DATE', 'DEPOSIT_AMOUNT', 'DEPOSIT_DUE_DATE', 'OTHER')),
  CONSTRAINT amendment_reference CHECK (btrim("reference") <> '')
);
CREATE INDEX "DealAmendment_transactionId_idx" ON "DealAmendment"("transactionId");
ALTER TABLE "DealAmendment" ADD CONSTRAINT "DealAmendment_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealAmendment" ADD CONSTRAINT "DealAmendment_documentFileId_fkey"
  FOREIGN KEY ("documentFileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealAmendment" ADD CONSTRAINT "DealAmendment_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "TerminationReason" AS ENUM ('CONDITION_NOT_MET', 'MUTUAL_RELEASE', 'BUYER_DEFAULT', 'SELLER_DEFAULT', 'OTHER');

CREATE TABLE "DealTermination" (
  "transactionId"  UUID NOT NULL,
  "reason"         "TerminationReason" NOT NULL,
  "terminatedOn"   DATE NOT NULL,
  "reference"      TEXT NOT NULL,
  "documentFileId" UUID,
  "note"           TEXT NOT NULL,
  "actorId"        UUID NOT NULL,
  "createdAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "DealTermination_pkey" PRIMARY KEY ("transactionId"),
  CONSTRAINT termination_reference CHECK (btrim("reference") <> '' AND btrim("note") <> '')
);
ALTER TABLE "DealTermination" ADD CONSTRAINT "DealTermination_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealTermination" ADD CONSTRAINT "DealTermination_documentFileId_fkey"
  FOREIGN KEY ("documentFileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DealTermination" ADD CONSTRAINT "DealTermination_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION lifecycle_record_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_deal_staff(NEW."transactionId", NEW."actorId", 'changing the agreement');
  IF (SELECT status FROM "Transaction" WHERE id = NEW."transactionId") NOT IN ('CONDITIONAL', 'FIRM') THEN
    RAISE EXCEPTION 'ILLEGAL_STATUS_CHANGE: the agreement can only be amended or terminated before closing' USING ERRCODE = 'ZD001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER deal_amendment_before_insert BEFORE INSERT ON "DealAmendment" FOR EACH ROW EXECUTE FUNCTION lifecycle_record_before_insert();
CREATE TRIGGER deal_termination_before_insert BEFORE INSERT ON "DealTermination" FOR EACH ROW EXECUTE FUNCTION lifecycle_record_before_insert();

-- ── Offers register ──────────────────────────────────────────────────────────

CREATE TYPE "OfferStatus" AS ENUM ('RECEIVED', 'SIGNED_BACK', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');

CREATE TABLE "Offer" (
  "id"               UUID NOT NULL,
  "listingDealId"    UUID NOT NULL,
  "receivedAt"       TIMESTAMPTZ(6) NOT NULL,
  "written"          BOOLEAN NOT NULL,
  "offerorBrokerage" TEXT,
  "offerorSelfRepresented" BOOLEAN NOT NULL DEFAULT false,
  "price"            DECIMAL(14, 2),
  "documentFileId"   UUID,
  "recordedById"     UUID NOT NULL,
  "createdAt"        TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Offer_listingDealId_idx" ON "Offer"("listingDealId");
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_listingDealId_fkey"
  FOREIGN KEY ("listingDealId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_documentFileId_fkey"
  FOREIGN KEY ("documentFileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "OfferEvent" (
  "id"        UUID NOT NULL,
  "offerId"   UUID NOT NULL,
  "status"    "OfferStatus" NOT NULL,
  "eventAt"   TIMESTAMPTZ(6) NOT NULL,
  "note"      TEXT,
  "actorId"   UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "OfferEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OfferEvent_offerId_idx" ON "OfferEvent"("offerId");
ALTER TABLE "OfferEvent" ADD CONSTRAINT "OfferEvent_offerId_fkey"
  FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfferEvent" ADD CONSTRAINT "OfferEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION offer_status(offer UUID) RETURNS TEXT AS $$
  SELECT COALESCE((SELECT status::text FROM "OfferEvent" WHERE "offerId" = offer ORDER BY "createdAt" DESC LIMIT 1), 'RECEIVED')
$$ LANGUAGE sql STABLE;

CREATE FUNCTION offer_before_insert() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_deal_staff(NEW."listingDealId", NEW."recordedById", 'recording an offer');
  IF (SELECT side FROM "Transaction" WHERE id = NEW."listingDealId") NOT IN ('LISTING', 'DUAL', 'LANDLORD') THEN
    RAISE EXCEPTION 'BANK_RULE: offers are recorded on the listing (seller or landlord side)' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER offer_before_insert BEFORE INSERT ON "Offer" FOR EACH ROW EXECUTE FUNCTION offer_before_insert();

CREATE FUNCTION offer_event_before_insert() RETURNS trigger AS $$
DECLARE
  current TEXT;
  deal UUID;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT "listingDealId" INTO deal FROM "Offer" WHERE id = NEW."offerId";
  PERFORM 1 FROM "Transaction" WHERE id = deal FOR UPDATE;
  PERFORM require_deal_staff(deal, NEW."actorId", 'updating an offer');
  current := offer_status(NEW."offerId");
  IF current NOT IN ('RECEIVED', 'SIGNED_BACK') THEN
    RAISE EXCEPTION 'ILLEGAL_STATUS_CHANGE: this offer is already %', lower(current) USING ERRCODE = 'ZD001';
  END IF;
  IF NEW.status = 'ACCEPTED' AND EXISTS (SELECT 1 FROM "Offer" o WHERE o."listingDealId" = deal AND o.id <> NEW."offerId"
                                          AND offer_status(o.id) = 'ACCEPTED') THEN
    RAISE EXCEPTION 'BANK_RULE: another offer on this listing is already accepted' USING ERRCODE = 'ZB001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER offer_event_before_insert BEFORE INSERT ON "OfferEvent" FOR EACH ROW EXECUTE FUNCTION offer_event_before_insert();

INSERT INTO "RetentionRule" VALUES
  ('OFFERS_REGISTER', 'Register of written offers received on listings, with the offer documents', 1, 'receipt of the offer (if not accepted)',
   'O. Reg. 579/05 s.19(2): unaccepted offers at least one year from receipt; accepted offers are part of the trade record (6 years)', '2023-12-01');

-- ── Trade record sheet (O. Reg. 579/05 s.17) ────────────────────────────────

CREATE TABLE "TradeRecordSheet" (
  "id"               UUID NOT NULL,
  "transactionId"    UUID NOT NULL,
  "items"            JSONB NOT NULL,
  "missing"          JSONB NOT NULL DEFAULT '[]',
  "preparedById"     UUID NOT NULL,
  "preparedAt"       TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "agentSignedById"  UUID,
  "agentSignedAt"    TIMESTAMPTZ(6),
  "brokerSignedById" UUID,
  "brokerSignedAt"   TIMESTAMPTZ(6),
  "brokerSegregationException" BOOLEAN NOT NULL DEFAULT false,
  "brokerExceptionReason" TEXT,
  CONSTRAINT "TradeRecordSheet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT trs_items CHECK (jsonb_typeof("items") = 'object'),
  CONSTRAINT trs_agent_signature CHECK (("agentSignedAt" IS NULL) = ("agentSignedById" IS NULL)),
  CONSTRAINT trs_broker_signature CHECK (("brokerSignedAt" IS NULL) = ("brokerSignedById" IS NULL) AND ("brokerSignedAt" IS NULL OR "agentSignedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "TradeRecordSheet_transactionId_key" ON "TradeRecordSheet"("transactionId");
ALTER TABLE "TradeRecordSheet" ADD CONSTRAINT "TradeRecordSheet_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradeRecordSheet" ADD CONSTRAINT "TradeRecordSheet_preparedById_fkey"
  FOREIGN KEY ("preparedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradeRecordSheet" ADD CONSTRAINT "TradeRecordSheet_agentSignedById_fkey"
  FOREIGN KEY ("agentSignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradeRecordSheet" ADD CONSTRAINT "TradeRecordSheet_brokerSignedById_fkey"
  FOREIGN KEY ("brokerSignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "TradeRecordCorrection" (
  "id"          UUID NOT NULL,
  "sheetId"     UUID NOT NULL,
  "item"        TEXT NOT NULL,
  "newValue"    JSONB NOT NULL,
  "reason"      TEXT NOT NULL,
  "initialledById" UUID NOT NULL,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "TradeRecordCorrection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT trs_correction_item CHECK ("item" IN ('natureOfTrade', 'property', 'consideration', 'parties', 'lawyers', 'registrants',
    'deposit', 'brokerageRemuneration', 'otherBrokerageRemuneration', 'additionalItems')),
  CONSTRAINT trs_correction_reason CHECK (btrim("reason") <> '')
);
CREATE INDEX "TradeRecordCorrection_sheetId_idx" ON "TradeRecordCorrection"("sheetId");
ALTER TABLE "TradeRecordCorrection" ADD CONSTRAINT "TradeRecordCorrection_sheetId_fkey"
  FOREIGN KEY ("sheetId") REFERENCES "TradeRecordSheet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TradeRecordCorrection" ADD CONSTRAINT "TradeRecordCorrection_initialledById_fkey"
  FOREIGN KEY ("initialledById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION is_deal_agent(deal UUID, who UUID) RETURNS boolean AS $$
  SELECT EXISTS (SELECT 1 FROM "TransactionAgent" a JOIN "User" u ON u.id = a."userId"
                  WHERE a."transactionId" = deal AND a."userId" = who AND u."isActive")
$$ LANGUAGE sql STABLE;

CREATE FUNCTION trade_record_guard() RETURNS trigger AS $$
DECLARE
  deal_status "DealStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'APPEND_ONLY: a trade record sheet is kept, never deleted' USING ERRCODE = 'ZD003';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."preparedAt" := clock_timestamp();
    PERFORM require_deal_staff(NEW."transactionId", NEW."preparedById", 'preparing the trade record sheet');
    IF NEW."agentSignedById" IS NOT NULL OR NEW."brokerSignedById" IS NOT NULL THEN
      RAISE EXCEPTION 'BANK_RULE: a trade record sheet is signed after it is prepared' USING ERRCODE = 'ZB001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW."transactionId", NEW.items, NEW."preparedById", NEW."preparedAt")
     IS DISTINCT FROM (OLD.id, OLD."transactionId", OLD.items, OLD."preparedById", OLD."preparedAt") THEN
    RAISE EXCEPTION 'APPEND_ONLY: entries on a trade record sheet are corrected, never overwritten' USING ERRCODE = 'ZD003';
  END IF;
  IF OLD."brokerSignedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'APPEND_ONLY: the broker of record has signed this trade record sheet' USING ERRCODE = 'ZD003';
  END IF;
  SELECT status INTO deal_status FROM "Transaction" WHERE id = NEW."transactionId";
  IF NEW."agentSignedById" IS NOT NULL AND OLD."agentSignedById" IS NULL THEN
    -- s.17(3): the representing registrant signs once no conditions remain
    IF NOT is_deal_agent(NEW."transactionId", NEW."agentSignedById") THEN
      RAISE EXCEPTION 'DEAL_UNAUTHORIZED: the agent representing the client signs the trade record sheet' USING ERRCODE = 'ZD002';
    END IF;
    IF deal_status NOT IN ('FIRM', 'CLOSED') OR deal_open_conditions(NEW."transactionId") > 0 THEN
      RAISE EXCEPTION 'BANK_RULE: the trade record sheet is signed once no conditions remain outstanding' USING ERRCODE = 'ZB001';
    END IF;
    IF jsonb_array_length(NEW.missing) > 0 THEN
      RAISE EXCEPTION 'BANK_RULE: complete every item before signing: %', NEW.missing USING ERRCODE = 'ZB001';
    END IF;
    NEW."agentSignedAt" := clock_timestamp();
  ELSIF NEW."agentSignedById" IS DISTINCT FROM OLD."agentSignedById" THEN
    RAISE EXCEPTION 'APPEND_ONLY: the agent''s signature can''t be changed' USING ERRCODE = 'ZD003';
  END IF;
  IF NEW."brokerSignedById" IS NOT NULL THEN
    -- s.17(5): the broker of record reviews and signs
    PERFORM require_broker_of_record(NEW."brokerSignedById", 'Signing the trade record sheet');
    IF OLD."agentSignedAt" IS NULL THEN
      RAISE EXCEPTION 'BANK_RULE: the agent signs the trade record sheet first' USING ERRCODE = 'ZB001';
    END IF;
    NEW."brokerSegregationException" := require_separate_people(NEW."brokerSignedById", OLD."agentSignedById", NEW."brokerExceptionReason",
      'Signing the trade record sheet as broker of record (the agent who signed it can''t also review it)');
    NEW."brokerSignedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trade_record_guard BEFORE INSERT OR UPDATE OR DELETE ON "TradeRecordSheet" FOR EACH ROW EXECUTE FUNCTION trade_record_guard();

-- s.17(3)-(5): the agent corrects and initials before signing; the broker of record during review; nothing after
CREATE FUNCTION trade_record_correction_before_insert() RETURNS trigger AS $$
DECLARE
  sheet "TradeRecordSheet"%ROWTYPE;
BEGIN
  NEW."createdAt" := clock_timestamp();
  SELECT * INTO sheet FROM "TradeRecordSheet" WHERE id = NEW."sheetId" FOR UPDATE;
  IF sheet."brokerSignedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'APPEND_ONLY: the broker of record has signed this trade record sheet' USING ERRCODE = 'ZD003';
  END IF;
  IF sheet."agentSignedAt" IS NULL THEN
    PERFORM require_deal_staff(sheet."transactionId", NEW."initialledById", 'correcting the trade record sheet');
  ELSIF NOT is_broker_of_record(NEW."initialledById", CURRENT_DATE) THEN
    RAISE EXCEPTION 'DEAL_UNAUTHORIZED: once the agent has signed, only the broker of record corrects the sheet, during review' USING ERRCODE = 'ZD002';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER trade_record_correction_before_insert BEFORE INSERT ON "TradeRecordCorrection"
  FOR EACH ROW EXECUTE FUNCTION trade_record_correction_before_insert();

-- ── Append-only ──────────────────────────────────────────────────────────────

CREATE TRIGGER deal_condition_immutable BEFORE UPDATE OR DELETE ON "DealCondition" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER condition_event_immutable BEFORE UPDATE OR DELETE ON "DealConditionEvent" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER deal_amendment_immutable BEFORE UPDATE OR DELETE ON "DealAmendment" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER deal_termination_immutable BEFORE UPDATE OR DELETE ON "DealTermination" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER offer_immutable BEFORE UPDATE OR DELETE ON "Offer" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER offer_event_immutable BEFORE UPDATE OR DELETE ON "OfferEvent" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER trade_record_correction_immutable BEFORE UPDATE OR DELETE ON "TradeRecordCorrection"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

GRANT SELECT, INSERT ON "DealCondition", "DealConditionEvent", "DealAmendment", "DealTermination", "Offer", "OfferEvent",
  "TradeRecordSheet", "TradeRecordCorrection" TO zareh_app;
GRANT UPDATE ("missing", "agentSignedById", "agentSignedAt", "brokerSignedById", "brokerSignedAt", "brokerSegregationException", "brokerExceptionReason")
  ON "TradeRecordSheet" TO zareh_app;

COMMIT;
