/**
 * Production configuration check: run before every deploy, in the target environment.
 *   NODE_ENV=production node scripts/check-config.ts
 * Exits 1 listing every problem. Never prints a secret's value.
 */

import { InsecureConfigurationError, loadSecurityConfig } from "../src/security/config.ts";

const problems: string[] = [];
try {
  loadSecurityConfig();
} catch (err) {
  if (err instanceof InsecureConfigurationError) problems.push(err.message);
  else throw err;
}
for (const name of ["DATABASE_URL", "BROKERAGE_LEGAL_NAME", "BROKERAGE_ADDRESS", "BROKERAGE_PHONE", "BROKERAGE_EMAIL", "BROKERAGE_HST_NUMBER", "BROKER_OF_RECORD", "UPLOAD_DIR"]) {
  if (!process.env[name]) problems.push(`${name} is not set`);
}
const fileKey = process.env.FILE_ENCRYPTION_KEY;
if (!fileKey || Buffer.from(fileKey, "base64").length !== 32) problems.push("FILE_ENCRYPTION_KEY must be 32 random bytes, base64");
if (process.env.FIELD_ENCRYPTION_KEY && process.env.FIELD_ENCRYPTION_KEY === fileKey) problems.push("FIELD_ENCRYPTION_KEY and FILE_ENCRYPTION_KEY must differ");
if (process.env.ALLOW_DEV_AUTH_HEADER) problems.push("ALLOW_DEV_AUTH_HEADER must not be set at all in production");
if (process.env.ACCOUNTING_PROVIDER) problems.push("ACCOUNTING_PROVIDER is set, but live accounting connections aren't enabled in this release");
const url = process.env.DATABASE_URL ?? "";
if (/^postgres(ql)?:\/\/(postgres|zareh_owner)[:@]/.test(url)) problems.push("DATABASE_URL must use the restricted application login (member of zareh_app), not the owner or postgres");
if (url && !/sslmode=(require|verify-full|verify-ca)/.test(url)) problems.push("DATABASE_URL should require TLS (sslmode=verify-full)");
if (process.env.NODE_ENV !== "production") problems.push("NODE_ENV is not production");

if (problems.length) {
  console.error(`Configuration is NOT ready for production:\n - ${problems.join("\n - ")}`);
  process.exit(1);
}
console.log("Configuration checks passed.");
