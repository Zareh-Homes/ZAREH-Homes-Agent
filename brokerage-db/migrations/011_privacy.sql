-- 011 – Privacy: retention schedule, legal holds, breach register
--
--   • RetentionRule: how long each kind of record is kept, with its legal basis.
--     Seeded from docs/regulatory-references.md. Disposal is never automatic:
--     the application only reports what has passed its retention date and is
--     not on legal hold; destruction is a separate, approved, manual process.
--   • LegalHold: a deal (or the whole brokerage) whose records must not be
--     disposed of, for litigation, a RECO inquiry or a FINTRAC examination.
--   • PrivacyBreach + PrivacyBreachEvent: PIPEDA breach of security safeguards
--     record (kept at least 24 months, SOR/2018-64 s.6), real-risk-of-
--     significant-harm assessment, OPC report and notification evidence.
--     Nothing is sent automatically.
--
-- Applies on top of 010.

BEGIN;

CREATE TABLE "RetentionRule" (
  "recordType"     TEXT NOT NULL,
  "description"    TEXT NOT NULL,
  "retentionYears" INTEGER NOT NULL,
  "startsFrom"     TEXT NOT NULL,
  "legalBasis"     TEXT NOT NULL,
  "effectiveFrom"  DATE NOT NULL,
  CONSTRAINT "RetentionRule_pkey" PRIMARY KEY ("recordType"),
  CONSTRAINT retention_years CHECK ("retentionYears" > 0)
);

INSERT INTO "RetentionRule" VALUES
  ('TRADE_RECORDS', 'Trade record sheets, agreements, CDAs, deal documents', 6, 'completion or termination of the trade',
   'O. Reg. 579/05 s.19(1): at least six years unless the registrar specifies otherwise', '2023-12-01'),
  ('TRUST_RECORDS', 'Trust ledger, bank statements, reconciliations, shortfall incidents', 6, 'the record date',
   'O. Reg. 579/05 s.19(1)', '2023-12-01'),
  ('UNSUCCESSFUL_OFFERS', 'Written offers that were not accepted (seller''s brokerage)', 1, 'receipt of the offer',
   'O. Reg. 579/05 s.19(2): at least one year from receipt', '2023-12-01'),
  ('FINTRAC_RECORDS', 'Identification, receipt of funds, beneficial ownership, third party and other FINTRAC records', 5, 'the record date',
   'PCMLTF Regulations: at least five years', '2023-12-01'),
  ('PRIVACY_BREACH_RECORDS', 'Breach of security safeguards records', 2, 'the date the brokerage determined the breach occurred',
   'PIPEDA s.10.3; Breach of Security Safeguards Regulations SOR/2018-64 s.6(1): 24 months', '2018-11-01'),
  ('AUDIT_LOG', 'Security and activity audit trail', 7, 'the event date',
   'Brokerage policy: longest of the records it evidences, plus a year', '2026-10-18');

CREATE TABLE "LegalHold" (
  "id"            UUID NOT NULL,
  "transactionId" UUID,
  "reason"        TEXT NOT NULL,
  "placedById"    UUID NOT NULL,
  "placedAt"      TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "releasedById"  UUID,
  "releasedAt"    TIMESTAMPTZ(6),
  "releaseNote"   TEXT,
  CONSTRAINT "LegalHold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT legal_hold_reason CHECK (btrim("reason") <> ''),
  CONSTRAINT legal_hold_release CHECK (("releasedAt" IS NULL) = ("releasedById" IS NULL))
);
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_placedById_fkey"
  FOREIGN KEY ("placedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LegalHold" ADD CONSTRAINT "LegalHold_releasedById_fkey"
  FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "BreachEventKind" AS ENUM ('NOTE', 'CONTAINED', 'RISK_ASSESSED', 'OPC_REPORTED', 'INDIVIDUALS_NOTIFIED', 'ORGANIZATIONS_NOTIFIED', 'CLOSED');

CREATE TABLE "PrivacyBreach" (
  "id"                  UUID NOT NULL,
  "discoveredAt"        TIMESTAMPTZ(6) NOT NULL,
  "occurredFrom"        DATE,
  "occurredTo"          DATE,
  "description"         TEXT NOT NULL,
  "informationInvolved" TEXT NOT NULL,
  "individualsAffected" INTEGER,
  "recordedById"        UUID NOT NULL,
  "recordedAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "PrivacyBreach_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "PrivacyBreach" ADD CONSTRAINT "PrivacyBreach_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "PrivacyBreachEvent" (
  "id"        UUID NOT NULL,
  "breachId"  UUID NOT NULL,
  "kind"      "BreachEventKind" NOT NULL,
  "eventDate" DATE NOT NULL,
  "realRiskOfSignificantHarm" BOOLEAN,
  "reference" TEXT,
  "note"      TEXT NOT NULL,
  "actorId"   UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "PrivacyBreachEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT breach_assessment CHECK ("kind" <> 'RISK_ASSESSED' OR "realRiskOfSignificantHarm" IS NOT NULL),
  CONSTRAINT breach_evidence CHECK ("kind" NOT IN ('OPC_REPORTED', 'INDIVIDUALS_NOTIFIED') OR NULLIF(btrim("reference"), '') IS NOT NULL)
);
CREATE INDEX "PrivacyBreachEvent_breachId_idx" ON "PrivacyBreachEvent"("breachId");
ALTER TABLE "PrivacyBreachEvent" ADD CONSTRAINT "PrivacyBreachEvent_breachId_fkey"
  FOREIGN KEY ("breachId") REFERENCES "PrivacyBreach"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PrivacyBreachEvent" ADD CONSTRAINT "PrivacyBreachEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION require_privacy_staff(actor UUID, action TEXT) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "User" WHERE id = actor AND "isActive" AND role IN ('ADMIN', 'MANAGING_BROKER', 'COMPLIANCE_ADMIN')) THEN
    RAISE EXCEPTION 'PRIVACY_UNAUTHORIZED: % requires an active admin, managing broker or compliance admin', action USING ERRCODE = 'ZD002';
  END IF;
