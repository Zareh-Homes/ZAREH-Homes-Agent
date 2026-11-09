-- 023 – Agent profiles, standard commission plans, and RECO registration renewal reminders
--
-- "AgentProfile" (one per person who trades): start date, RECO registration expiry, home address and date of birth
-- (required; address and date of birth stored encrypted by the app), and optional emergency contact, E&O insurance,
-- payout banking (encrypted) and how the brokerage bills them.
--
-- "CommissionPlanTemplate": the brokerage's standard plans (e.g. 70/30, 80/20 capped at $20,000), picked from a
-- list when an agent's plan is proposed. The plan version still needs a second broker's approval, and records which
-- standard plan it started from.
--
-- "EmailOutbox": every email the system sends, kept with its status (queued until an email service is configured).
-- "RegistrationReminder": one row per reminder sent (30 days, 14 days, expired) for a given expiry date, so a reminder
-- is never sent twice, whichever server instance runs the daily check.
--
-- Applies on top of 022.

BEGIN;

CREATE TABLE "AgentProfile" (
  "userId"                UUID NOT NULL,
  "startDate"             DATE NOT NULL,
  "recoExpiryDate"        DATE NOT NULL,
  "addressEnc"            TEXT NOT NULL,
  "dateOfBirthEnc"        TEXT NOT NULL,
  "emergencyContactName"  TEXT,
  "emergencyContactPhone" TEXT,
  "eoInsurer"             TEXT,
  "eoPolicyNumber"        TEXT,
  "eoExpiryDate"          DATE,
  "payoutBankingEnc"      TEXT,
  "billingMethod"         TEXT,
  "billingNote"           TEXT,
  "notes"                 TEXT,
  "updatedById"           UUID NOT NULL,
  "updatedAt"             TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "AgentProfile_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "AgentProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "AgentProfile_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Encrypted by the app (AES-256-GCM, FIELD_ENCRYPTION_KEY); never plain text here
  CONSTRAINT agent_profile_sealed CHECK ("addressEnc" LIKE 'v1.%' AND "dateOfBirthEnc" LIKE 'v1.%'
    AND ("payoutBankingEnc" IS NULL OR "payoutBankingEnc" LIKE 'v1.%')),
  CONSTRAINT agent_profile_billing CHECK ("billingMethod" IS NULL OR "billingMethod" IN
    ('PRE_AUTHORIZED_DEBIT', 'BANK_TRANSFER', 'CHEQUE', 'DEDUCT_FROM_COMMISSION', 'OTHER')),
  CONSTRAINT agent_profile_dates CHECK ("recoExpiryDate" > '2000-01-01' AND "startDate" > '1950-01-01')
);
CREATE INDEX "AgentProfile_recoExpiryDate_idx" ON "AgentProfile"("recoExpiryDate");

CREATE TABLE "CommissionPlanTemplate" (
  "id"                UUID NOT NULL,
  "name"              TEXT NOT NULL,
  "splitBps"          INTEGER NOT NULL,
  "annualCap"         DECIMAL(12, 2),
  "capYearStartMonth" INTEGER NOT NULL DEFAULT 1,
  "capYearStartDay"   INTEGER NOT NULL DEFAULT 1,
  "fees"              JSONB NOT NULL DEFAULT '[]',
  "isActive"          BOOLEAN NOT NULL DEFAULT true,
  "createdById"       UUID NOT NULL,
  "createdAt"         TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "CommissionPlanTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CommissionPlanTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT plan_template_name CHECK (btrim("name") <> ''),
  CONSTRAINT plan_template_split CHECK ("splitBps" BETWEEN 0 AND 10000),
  CONSTRAINT plan_template_cap CHECK ("annualCap" IS NULL OR "annualCap" >= 0),
  CONSTRAINT plan_template_cap_start CHECK ("capYearStartMonth" BETWEEN 1 AND 12 AND "capYearStartDay" BETWEEN 1 AND 31)
);
CREATE UNIQUE INDEX "CommissionPlanTemplate_name_key" ON "CommissionPlanTemplate"(lower("name"));

ALTER TABLE "CommissionPlanVersion" ADD COLUMN "templateId" UUID;
ALTER TABLE "CommissionPlanVersion" ADD CONSTRAINT "CommissionPlanVersion_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "CommissionPlanTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "EmailOutbox" (
  "id"            UUID NOT NULL,
  "kind"          TEXT NOT NULL,
  "toAddresses"   TEXT[] NOT NULL,
  "ccAddresses"   TEXT[] NOT NULL DEFAULT '{}',
  "subject"       TEXT NOT NULL,
  "bodyText"      TEXT NOT NULL,
  "relatedUserId" UUID,
  "status"        TEXT NOT NULL DEFAULT 'QUEUED',
  "attempts"      INTEGER NOT NULL DEFAULT 0,
  "lastError"     TEXT,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "sentAt"        TIMESTAMPTZ(6),
  CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailOutbox_relatedUserId_fkey" FOREIGN KEY ("relatedUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT email_status CHECK ("status" IN ('QUEUED', 'SENT', 'FAILED')),
  CONSTRAINT email_recipients CHECK (cardinality("toAddresses") > 0),
  CONSTRAINT email_sent CHECK (("status" = 'SENT') = ("sentAt" IS NOT NULL))
);
CREATE INDEX "EmailOutbox_status_createdAt_idx" ON "EmailOutbox"("status", "createdAt");

CREATE TABLE "RegistrationReminder" (
  "userId"     UUID NOT NULL,
  "expiryDate" DATE NOT NULL,
  "kind"       TEXT NOT NULL,
  "emailId"    UUID NOT NULL,
  "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "RegistrationReminder_pkey" PRIMARY KEY ("userId", "expiryDate", "kind"),
  CONSTRAINT "RegistrationReminder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RegistrationReminder_emailId_fkey" FOREIGN KEY ("emailId") REFERENCES "EmailOutbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT registration_reminder_kind CHECK ("kind" IN ('DAYS_30', 'DAYS_14', 'EXPIRED'))
);

-- The restricted app login: profiles and templates are edited in place; the outbox only changes status
GRANT SELECT, INSERT, UPDATE ON "AgentProfile", "CommissionPlanTemplate", "EmailOutbox" TO zareh_app;
GRANT SELECT, INSERT ON "RegistrationReminder" TO zareh_app;

COMMIT;
