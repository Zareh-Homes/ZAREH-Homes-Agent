/**
 * The append-only audit trail (AuditLog, migration 010). Written for sign-in
 * events, every state-changing API call, and every view or export of
 * identification, banking or trust records. Never records passwords, tokens,
 * request bodies or ID numbers.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

export interface AuditEvent {
  userId: string | null;
  sessionId?: string | null;
  entity: string;
  entityId: string;
  action: string;
  outcome: "SUCCESS" | "DENIED" | "FAILED" | "ERROR";
  changes?: Record<string, unknown> | null;
  route?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

type Db = PrismaClient | Prisma.TransactionClient;

export async function audit(db: Db, e: AuditEvent): Promise<void> {
  // userId only if it names a real user (a forged or unknown id is still logged, in changes)
  await db.$executeRaw`
    INSERT INTO "AuditLog" ("userId", entity, "entityId", action, changes, "sessionId", ip, "userAgent", outcome, route)
    VALUES ((SELECT id FROM "User" WHERE id::text = ${e.userId ?? ""}), ${e.entity}, ${e.entityId}, ${e.action},
            ${e.changes ? JSON.stringify(e.changes) : null}::jsonb, ${e.sessionId ?? null}::uuid, ${e.ip ?? null},
            ${e.userAgent?.slice(0, 300) ?? null}, ${e.outcome}, ${e.route ?? null})`;
}

/** GET routes whose responses contain identification, banking or trust detail: every view is logged. */
export const SENSITIVE_READS: readonly RegExp[] = [
  /^\/api\/documents\/files\//,
  /^\/api\/bank\//,
  /^\/api\/trust\//,
  /^\/api\/deals\/[^/]+\/trust/,
  /^\/api\/deals\/[^/]+\/closing/,
  /^\/api\/audit/,
  /^\/api\/fintrac/,
  /^\/api\/exports?\//,
  /\/export(\?|$)/,
];

export const isSensitiveRead = (url: string) => SENSITIVE_READS.some((re) => re.test(url));
