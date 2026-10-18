-- 010 – Authentication, sessions and the security audit trail
--
--   • UserCredential: scrypt password hash, lockout counters, TOTP MFA secret
--     (encrypted by the application before it reaches the database) and
--     hashed one-time recovery codes.
--   • Session: server-side sessions. Only a SHA-256 of the session token is
--     stored. Absolute and idle expiry, MFA step-up time, revocation.
--   • AuthToken: single-use invitation and password-reset tokens (hashed).
--   • Deactivating a user revokes every session immediately.
--   • AuditLog (from the v1 schema, unused until now) becomes the append-only
--     security and activity trail: who did what, from where, with what result.
--
-- Applies on top of 009.

BEGIN;

CREATE TABLE "UserCredential" (
  "userId"            UUID NOT NULL,
  "passwordHash"      TEXT NOT NULL,
  "passwordChangedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "failedAttempts"    INTEGER NOT NULL DEFAULT 0,
  "lockedUntil"       TIMESTAMPTZ(6),
  "mfaSecretEnc"      TEXT,
  "mfaEnabledAt"      TIMESTAMPTZ(6),
  "mfaLastStep"       BIGINT,
  "recoveryCodeHashes" TEXT[] NOT NULL DEFAULT '{}',
  CONSTRAINT "UserCredential_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT credential_hash_format CHECK ("passwordHash" LIKE 'scrypt$%'),
  CONSTRAINT credential_mfa_together CHECK ("mfaEnabledAt" IS NULL OR "mfaSecretEnc" IS NOT NULL)
);
ALTER TABLE "UserCredential" ADD CONSTRAINT "UserCredential_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "Session" (
  "id"            UUID NOT NULL,
  "tokenHash"     TEXT NOT NULL,
  "csrfToken"     TEXT NOT NULL,
  "userId"        UUID NOT NULL,
  "createdAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "lastSeenAt"    TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "expiresAt"     TIMESTAMPTZ(6) NOT NULL,
  "mfaVerifiedAt" TIMESTAMPTZ(6),
  "revokedAt"     TIMESTAMPTZ(6),
  "revokedReason" TEXT,
  "ip"            TEXT,
  "userAgent"     TEXT,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TYPE "AuthTokenPurpose" AS ENUM ('INVITATION', 'PASSWORD_RESET');

CREATE TABLE "AuthToken" (
  "id"          UUID NOT NULL,
  "userId"      UUID NOT NULL,
  "purpose"     "AuthTokenPurpose" NOT NULL,
  "tokenHash"   TEXT NOT NULL,
  "expiresAt"   TIMESTAMPTZ(6) NOT NULL,
  "usedAt"      TIMESTAMPTZ(6),
  "createdById" UUID NOT NULL,
  "createdAt"   TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Suspending a user ends every session at once
CREATE FUNCTION revoke_sessions_on_deactivate() RETURNS trigger AS $$
BEGIN
  IF OLD."isActive" AND NOT NEW."isActive" THEN
    UPDATE "Session" SET "revokedAt" = clock_timestamp(), "revokedReason" = 'USER_DEACTIVATED'
     WHERE "userId" = NEW.id AND "revokedAt" IS NULL;
  END IF;
  IF OLD.role IS DISTINCT FROM NEW.role THEN
    UPDATE "Session" SET "revokedAt" = clock_timestamp(), "revokedReason" = 'ROLE_CHANGED'
     WHERE "userId" = NEW.id AND "revokedAt" IS NULL;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER user_revoke_sessions AFTER UPDATE OF "isActive", role ON "User"
  FOR EACH ROW EXECUTE FUNCTION revoke_sessions_on_deactivate();

-- ── Audit trail ──────────────────────────────────────────────────────────────

ALTER TABLE "AuditLog"
  ADD COLUMN "sessionId" UUID,
  ADD COLUMN "ip"        TEXT,
  ADD COLUMN "userAgent" TEXT,
  ADD COLUMN "outcome"   TEXT,
  ADD COLUMN "route"     TEXT,
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ(6),
  ALTER COLUMN "createdAt" SET DEFAULT clock_timestamp();
ALTER TABLE "AuditLog" ADD CONSTRAINT audit_outcome CHECK ("outcome" IS NULL OR "outcome" IN ('SUCCESS', 'DENIED', 'FAILED', 'ERROR'));
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");

CREATE FUNCTION audit_log_stamp() RETURNS trigger AS $$
BEGIN
  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_stamp BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION audit_log_stamp();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION reject_append_only_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_change();

-- ── Application role ─────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON "UserCredential", "Session", "AuthToken" TO zareh_app;
GRANT SELECT, INSERT ON "AuditLog" TO zareh_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM zareh_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO zareh_app;

COMMIT;
