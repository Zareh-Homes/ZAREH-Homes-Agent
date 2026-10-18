import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, type ResolveUserId } from "../auth.ts";
import { getPipeline } from "./service.ts";

export interface PipelineRouteOptions {
  prisma: PrismaClient;
  resolveUserId: ResolveUserId;
  today?: () => string;
}

/** GET /api/pipeline — the deal board. Agents get their own deals; staff get everyone's. */
export async function pipelineRoutes(app: FastifyInstance, opts: PipelineRouteOptions): Promise<void> {
  app.get("/api/pipeline", async (request, reply) => {
    const actor = await loadActor(opts.prisma, await opts.resolveUserId(request));
    reply.header("cache-control", "private, no-store");
    return getPipeline(opts.prisma, actor, opts.today?.());
  });
}
