/**
 * Security configuration, read once at startup. Production fails closed: the
 * server refuses to start if anything needed to run safely is missing or if a
 * development shortcut is switched on.
 */

import type { UserRole } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { FieldCipher } from "./crypto.ts";

export interface SecurityConfig {
  mode: "session" | "dev-header";
  production: boolean;
  cookieSecure: boolean;
  allowedOrigins: string[];
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  mfaRequiredRoles: readonly UserRole[];
  issuer: string;
  fieldCipher: FieldCipher;
  /** Requests per minute from one address before 429. Sign-in limits are fixed and separate. */
  apiRequestsPerMinute: number;
}

export const PRIVILEGED_ROLES: readonly UserRole[] = ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"];

export class InsecureConfigurationError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Refusing to start: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

const ROLES: readonly UserRole[] = ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN", "AGENT"];

export function loadSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const production = env.NODE_ENV === "production";
  const problems: string[] = [];
  const devHeader = env.ALLOW_DEV_AUTH_HEADER === "true";
  if (devHeader && production) problems.push("ALLOW_DEV_AUTH_HEADER must never be set in production");

  let fieldCipher: FieldCipher | null = null;
  if (env.FIELD_ENCRYPTION_KEY) {
    try {
      fieldCipher = FieldCipher.fromBase64(env.FIELD_ENCRYPTION_KEY);
    } catch (err) {
      problems.push((err as Error).message);
    }
  } else if (production) {
    problems.push("FIELD_ENCRYPTION_KEY is required (32 random bytes, base64) to encrypt ID numbers and MFA secrets");
  }

  const origins = (env.APP_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (production && origins.length === 0) problems.push("APP_ORIGINS is required (the web app's https origin, for CSRF checks)");
  if (production && origins.some((o) => !o.startsWith("https://"))) problems.push("APP_ORIGINS must be https in production");
  const cookieSecure = env.COOKIE_SECURE !== "false";
  if (production && !cookieSecure) problems.push("COOKIE_SECURE can't be false in production");

  const mfaRoles = (env.MFA_REQUIRED_ROLES ?? PRIVILEGED_ROLES.join(","))
    .split(",").map((r) => r.trim()).filter(Boolean) as UserRole[];
  if (mfaRoles.some((r) => !ROLES.includes(r))) problems.push("MFA_REQUIRED_ROLES has an unknown role");
  for (const r of PRIVILEGED_ROLES) {
    if (!mfaRoles.includes(r)) problems.push(`MFA can't be optional for ${r}`);
  }

  // An office behind one shared address, or an automated test run, may need more than the default
  const apiRequestsPerMinute = Number(env.API_REQUESTS_PER_MINUTE ?? 600);
  if (!Number.isInteger(apiRequestsPerMinute) || apiRequestsPerMinute < 60 || apiRequestsPerMinute > 100_000) {
    problems.push("API_REQUESTS_PER_MINUTE must be a whole number from 60 to 100000");
  }

  if (problems.length) throw new InsecureConfigurationError(problems);
  return {
    mode: devHeader ? "dev-header" : "session",
    production,
    cookieSecure,
    allowedOrigins: origins,
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 30),
    sessionAbsoluteHours: Number(env.SESSION_ABSOLUTE_HOURS ?? 12),
    mfaRequiredRoles: mfaRoles,
    issuer: env.MFA_ISSUER ?? "Zareh Homes Back Office",
    // Outside production a missing key gets a throwaway one: encrypted data won't survive a restart
    fieldCipher: fieldCipher ?? new FieldCipher(randomBytes(32)),
    apiRequestsPerMinute,
  };
}
