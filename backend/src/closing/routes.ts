import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, type Actor, type ResolveUserId } from "../auth.ts";
import { ValidationError } from "../errors.ts";
import { validateIdempotencyKey, validatePathUuid } from "../trust/validation.ts";
import type { BrokerageProfile } from "./cda-template.ts";
import { approvePayout, getPayouts, markPayoutPaid, recordCommissionReceived } from "./payouts.ts";
import { cdaHtml, finalizeClosing, previewClosing, type ClosingDeps } from "./service.ts";

export interface ClosingRouteOptions {
  prisma: PrismaClient;
  brokerage: BrokerageProfile;
  resolveUserId: ResolveUserId;
  today?: () => string;
}

type Params = Record<string, string>;

/**
 * GET  /api/deals/:dealId/closing                       numbers (preview, or the finalized statement)
 * GET  /api/deals/:dealId/closing/cda?audience=lawyer   print-ready CDA (DRAFT until finalized)
 * GET  /api/deals/:dealId/closing/cda?audience=internal same + agent statements and HST position
 * POST /api/deals/:dealId/closing/finalize              post trust distributions, freeze the CDA
 *                                                       (managing broker, Idempotency-Key header)
 *
 * After finalizing, the brokerage pays its agents (the payer never pays them directly):
 * GET  /api/deals/:dealId/closing/payouts               commission received + each payout's status
 * POST /api/deals/:dealId/closing/commission-received   record the payer's payment (admin / managing broker)
 * POST /api/payouts/:payoutId/approve                   managing broker, once the commission is in full
 * POST /api/payouts/:payoutId/paid                      record the payment to the agent, with its reference
 */
export async function closingRoutes(app: FastifyInstance, opts: ClosingRouteOptions): Promise<void> {
  const deps: ClosingDeps = { prisma: opts.prisma, brokerage: opts.brokerage, today: opts.today };
  const actorOf = async (request: FastifyRequest): Promise<Actor> =>
    loadActor(opts.prisma, await opts.resolveUserId(request));

  app.get<{ Params: Params }>("/api/deals/:dealId/closing", async (request) => {
    const actor = await actorOf(request);
    return previewClosing(deps, actor, validatePathUuid(request.params.dealId, "dealId"));
  });

  app.get<{ Params: Params; Querystring: { audience?: string } }>("/api/deals/:dealId/closing/cda", async (request, reply) => {
    const actor = await actorOf(request);
    const dealId = validatePathUuid(request.params.dealId, "dealId");
    const audience = request.query.audience ?? "lawyer";
    if (audience !== "lawyer" && audience !== "internal") {
      throw new ValidationError([{ field: "audience", message: "must be lawyer or internal" }]);
    }
    const html = await cdaHtml(deps, actor, dealId, audience);
    return reply
      .header("content-type", "text/html; charset=utf-8")
      .header("cache-control", "private, no-store")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
      .send(html);
  });

  app.post<{ Params: Params }>("/api/deals/:dealId/closing/finalize", async (request, reply) => {
    const actor = await actorOf(request);
    const dealId = validatePathUuid(request.params.dealId, "dealId");
    const key = validateIdempotencyKey(request.headers["idempotency-key"]);
    const result = await finalizeClosing(deps, actor, dealId, key);
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get<{ Params: Params }>("/api/deals/:dealId/closing/payouts", async (request) =>
    getPayouts(deps, await actorOf(request), validatePathUuid(request.params.dealId, "dealId")));

  app.post<{ Params: Params }>("/api/deals/:dealId/closing/commission-received", async (request, reply) => {
    const actor = await actorOf(request);
    const view = await recordCommissionReceived(deps, actor, validatePathUuid(request.params.dealId, "dealId"), request.body);
    return reply.code(201).send(view);
  });

  app.post<{ Params: Params }>("/api/payouts/:payoutId/approve", async (request) =>
    approvePayout(deps, await actorOf(request), validatePathUuid(request.params.payoutId, "payoutId"), request.body));

  app.post<{ Params: Params }>("/api/payouts/:payoutId/paid", async (request) =>
    markPayoutPaid(deps, await actorOf(request), validatePathUuid(request.params.payoutId, "payoutId"), request.body));
}
