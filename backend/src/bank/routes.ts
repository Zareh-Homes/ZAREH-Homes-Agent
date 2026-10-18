import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, TRUST_VIEWERS, type Actor, type ResolveUserId } from "../auth.ts";
import type { NotificationHub } from "../compliance/notifications.ts";
import { validatePathUuid } from "../trust/validation.ts";
import { createDesignation, decidePolicy, endDesignation, listDesignations, listPolicies } from "./governance.ts";
import {
  addIncidentEvent,
  attestPreCutover,
  createOperatingAccount,
  getIncident,
  getReconciliation,
  getStatement,
  importStatement,
  listIncidents,
  matchLine,
  prepareReconciliation,
  previewReconciliation,
  reconciliationStatus,
  signReconciliation,
  unmatch,
  verifyStatement,
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
 * POST   /api/bank/statements                           import a bank CSV: MONTHLY statement or INTERIM activity + balance (admin / broker)
 * POST   /api/bank/statements/:statementId/verify       a second person confirms it against the bank (admin / broker)
 * GET    /api/bank/statements/:statementId              lines and what each is matched to
 * POST   /api/bank/matches                              match a line to a trust entry or commission receipt
 * DELETE /api/bank/matches/:matchId                     undo a wrong match (not once funds moved on it)
 * POST   /api/bank/pre-cutover                          broker attests to history before the first statement
 * GET    /api/bank/statements/:statementId/reconciliation   live three-way reconciliation, not saved
 * POST   /api/trust/reconciliations                     prepare and save the month's reconciliation (admin / broker)
 * GET    /api/trust/reconciliations/:id                 one reconciliation
 * POST   /api/trust/reconciliations/:id/sign            broker of record signs (managing broker)
 * GET    /api/trust/reconciliation-status               per account: last signed month, months to sign, missing statements, incidents
 * GET    /api/trust/incidents?open=true                 shortfalls (s.14) and discrepancies
 * GET    /api/trust/incidents/:id                       one incident, its history and what's still required
 * POST   /api/trust/incidents/:id/events                note / registrar notified / replenished / resolved (records only)
 * GET    /api/broker-of-record                          designations
 * POST   /api/broker-of-record                          record a designation (admin / broker, not for yourself)
 * POST   /api/broker-of-record/:id/end                  end a designation
 * GET    /api/financial-policies                        sign-off switches and their history
 * POST   /api/financial-policies                        broker of record turns one on or off, citing the sign-off
 */
export async function bankRoutes(app: FastifyInstance, opts: BankRouteOptions): Promise<void> {
  const deps: BankDeps = { prisma: opts.prisma, hub: opts.hub, today: opts.today };
  const actorOf = async (request: FastifyRequest): Promise<Actor> => loadActor(opts.prisma, await opts.resolveUserId(request));

  app.post("/api/operating-accounts", async (request, reply) =>
    reply.code(201).send(await createOperatingAccount(deps, await actorOf(request), request.body)));

  app.post("/api/bank/statements", { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) =>
    reply.code(201).send(await importStatement(deps, await actorOf(request), request.body)));

  app.post<{ Params: Params }>("/api/bank/statements/:statementId/verify", async (request) =>
    verifyStatement(deps, await actorOf(request), validatePathUuid(request.params.statementId, "statementId"), request.body));

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

  app.get<{ Querystring: { open?: string } }>("/api/trust/incidents", async (request) =>
    ({ incidents: await listIncidents(deps, await actorOf(request), request.query.open === "true") }));

  app.get<{ Params: Params }>("/api/trust/incidents/:id", async (request) =>
    getIncident(deps, await actorOf(request), validatePathUuid(request.params.id, "id")));

  app.post<{ Params: Params }>("/api/trust/incidents/:id/events", async (request, reply) =>
    reply.code(201).send(await addIncidentEvent(deps, await actorOf(request), validatePathUuid(request.params.id, "id"), request.body)));

  app.get("/api/broker-of-record", async (request) => ({ designations: await listDesignations(deps, await actorOf(request)) }));

  app.post("/api/broker-of-record", async (request, reply) =>
    reply.code(201).send(await createDesignation(deps, await actorOf(request), request.body)));

  app.post<{ Params: Params }>("/api/broker-of-record/:id/end", async (request) =>
    endDesignation(deps, await actorOf(request), validatePathUuid(request.params.id, "id"), request.body));

  app.get("/api/financial-policies", async (request) => ({ policies: await listPolicies(deps, await actorOf(request)) }));

  app.post("/api/financial-policies", async (request) => decidePolicy(deps, await actorOf(request), request.body));

  app.get("/api/trust/reconciliation-status", async (request) => {
    requireRole(await actorOf(request), TRUST_VIEWERS, "Viewing reconciliation status");
    return { accounts: await reconciliationStatus(opts.prisma, opts.today?.() ?? todayInToronto()) };
  });
}
