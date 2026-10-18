import Fastify, { type FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { ResolveUserId } from "./auth.ts";
import { DomainError } from "./errors.ts";
import { trustRoutes } from "./trust/routes.ts";
import { complianceRoutes } from "./compliance/routes.ts";
import { NotificationHub } from "./compliance/notifications.ts";
import type { FileStore } from "./compliance/storage.ts";
import { closingRoutes } from "./closing/routes.ts";
import type { BrokerageProfile } from "./closing/cda-template.ts";
import { dashboardRoutes } from "./dashboard/routes.ts";
import { pipelineRoutes } from "./pipeline/routes.ts";
import { bankRoutes } from "./bank/routes.ts";
import { privacyRoutes } from "./security/privacy.ts";
import { unclaimedRoutes } from "./bank/unclaimed.ts";
import { fundsRoutes } from "./accounting/funds.ts";
import { commissionRoutes } from "./commission/service.ts";
import { lifecycleRoutes } from "./deals/lifecycle.ts";
import { tradeRecordRoutes } from "./deals/trade-record.ts";
import type { AccountingAdapter } from "./accounting/adapter.ts";
import type { AccountRole } from "./accounting/journal.ts";
import type { AuthService } from "./security/auth-service.ts";
import { FieldCipher } from "./security/crypto.ts";
import { registerHttpSecurity } from "./security/http.ts";
import { randomBytes } from "node:crypto";

export interface AppOptions {
  prisma: PrismaClient;
  /** Development / test only: how to find the caller without a session. Ignored when `auth` is given. */
  resolveUserId?: ResolveUserId;
  /** Production: session cookies, CSRF and MFA. */
  auth?: AuthService;
  fieldCipher?: FieldCipher;
  cookieSecure?: boolean;
  allowedOrigins?: string[];
  rateLimits?: { loginPerMinutePerIp: number; loginPerMinutePerEmail: number; apiPerMinute: number };
  fileStore: FileStore;
  brokerage: BrokerageProfile;
  notificationHub?: NotificationHub;
  /** Read-only accounting connection (QuickBooks Online or Xero), for the operating account's obligations */
  accounting?: AccountingAdapter | null;
  /** Account role → chart of accounts code, from the accountant */
  accountMap?: Partial<Record<AccountRole, string>>;
  logger?: boolean;
  today?: () => string;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024, trustProxy: process.env.TRUST_PROXY === "true" });
  if (!opts.auth && !opts.resolveUserId) throw new Error("buildApp needs either auth (sessions) or resolveUserId (development)");
  // With sessions, the caller is whoever the session says: never a header the client sends
  const resolveUserId: ResolveUserId = opts.auth ? (request) => request.auth?.userId ?? null : opts.resolveUserId!;
  const fieldCipher = opts.auth?.config.fieldCipher ?? opts.fieldCipher ?? new FieldCipher(randomBytes(32));
  registerHttpSecurity(app, {
    prisma: opts.prisma,
    auth: opts.auth ?? null,
    cookieSecure: opts.auth?.config.cookieSecure ?? opts.cookieSecure ?? false,
    allowedOrigins: opts.auth?.config.allowedOrigins ?? opts.allowedOrigins ?? [],
    limits: opts.rateLimits,
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    // Malformed JSON and other client errors raised by Fastify itself
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "BAD_REQUEST", message: (err as Error).message } });
    }
    request.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "INTERNAL", message: "Something went wrong" } });
  });

  const hub = opts.notificationHub ?? new NotificationHub();
  app.register(trustRoutes, { prisma: opts.prisma, resolveUserId, today: opts.today });
  app.register(complianceRoutes, {
    prisma: opts.prisma,
    store: opts.fileStore,
    hub,
    resolveUserId,
    fieldCipher,
    today: opts.today,
  });
  app.register(closingRoutes, {
    prisma: opts.prisma,
    brokerage: opts.brokerage,
    resolveUserId,
    today: opts.today,
  });
  app.register(dashboardRoutes, { prisma: opts.prisma, resolveUserId, today: opts.today });
  app.register(pipelineRoutes, { prisma: opts.prisma, resolveUserId, today: opts.today });
  app.register(bankRoutes, { prisma: opts.prisma, hub, resolveUserId, today: opts.today });
  app.register(privacyRoutes, { prisma: opts.prisma, resolveUserId, today: opts.today });
  app.register(unclaimedRoutes, { prisma: opts.prisma, resolveUserId, today: opts.today });
  app.register(commissionRoutes, { prisma: opts.prisma, resolveUserId, today: opts.today });
  app.register(lifecycleRoutes, { prisma: opts.prisma, resolveUserId, today: opts.today });
  app.register(tradeRecordRoutes, { prisma: opts.prisma, resolveUserId });
  app.register(fundsRoutes, { prisma: opts.prisma, resolveUserId, today: opts.today, accounting: opts.accounting ?? null, accountMap: opts.accountMap });
  return app;
}
