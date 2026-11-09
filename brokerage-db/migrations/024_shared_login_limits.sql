-- 024 – Sign-in rate limits shared by every app server
--
-- Sign-in attempts per address and per account were counted in each server's memory, so running two servers
-- doubled the allowance. Each one-minute window is now a row here: every server counts against the same number.
-- Keys are SHA-256 hashes (no email addresses or IP addresses stored). Old windows are deleted as new ones arrive.
--
-- Applies on top of 023.

BEGIN;

CREATE TABLE "RateLimitHit" (
  "keyHash"     TEXT NOT NULL,
  "windowStart" TIMESTAMPTZ(6) NOT NULL,
  "count"       INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "RateLimitHit_pkey" PRIMARY KEY ("keyHash", "windowStart")
);
CREATE INDEX "RateLimitHit_windowStart_idx" ON "RateLimitHit"("windowStart");

GRANT SELECT, INSERT, UPDATE, DELETE ON "RateLimitHit" TO zareh_app;

COMMIT;
