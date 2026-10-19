/**
 * Creates the first admin on a fresh installation and prints a one-time
 * invitation link to set their password (72 hours). Every later user is
 * invited by an admin from the app.
 *
 *   DATABASE_URL=<owner or app login> node scripts/create-first-admin.ts \
 *     --email you@brokerage.ca --first Dana --last Lee --app-url https://backoffice.example.ca
 *
 * Refuses once any admin has set a password, so it can't be used to slip in
 * another admin later. The link carries the token after "#", so it never
 * reaches a server log; send it to the person by a channel you trust.
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { PrismaClient } from "@prisma/client";
import { newToken, sha256 } from "../src/security/crypto.ts";
import { audit } from "../src/security/audit.ts";

const { values } = parseArgs({
  options: { email: { type: "string" }, first: { type: "string" }, last: { type: "string" }, "app-url": { type: "string" } },
});
const email = values.email?.trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !values.first || !values.last || !values["app-url"]) {
  console.error("Usage: create-first-admin.ts --email <email> --first <first name> --last <last name> --app-url <https://…>");
  process.exit(2);
}

const prisma = new PrismaClient();
try {
  const established = await prisma.user.count({ where: { role: "ADMIN", isActive: true, credential: { isNot: null } } });
  if (established > 0) {
    console.error("An admin already exists. Ask them to invite new users from the app (Admin → People).");
    process.exit(3);
  }
  const existing = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
  if (existing && existing.role !== "ADMIN") {
    console.error(`${email} already belongs to a ${existing.role} user.`);
    process.exit(3);
  }
  const user = existing ?? await prisma.user.create({ data: { email, firstName: values.first, lastName: values.last, role: "ADMIN" } });
  const token = newToken();
  await prisma.$transaction([
    prisma.authToken.updateMany({ where: { userId: user.id, purpose: "INVITATION", usedAt: null }, data: { usedAt: new Date() } }),
    prisma.authToken.create({
      data: { id: randomUUID(), userId: user.id, purpose: "INVITATION", tokenHash: sha256(token), expiresAt: new Date(Date.now() + 72 * 3_600_000), createdById: user.id },
    }),
  ]);
  await audit(prisma, { userId: user.id, entity: "User", entityId: user.id, action: "FIRST_ADMIN_INVITED", outcome: "SUCCESS", ip: null, userAgent: "create-first-admin" });
  console.log(`Invitation for ${email} (valid 72 hours, works once):\n${values["app-url"].replace(/\/+$/, "")}/accept-invite#token=${token}`);
} finally {
  await prisma.$disconnect();
}
