-- 004 – Document compliance (RECO transaction file + FINTRAC records)
--
--   • Statuses: Missing -> Pending Review -> Approved | Needs Revision (-> Pending Review)
--     enforced by trigger, including who may review
--   • FILE_REVIEWER becomes COMPLIANCE_ADMIN
--   • FINTRAC slots are per client party (each individual / each corporation)
--   • Uploaded files and review decisions are append-only
--   • Seeds the mandatory document types
--
-- Applies on top of 003. Run with plain `psql -f` (enum value renames/additions
-- happen before the main transaction).

ALTER TYPE "UserRole"       RENAME VALUE 'FILE_REVIEWER' TO 'COMPLIANCE_ADMIN';
ALTER TYPE "DocumentStatus" RENAME VALUE 'PENDING' TO 'PENDING_REVIEW';
ALTER TYPE "DocumentStatus" RENAME VALUE 'REJECTED' TO 'NEEDS_REVISION';

BEGIN;

CREATE TYPE "DocumentSlotScope"    AS ENUM ('DEAL', 'CLIENT_INDIVIDUAL', 'CLIENT_CORPORATION');
CREATE TYPE "DocumentMetadataKind" AS ENUM ('NONE', 'FINTRAC_INDIVIDUAL', 'FINTRAC_CORPORATE');
CREATE TYPE "PartyEntityType"      AS ENUM ('INDIVIDUAL', 'CORPORATION');
CREATE TYPE "ReviewDecision"       AS ENUM ('APPROVED', 'NEEDS_REVISION');

-- ── Parties ──────────────────────────────────────────────────────────────────

ALTER TABLE "TransactionParty" ADD COLUMN "entityType" "PartyEntityType" NOT NULL DEFAULT 'INDIVIDUAL';

-- ── Document types ───────────────────────────────────────────────────────────

ALTER TABLE "DocumentType"
  ADD COLUMN "code"         TEXT,
  ADD COLUMN "slotScope"    "DocumentSlotScope"    NOT NULL DEFAULT 'DEAL',
  ADD COLUMN "metadataKind" "DocumentMetadataKind" NOT NULL DEFAULT 'NONE';
UPDATE "DocumentType" SET "code" = upper(regexp_replace(name, '[^A-Za-z0-9]+', '_', 'g'));
ALTER TABLE "DocumentType" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX "DocumentType_code_key" ON "DocumentType"("code");

-- ── Slots ────────────────────────────────────────────────────────────────────

ALTER TABLE "DocumentSlot" RENAME COLUMN "rejectionReason" TO "reviewComment";
ALTER TABLE "DocumentSlot"
  ADD COLUMN "partyId" UUID,
  ALTER COLUMN "reviewedAt" TYPE TIMESTAMPTZ(6) USING "reviewedAt" AT TIME ZONE 'UTC';
ALTER TABLE "DocumentSlot" ADD CONSTRAINT "DocumentSlot_partyId_fkey"
  FOREIGN KEY ("partyId") REFERENCES "TransactionParty"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One slot per (deal, type) or, for per-client FINTRAC slots, per (deal, type, party)
DROP INDEX "DocumentSlot_transactionId_documentTypeId_key";
CREATE INDEX "DocumentSlot_transactionId_idx" ON "DocumentSlot"("transactionId");
CREATE UNIQUE INDEX document_slot_deal_type ON "DocumentSlot"("transactionId", "documentTypeId")
  WHERE "partyId" IS NULL AND "transactionId" IS NOT NULL;
CREATE UNIQUE INDEX document_slot_deal_type_party ON "DocumentSlot"("transactionId", "documentTypeId", "partyId")
  WHERE "partyId" IS NOT NULL;

ALTER TABLE "DocumentSlot" ADD CONSTRAINT slot_party_needs_deal
  CHECK ("partyId" IS NULL OR "transactionId" IS NOT NULL);
ALTER TABLE "DocumentSlot" ADD CONSTRAINT slot_review_fields CHECK (
  ("status" NOT IN ('APPROVED', 'NEEDS_REVISION', 'WAIVED') OR ("reviewerId" IS NOT NULL AND "reviewedAt" IS NOT NULL))
  AND ("status" <> 'NEEDS_REVISION' OR length(btrim(coalesce("reviewComment", ''))) >= 10));

-- ── Files: metadata + append-only ────────────────────────────────────────────

ALTER TABLE "DocumentFile"
  ADD COLUMN "metadataKind" "DocumentMetadataKind" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "metadata"     JSONB,
  ALTER COLUMN "uploadedAt" TYPE TIMESTAMPTZ(6) USING "uploadedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "uploadedAt" SET DEFAULT clock_timestamp();
ALTER TABLE "DocumentFile" ADD CONSTRAINT file_metadata_present CHECK (
  "metadataKind" = 'NONE' OR jsonb_typeof("metadata") = 'object');
