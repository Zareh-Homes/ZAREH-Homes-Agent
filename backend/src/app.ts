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

export interface AppOptions {
  prisma: PrismaClient;
  resolveUserId: ResolveUserId;
  fileStore: FileStore;
  brokerage: BrokerageProfile;
  notificationHub?: NotificationHub;
  logger?: boolean;
  today?: () => string;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });

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
  app.register(trustRoutes, { prisma: opts.prisma, resolveUserId: opts.resolveUserId, today: opts.today });
  app.register(complianceRoutes, {
    prisma: opts.prisma,
    store: opts.fileStore,
    hub,
    resolveUserId: opts.resolveUserId,
    today: opts.today,
  });
  app.register(closingRoutes, {
    prisma: opts.prisma,
    brokerage: opts.brokerage,
    resolveUserId: opts.resolveUserId,
    today: opts.today,
  });
  app.register(dashboardRoutes, { prisma: opts.prisma, resolveUserId: opts.resolveUserId, today: opts.today });
  app.register(pipelineRoutes, { prisma: opts.prisma, resolveUserId: opts.resolveUserId, today: opts.today });
  app.register(bankRoutes, { prisma: opts.prisma, hub, resolveUserId: opts.resolveUserId, today: opts.today });
  return app;
}
