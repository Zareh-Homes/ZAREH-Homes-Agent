import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, type Actor, type ResolveUserId } from "../auth.ts";
import { DomainError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import {
  flagHold,
  getDealLedger,
  getEntry,
  recordDeposit,
  recordDisbursement,
  releaseHold,
  reverseEntry,
  type LedgerWriteResult,
} from "./service.ts";
import {
  validateDeposit,
  validateDisbursement,
  validateHold,
  validateIdempotencyKey,
  validatePathUuid,
  validateRelease,
  validateReversal,
} from "./validation.ts";

export interface TrustRouteOptions {
  prisma: PrismaClient;
  resolveUserId: ResolveUserId;
  /** Injectable for tests; defaults to the real date in Toronto. */
  today?: () => string;
}

type Params = Record<string, string>;

/**
 * POST   /api/trust/deposits                       record a deposit receipt
 * POST   /api/trust/disbursements                  pay funds out of trust
 * POST   /api/trust/entries/:entryId/reversals     correct an entry
 * GET    /api/trust/entries/:entryId               one entry
 * GET    /api/deals/:dealId/trust                  deal ledger, balance, holds
 * POST   /api/deals/:dealId/trust/holds            flag Disputed / Unclaimed
 * POST   /api/trust/holds/:holdId/release          broker releases a hold
 * PUT | PATCH | DELETE /api/trust/entries/:id      always 405 (ledger is insert-only)
 *
 * Every POST that moves money requires an Idempotency-Key header (UUID).
 * Retrying with the same key returns the original entry instead of paying twice.
 */
export async function trustRoutes(app: FastifyInstance, opts: TrustRouteOptions): Promise<void> {
  const { prisma } = opts;
  const today = opts.today ?? (() => todayInToronto());

  const actorOf = async (request: FastifyRequest): Promise<Actor> =>
    loadActor(prisma, await opts.resolveUserId(request));

  const sendWrite = (reply: FastifyReply, result: LedgerWriteResult) =>
    reply.code(result.replayed ? 200 : 201).send(result);

  app.post("/api/trust/deposits", async (request, reply) => {
    const actor = await actorOf(request);
    const key = validateIdempotencyKey(request.headers["idempotency-key"]);
    const input = validateDeposit(request.body, today());
    return sendWrite(reply, await recordDeposit(prisma, actor, input, key));
  });

  app.post("/api/trust/disbursements", async (request, reply) => {
    const actor = await actorOf(request);
    const key = validateIdempotencyKey(request.headers["idempotency-key"]);
    const input = validateDisbursement(request.body, today());
    return sendWrite(reply, await recordDisbursement(prisma, actor, input, key));
  });

  app.post<{ Params: Params }>("/api/trust/entries/:entryId/reversals", async (request, reply) => {
    const actor = await actorOf(request);
    const entryId = validatePathUuid(request.params.entryId, "entryId");
    const key = validateIdempotencyKey(request.headers["idempotency-key"]);
    const input = validateReversal(request.body, today());
    return sendWrite(reply, await reverseEntry(prisma, actor, entryId, input, key));
  });

  app.get<{ Params: Params }>("/api/trust/entries/:entryId", async (request) => {
    const actor = await actorOf(request);
    return getEntry(prisma, actor, validatePathUuid(request.params.entryId, "entryId"));
  });

  app.get<{ Params: Params }>("/api/deals/:dealId/trust", async (request) => {
    const actor = await actorOf(request);
    return getDealLedger(prisma, actor, validatePathUuid(request.params.dealId, "dealId"));
  });

  app.post<{ Params: Params }>("/api/deals/:dealId/trust/holds", async (request, reply) => {
    const actor = await actorOf(request);
    const dealId = validatePathUuid(request.params.dealId, "dealId");
    const input = validateHold(request.body);
    return reply.code(201).send(await flagHold(prisma, actor, dealId, input));
  });

  app.post<{ Params: Params }>("/api/trust/holds/:holdId/release", async (request) => {
    const actor = await actorOf(request);
    const holdId = validatePathUuid(request.params.holdId, "holdId");
    return releaseHold(prisma, actor, holdId, validateRelease(request.body));
  });

  // The audit trail invariant, visible at the API surface too
  const immutable = async () => {
    throw new DomainError(
      "TRUST_LEDGER_IMMUTABLE",
      405,
      "Trust ledger entries can't be changed or deleted. Post a reversal: POST /api/trust/entries/:entryId/reversals",
    );
  };
  app.put("/api/trust/entries/:entryId", immutable);
  app.patch("/api/trust/entries/:entryId", immutable);
  app.delete("/api/trust/entries/:entryId", immutable);
}