ALTER TABLE "DocumentFile" ADD CONSTRAINT file_size_positive CHECK ("sizeBytes" > 0 AND "version" >= 1);

-- ── Review history ───────────────────────────────────────────────────────────

CREATE TABLE "DocumentReview" (
  "id"         UUID NOT NULL,
  "slotId"     UUID NOT NULL,
  "fileId"     UUID NOT NULL,
  "decision"   "ReviewDecision" NOT NULL,
  "comment"    TEXT,
  "reviewerId" UUID NOT NULL,
  "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "DocumentReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT review_revision_comment CHECK (
    "decision" <> 'NEEDS_REVISION' OR length(btrim(coalesce("comment", ''))) >= 10)
);
CREATE INDEX "DocumentReview_slotId_createdAt_idx" ON "DocumentReview"("slotId", "createdAt");
ALTER TABLE "DocumentReview" ADD CONSTRAINT "DocumentReview_slotId_fkey"
  FOREIGN KEY ("slotId") REFERENCES "DocumentSlot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentReview" ADD CONSTRAINT "DocumentReview_fileId_fkey"
  FOREIGN KEY ("fileId") REFERENCES "DocumentFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DocumentReview" ADD CONSTRAINT "DocumentReview_reviewerId_fkey"
  FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Notifications ────────────────────────────────────────────────────────────