END $$ LANGUAGE plpgsql;

-- A breach found to pose a real risk of significant harm can only be closed once reported and notified
CREATE FUNCTION privacy_breach_event_guard() RETURNS trigger AS $$
DECLARE
  rrosh boolean;
BEGIN
  NEW."createdAt" := clock_timestamp();
  PERFORM require_privacy_staff(NEW."actorId", 'recording a privacy breach event');
  IF EXISTS (SELECT 1 FROM "PrivacyBreachEvent" WHERE "breachId" = NEW."breachId" AND kind = 'CLOSED') THEN
    RAISE EXCEPTION 'BANK_RULE: this breach record is closed' USING ERRCODE = 'ZB001';
  END IF;
  IF NEW.kind = 'CLOSED' THEN
    SELECT "realRiskOfSignificantHarm" INTO rrosh FROM "PrivacyBreachEvent"
     WHERE "breachId" = NEW."breachId" AND kind = 'RISK_ASSESSED' ORDER BY "createdAt" DESC LIMIT 1;
    IF rrosh IS NULL THEN
      RAISE EXCEPTION 'BANK_RULE: assess whether the breach creates a real risk of significant harm before closing it' USING ERRCODE = 'ZB001';
    END IF;
    IF rrosh AND NOT (
         EXISTS (SELECT 1 FROM "PrivacyBreachEvent" WHERE "breachId" = NEW."breachId" AND kind = 'OPC_REPORTED')
         AND EXISTS (SELECT 1 FROM "PrivacyBreachEvent" WHERE "breachId" = NEW."breachId" AND kind = 'INDIVIDUALS_NOTIFIED')) THEN
      RAISE EXCEPTION 'BANK_RULE: a breach with a real risk of significant harm must be reported to the OPC and individuals notified before it is closed'
        USING ERRCODE = 'ZB001';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER privacy_breach_event_guard BEFORE INSERT ON "PrivacyBreachEvent" FOR EACH ROW EXECUTE FUNCTION privacy_breach_event_guard();

CREATE FUNCTION privacy_breach_stamp() RETURNS trigger AS $$
BEGIN
  NEW."recordedAt" := clock_timestamp();
  PERFORM require_privacy_staff(NEW."recordedById", 'recording a privacy breach');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER privacy_breach_stamp BEFORE INSERT ON "PrivacyBreach" FOR EACH ROW EXECUTE FUNCTION privacy_breach_stamp();

CREATE TRIGGER privacy_breach_immutable BEFORE UPDATE OR DELETE ON "PrivacyBreach" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER privacy_breach_event_immutable BEFORE UPDATE OR DELETE ON "PrivacyBreachEvent" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER retention_rule_immutable BEFORE DELETE ON "RetentionRule" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();

GRANT SELECT ON "RetentionRule" TO zareh_app;
GRANT SELECT, INSERT ON "PrivacyBreach", "PrivacyBreachEvent" TO zareh_app;
GRANT SELECT, INSERT ON "LegalHold" TO zareh_app;
GRANT UPDATE ("releasedById", "releasedAt", "releaseNote") ON "LegalHold" TO zareh_app;

COMMIT;
