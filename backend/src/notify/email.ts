/**
 * Outgoing email. Everything the system sends goes into "EmailOutbox" first (migration 023), then a sender delivers it.
 *
 *   No email service configured   emails wait in the outbox as QUEUED (admins see them); nothing leaves the server
 *   SMTP_URL + EMAIL_FROM set      delivered over SMTP (e.g. Microsoft 365, Google Workspace, Postmark, SendGrid)
 *
 * A delivery that fails is retried on the next run; after 5 attempts it's marked FAILED with the error.
 */

import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { createTransport } from "nodemailer";

type Db = PrismaClient | Prisma.TransactionClient;
const MAX_ATTEMPTS = 5;

export interface OutgoingEmail { kind: string; to: string[]; cc?: string[]; subject: string; text: string; relatedUserId?: string | null }
export interface EmailSender { send(e: { from: string; to: string[]; cc: string[]; subject: string; text: string }): Promise<void> }

export async function queueEmail(db: Db, e: OutgoingEmail): Promise<string> {
  const id = randomUUID();
  await db.emailOutbox.create({ data: { id, kind: e.kind, toAddresses: e.to, ccAddresses: e.cc ?? [], subject: e.subject, bodyText: e.text,
    relatedUserId: e.relatedUserId ?? null } });
  return id;
}

/** The configured sender, or null when no email service is set up (emails then wait in the outbox) */
export function senderFromEnv(env: NodeJS.ProcessEnv = process.env): { sender: EmailSender; from: string } | null {
  if (!env.SMTP_URL || !env.EMAIL_FROM) return null;
  const transport = createTransport(env.SMTP_URL);
  return { from: env.EMAIL_FROM, sender: { send: async (m) => { await transport.sendMail(m); } } };
}

/** Sends what's queued. Returns how many were sent and how many failed this run. */
export async function deliverQueued(prisma: PrismaClient, mail: { sender: EmailSender; from: string } | null, limit = 50) {
  if (!mail) return { sent: 0, failed: 0, waiting: await prisma.emailOutbox.count({ where: { status: "QUEUED" } }) };
  const queued = await prisma.emailOutbox.findMany({ where: { status: "QUEUED" }, orderBy: { createdAt: "asc" }, take: limit });
  let sent = 0;
  let failed = 0;
  for (const e of queued) {
    try {
      await mail.sender.send({ from: mail.from, to: e.toAddresses, cc: e.ccAddresses, subject: e.subject, text: e.bodyText });
      await prisma.emailOutbox.update({ where: { id: e.id }, data: { status: "SENT", sentAt: new Date(), attempts: e.attempts + 1, lastError: null } });
      sent++;
    } catch (err) {
      const attempts = e.attempts + 1;
      await prisma.emailOutbox.update({ where: { id: e.id }, data: {
        attempts, lastError: String((err as Error)?.message ?? err).slice(0, 500), ...(attempts >= MAX_ATTEMPTS ? { status: "FAILED" } : {}) } });
      failed++;
    }
  }
  return { sent, failed, waiting: await prisma.emailOutbox.count({ where: { status: "QUEUED" } }) };
}