CREATE TABLE "Notification" (
  "id"            UUID NOT NULL,
  "userId"        UUID NOT NULL,
  "type"          TEXT NOT NULL,
  "title"         TEXT NOT NULL,
  "body"          TEXT NOT NULL,
  "transactionId" UUID,
  "slotId"        UUID,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "readAt"        TIMESTAMPTZ(6),
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Triggers ─────────────────────────────────────────────────────────────────
-- SQLSTATE ZD001 = illegal status transition, ZD002 = not allowed to review,
--          ZD003 = append-only table changed

CREATE FUNCTION document_slot_guard() RETURNS trigger AS $$
DECLARE
  reviewer_role   "UserRole";
  reviewer_active boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'MISSING' THEN
      RAISE EXCEPTION 'DOCUMENT_STATUS: new slots start as MISSING' USING ERRCODE = 'ZD001';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."documentTypeId", NEW."transactionId", NEW."listingId", NEW."partyId")
     IS DISTINCT FROM (OLD."documentTypeId", OLD."transactionId", OLD."listingId", OLD."partyId") THEN
    RAISE EXCEPTION 'DOCUMENT_STATUS: a slot cannot be moved to another deal, type or party' USING ERRCODE = 'ZD001';
  END IF;

  IF NOT (
       (OLD.status = 'MISSING'        AND NEW.status IN ('MISSING', 'PENDING_REVIEW', 'WAIVED'))
    OR (OLD.status = 'PENDING_REVIEW' AND NEW.status IN ('PENDING_REVIEW', 'APPROVED', 'NEEDS_REVISION'))
    OR (OLD.status = 'NEEDS_REVISION' AND NEW.status IN ('NEEDS_REVISION', 'PENDING_REVIEW'))
    OR (OLD.status = 'APPROVED'       AND NEW.status = 'APPROVED')
    OR (OLD.status = 'WAIVED'         AND NEW.status = 'WAIVED')
  ) THEN
    RAISE EXCEPTION 'DOCUMENT_STATUS: % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = 'ZD001';
  END IF;

  IF NEW.status = 'PENDING_REVIEW' AND OLD.status <> 'PENDING_REVIEW' THEN
    IF NOT EXISTS (SELECT 1 FROM "DocumentFile" WHERE "slotId" = NEW.id) THEN
      RAISE EXCEPTION 'DOCUMENT_STATUS: nothing has been uploaded to slot %', NEW.id USING ERRCODE = 'ZD001';
    END IF;
    -- Fresh submission: the previous decision lives on in DocumentReview
    NEW."reviewerId" := NULL;
    NEW."reviewedAt" := NULL;
    NEW."reviewComment" := NULL;
  END IF;

  IF NEW.status IN ('APPROVED', 'NEEDS_REVISION', 'WAIVED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT role, "isActive" INTO reviewer_role, reviewer_active FROM "User" WHERE id = NEW."reviewerId";
    IF reviewer_role IS NULL OR reviewer_role NOT IN ('MANAGING_BROKER', 'COMPLIANCE_ADMIN') OR reviewer_active IS NOT TRUE THEN
      RAISE EXCEPTION 'DOCUMENT_REVIEW: user % may not review documents', NEW."reviewerId" USING ERRCODE = 'ZD002';
    END IF;
    NEW."reviewedAt" := clock_timestamp();
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER document_slot_guard
  BEFORE INSERT OR UPDATE ON "DocumentSlot"
  FOR EACH ROW EXECUTE FUNCTION document_slot_guard();

CREATE FUNCTION reject_append_only_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY: % on % is not allowed', TG_OP, TG_TABLE_NAME USING ERRCODE = 'ZD003';
END $$ LANGUAGE plpgsql;

CREATE FUNCTION stamp_db_time() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'DocumentFile' THEN
    NEW."uploadedAt" := clock_timestamp();
  ELSE
    NEW."createdAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER document_file_stamp     BEFORE INSERT ON "DocumentFile"   FOR EACH ROW EXECUTE FUNCTION stamp_db_time();
CREATE TRIGGER document_review_stamp   BEFORE INSERT ON "DocumentReview" FOR EACH ROW EXECUTE FUNCTION stamp_db_time();
CREATE TRIGGER document_file_immutable BEFORE UPDATE OR DELETE ON "DocumentFile"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER document_file_no_truncate BEFORE TRUNCATE ON "DocumentFile"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER document_review_immutable BEFORE UPDATE OR DELETE ON "DocumentReview"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER document_review_no_truncate BEFORE TRUNCATE ON "DocumentReview"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

-- Role renamed: the trust hold trigger from 003 compares against the old name
CREATE OR REPLACE FUNCTION trust_hold_guard() RETURNS trigger AS $$
DECLARE
  actor_role   "UserRole";
  actor_active boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'TRUST_HOLD_RULE: holds cannot be deleted; release them instead' USING ERRCODE = 'ZT006';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."flaggedAt" := clock_timestamp();
    IF NEW."releasedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'TRUST_HOLD_RULE: a hold cannot be created already released' USING ERRCODE = 'ZT006';
    END IF;
    SELECT role, "isActive" INTO actor_role, actor_active FROM "User" WHERE id = NEW."flaggedById";
    IF actor_role NOT IN ('ADMIN', 'MANAGING_BROKER', 'COMPLIANCE_ADMIN') OR actor_active IS NOT TRUE THEN
      RAISE EXCEPTION 'TRUST_UNAUTHORIZED: user % cannot flag trust holds', NEW."flaggedById" USING ERRCODE = 'ZT003';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."releasedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'TRUST_HOLD_RULE: hold % is already released', OLD.id USING ERRCODE = 'ZT006';
  END IF;
  IF (NEW.id, NEW."transactionId", NEW."depositEntryId", NEW.reason, NEW.note, NEW."flaggedById", NEW."flaggedAt")
     IS DISTINCT FROM
     (OLD.id, OLD."transactionId", OLD."depositEntryId", OLD.reason, OLD.note, OLD."flaggedById", OLD."flaggedAt") THEN
    RAISE EXCEPTION 'TRUST_HOLD_RULE: only the release fields of a hold can be set' USING ERRCODE = 'ZT006';
  END IF;
  SELECT role, "isActive" INTO actor_role, actor_active FROM "User" WHERE id = NEW."releasedById";
  IF actor_role IS DISTINCT FROM 'MANAGING_BROKER' OR actor_active IS NOT TRUE THEN
    RAISE EXCEPTION 'TRUST_UNAUTHORIZED: only an active managing broker can release a hold' USING ERRCODE = 'ZT003';
  END IF;
  NEW."releasedAt" := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ── Mandatory document types ─────────────────────────────────────────────────
-- Which deal sides get each slot is data, so the office can change it without a deploy.

INSERT INTO "DocumentType" (id, code, name, "formNumber", "requiredFor", "slotScope", "metadataKind", "sortOrder") VALUES
  (gen_random_uuid(), 'FORM_200', 'Listing Agreement (Form 200)', '200',
     ARRAY['LISTING', 'DUAL']::"DealSide"[], 'DEAL', 'NONE', 10),
  (gen_random_uuid(), 'APS', 'Agreement of Purchase and Sale (APS)', '100',
     ARRAY['BUYER', 'DUAL']::"DealSide"[], 'DEAL', 'NONE', 20),
  (gen_random_uuid(), 'FORM_320', 'Confirmation of Co-operation and Representation (Form 320)', '320',
     ARRAY['BUYER', 'DUAL']::"DealSide"[], 'DEAL', 'NONE', 30),
  (gen_random_uuid(), 'FINTRAC_INDIVIDUAL', 'FINTRAC Individual Identification Record', NULL,
     ARRAY['BUYER', 'LISTING', 'DUAL']::"DealSide"[], 'CLIENT_INDIVIDUAL', 'FINTRAC_INDIVIDUAL', 40),
  (gen_random_uuid(), 'FINTRAC_CORPORATE', 'FINTRAC Corporate / Beneficial Ownership Record', NULL,
     ARRAY['BUYER', 'LISTING', 'DUAL']::"DealSide"[], 'CLIENT_CORPORATION', 'FINTRAC_CORPORATE', 50)
ON CONFLICT (code) DO NOTHING;

COMMIT;
