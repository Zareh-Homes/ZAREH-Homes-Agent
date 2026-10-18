import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, TRUST_VIEWERS, type Actor, type ResolveUserId } from "../auth.ts";
import type { NotificationHub } from "../compliance/notifications.ts";
import { validatePathUuid } from "../trust/validation.ts";
import {
  attestPreCutover,
  createOperatingAccount,
  getReconciliation,
  getStatement,
  importStatement,
  matchLine,
  prepareReconciliation,
  previewReconciliation,
  reconciliationStatus,
  signReconciliation,
  unmatch,
  type BankDeps,
} from "./service.ts";
import { todayInToronto } from "../lib/dates.ts";

export interface BankRouteOptions {
  prisma: PrismaClient;
  hub: NotificationHub;
  resolveUserId: ResolveUserId;
  today?: () => string;
}

type Params = Record<string, string>;

/**
 * POST   /api/operating-accounts                        add the brokerage's general account (admin / broker)
 * POST   /api/bank/statements                           import a monthly statement from the bank's CSV (admin / broker)
 * GET    /api/bank/statements/:statementId              lines and what each is matched to
 * POST   /api/bank/matches                              match a line to a trust entry or commission receipt
 * DELETE /api/bank/matches/:matchId                     undo a wrong match (not once funds moved on it)
 * POST   /api/bank/pre-cutover                          broker attests to history before the first statement
 * GET    /api/bank/statements/:statementId/reconciliation   live three-way reconciliation, not saved
 * POST   /api/trust/reconciliations                     prepare and save the month's reconciliation (admin / broker)
 * GET    /api/trust/reconciliations/:id                 one reconciliation
 * POST   /api/trust/reconciliations/:id/sign            broker of record signs (managing broker)
 * GET    /api/trust/reconciliation-status               per account: last signed month, months awaiting signature
 */
export async function bankRoutes(app: FastifyInstance, opts: BankRouteOptions): Promise<void> {
  const deps: BankDeps = { prisma: opts.prisma, hub: opts.hub, today: opts.today };
  const actorOf = async (request: FastifyRequest): Promise<Actor> => loadActor(opts.prisma, await opts.resolveUserId(request));

  app.post("/api/operating-accounts", async (request, reply) =>
    reply.code(201).send(await createOperatingAccount(deps, await actorOf(request), request.body)));

  app.post("/api/bank/statements", { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) =>
    reply.code(201).send(await importStatement(deps, await actorOf(request), request.body)));

  app.get<{ Params: Params }>("/api/bank/statements/:statementId", async (request) =>
    getStatement(deps, await actorOf(request), validatePathUuid(request.params.statementId, "statementId")));

  app.get<{ Params: Params }>("/api/bank/statements/:statementId/reconciliation", async (request) =>
    previewReconciliation(deps, await actorOf(request), validatePathUuid(request.params.statementId, "statementId")));

  app.post("/api/bank/matches", async (request, reply) =>
    reply.code(201).send(await matchLine(deps, await actorOf(request), request.body)));

  app.delete<{ Params: Params }>("/api/bank/matches/:matchId", async (request) =>
    unmatch(deps, await actorOf(request), validatePathUuid(request.params.matchId, "matchId")));

  app.post("/api/bank/pre-cutover", async (request, reply) =>
    reply.code(201).send(await attestPreCutover(deps, await actorOf(request), request.body)));

  app.post("/api/trust/reconciliations", async (request, reply) =>
    reply.code(201).send(await prepareReconciliation(deps, await actorOf(request), request.body)));

  app.get<{ Params: Params }>("/api/trust/reconciliations/:id", async (request) =>
    getReconciliation(deps, await actorOf(request), validatePathUuid(request.params.id, "id")));

  app.post<{ Params: Params }>("/api/trust/reconciliations/:id/sign", async (request) =>
    signReconciliation(deps, await actorOf(request), validatePathUuid(request.params.id, "id"), request.body));

  app.get("/api/trust/reconciliation-status", async (request) => {
    requireRole(await actorOf(request), TRUST_VIEWERS, "Viewing reconciliation status");
    return { accounts: await reconciliationStatus(opts.prisma, opts.today?.() ?? todayInToronto()) };
  });
}
