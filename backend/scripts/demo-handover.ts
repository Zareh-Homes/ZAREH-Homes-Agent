/**
 * Hands a filled demo database over to the person trying it: for every demo account, a one-time link to set
 * their own password (72 hours, works once), two-factor cleared so they set it up on their own phone, and every
 * session ended. The passwords and authenticator secrets the scripted journey used stop working: each password is
 * replaced by a random one nobody knows.
 *
 *   node scripts/demo-handover.ts --app-url http://localhost:8080
 *
 * Demo databases only: refuses with NODE_ENV=production, or if any account's email isn't on a reserved
 * ".test" domain, so it can't be used to take over real accounts.
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { hashPassword, newToken, sha256 } from "../src/security/crypto.ts";
import { audit } from "../src/security/audit.ts";

const { values } = parseArgs({ options: { "app-url": { type: "string" } } });
const appUrl = values["app-url"]?.replace(/\/+$/, "");
if (!appUrl) {
  console.error("Usage: demo-handover.ts --app-url <http://localhost:8080>");
  process.exit(2);
}
if (process.env.NODE_ENV === "production") {
  console.error("Refusing: this is for demo databases only (NODE_ENV=production).");
  process.exit(3);
}

const ROLE: Record<string, string> = { MANAGING_BROKER: "Broker of record", ADMIN: "Admin", COMPLIANCE_ADMIN: "Compliance", AGENT: "Agent" };
const ORDER = ["MANAGING_BROKER", "ADMIN", "COMPLIANCE_ADMIN", "AGENT"];

const prisma = new PrismaClient();
try {
  const users = await prisma.user.findMany({ where: { isActive: true }, orderBy: [{ lastName: "asc" }] });
  const real = users.filter((u) => !u.email.toLowerCase().endsWith(".test"));
  if (users.length === 0 || real.length > 0) {
    console.error(`Refusing: ${users.length === 0 ? "no accounts yet" : `${real.length} account(s) aren't demo accounts (*.test)`}.`);
    process.exit(3);
  }
  users.sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role));
  const now = new Date();
  for (const u of users) {
    const token = newToken();
    const unknowable = await hashPassword(newToken());
    await prisma.$transaction([
      prisma.authToken.updateMany({ where: { userId: u.id, usedAt: null }, data: { usedAt: now } }),
      prisma.authToken.create({
        data: { id: randomUUID(), userId: u.id, purpose: "PASSWORD_RESET", tokenHash: sha256(token), expiresAt: new Date(now.getTime() + 72 * 3_600_000), createdById: u.id },
      }),
      prisma.userCredential.updateMany({ where: { userId: u.id }, data: { passwordHash: unknowable, mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, recoveryCodeHashes: [] } }),
      prisma.session.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: now, revokedReason: "DEMO_HANDOVER" } }),
    ]);
    await audit(prisma, { userId: u.id, entity: "User", entityId: u.id, action: "DEMO_HANDOVER", outcome: "SUCCESS", ip: null, userAgent: "demo-handover" });
    console.log(`${(ROLE[u.role] ?? u.role).padEnd(17)} ${`${u.firstName} ${u.lastName}`.padEnd(17)} ${u.email}`);
    console.log(`  ${appUrl}/reset-password#token=${token}`);
  }
} finally {
  await prisma.$disconnect();
}
