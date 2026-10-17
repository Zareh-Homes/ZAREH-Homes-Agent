import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, type ResolveUserId } from "../auth.ts";
import { getDashboard } from "./service.ts";

export interface DashboardRouteOptions {
  prisma: PrismaClient;
  resolveUserId: ResolveUserId;
  today?: () => string;
}

/** GET /api/dashboard — the signed-in user's dashboard; sections depend on their role. */
export async function dashboardRoutes(app: FastifyInstance, opts: DashboardRouteOptions): Promise<void> {
  app.get("/api/dashboard", async (request, reply) => {
    const actor = await loadActor(opts.prisma, await opts.resolveUserId(request));
    reply.header("cache-control", "private, no-store");
    return getDashboard(opts.prisma, actor, opts.today?.());
  });
}
