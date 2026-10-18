/**
 * Privacy operations: breach records (PIPEDA), legal holds, and the retention
 * report. Nothing here deletes records or contacts anyone: disposal and
 * breach notifications are manual, approved actions that this code records.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, type Actor, type ResolveUserId } from "../auth.ts";
import { DomainError, fromDatabaseError, NotFoundError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { Reader } from "../lib/reader.ts";
import { validatePathUuid } from "../trust/validation.ts";

const PRIVACY_STAFF = ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"] as const;

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  throw fromDatabaseError(err) ?? err;
}

export async function recordBreach(prisma: PrismaClient, actor: Actor, body: unknown, today: string) {
  requireRole(actor, PRIVACY_STAFF, "Recording a privacy breach");
  const r = new Reader(body, ["discoveredAt", "occurredFrom", "occurredTo", "description", "informationInvolved", "individualsAffected"]);
  const input = {
    discoveredAt: r.pastDate("discoveredAt", today),
    occurredFrom: r.optionalDate("occurredFrom"),
    occurredTo: r.optionalDate("occurredTo"),
    description: r.text("description", 4000),
    informationInvolved: r.text("informationInvolved", 2000),
    individualsAffected: r.has("individualsAffected") ? r.percent("individualsAffected", 0, 10_000_000) : null,
  };
  r.done();
  const id = randomUUID();
  try {
    await prisma.$executeRaw`
      INSERT INTO "PrivacyBreach" (id, "discoveredAt", "occurredFrom", "occurredTo", description, "informationInvolved", "individualsAffected", "recordedById")
      VALUES (${id}::uuid, ${input.discoveredAt}::timestamptz, ${input.occurredFrom}::date, ${input.occurredTo}::date, ${input.description},
              ${input.informationInvolved}, ${input.individualsAffected}, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return breachView(prisma, id);
}

export async function addBreachEvent(prisma: PrismaClient, actor: Actor, breachId: string, body: unknown, today: string) {
  requireRole(actor, PRIVACY_STAFF, "Updating a privacy breach record");
  const r = new Reader(body, ["kind", "eventDate", "realRiskOfSignificantHarm", "reference", "note"]);
  const input = {
    kind: r.oneOf("kind", ["NOTE", "CONTAINED", "RISK_ASSESSED", "OPC_REPORTED", "INDIVIDUALS_NOTIFIED", "ORGANIZATIONS_NOTIFIED", "CLOSED"] as const),
    eventDate: r.has("eventDate") ? r.pastDate("eventDate", today) : today,
    rrosh: r.has("realRiskOfSignificantHarm") ? r.bool("realRiskOfSignificantHarm") : null,
    reference: r.optionalText("reference", 200),
    note: r.text("note", 4000),
  };
  r.check(!["OPC_REPORTED", "INDIVIDUALS_NOTIFIED"].includes(input.kind) || input.reference !== null, "reference", "is required as evidence");
  r.check(input.kind !== "RISK_ASSESSED" || input.rrosh !== null, "realRiskOfSignificantHarm", "is required for a risk assessment");
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "PrivacyBreachEvent" (id, "breachId", kind, "eventDate", "realRiskOfSignificantHarm", reference, note, "actorId")
      VALUES (gen_random_uuid(), ${breachId}::uuid, ${input.kind}::"BreachEventKind", ${input.eventDate}::date, ${input.rrosh},
              ${input.reference}, ${input.note}, ${actor.id}::uuid)`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23503") throw new NotFoundError("Privacy breach", breachId);
    rethrow(err);
  }
  return breachView(prisma, breachId);
}

async function breachView(prisma: PrismaClient, id: string) {
  const b = await prisma.privacyBreach.findUnique({ where: { id }, include: { events: { orderBy: { createdAt: "asc" } } } });
  if (!b) throw new NotFoundError("Privacy breach", id);
  const assessed = [...b.events].reverse().find((e) => e.kind === "RISK_ASSESSED");
  const has = (k: string) => b.events.some((e) => e.kind === k);
  const outstanding: string[] = [];
  if (!has("CLOSED")) {
    if (!has("CONTAINED")) outstanding.push("Contain the breach and record what was done");
    if (!assessed) outstanding.push("Assess whether it creates a real risk of significant harm (sensitivity and probability of misuse)");
    if (assessed?.realRiskOfSignificantHarm) {
      if (!has("OPC_REPORTED")) outstanding.push("Report to the Privacy Commissioner of Canada as soon as feasible");
      if (!has("INDIVIDUALS_NOTIFIED")) outstanding.push("Notify affected individuals as soon as feasible");
    }
  }
  return {
    id: b.id, discoveredAt: b.discoveredAt.toISOString(), description: b.description, informationInvolved: b.informationInvolved,
    individualsAffected: b.individualsAffected, realRiskOfSignificantHarm: assessed?.realRiskOfSignificantHarm ?? null,
    closed: has("CLOSED"), outstanding,
    keepUntil: new Date(b.discoveredAt.getTime() + 2 * 365.25 * 86_400_000).toISOString().slice(0, 10),
    events: b.events.map((e) => ({ kind: e.kind, eventDate: e.eventDate.toISOString().slice(0, 10), reference: e.reference, note: e.note })),
  };
}

export async function placeHold(prisma: PrismaClient, actor: Actor, body: unknown) {
  requireRole(actor, PRIVACY_STAFF, "Placing a legal hold");
  const r = new Reader(body, ["dealId", "reason"]);
  const dealId = r.optionalUuid("dealId");
  const reason = r.text("reason", 1000);
  r.done();
  const id = randomUUID();
  await prisma.legalHold.create({ data: { id, transactionId: dealId, reason, placedById: actor.id } });
  return { id, dealId, reason };
}

export async function releaseHold(prisma: PrismaClient, actor: Actor, id: string, body: unknown) {
  requireRole(actor, ["MANAGING_BROKER", "COMPLIANCE_ADMIN"], "Releasing a legal hold");
  const r = new Reader(body, ["note"]);
  const note = r.text("note", 1000);
  r.done();
  const n = await prisma.legalHold.updateMany({ where: { id, releasedAt: null }, data: { releasedAt: new Date(), releasedById: actor.id, releaseNote: note } });
  if (n.count === 0) throw new NotFoundError("Active legal hold", id);
  return { released: id };
}

/**
 * Deals whose trade records have passed their retention period and aren't on
 * hold. A report for a person to act on; nothing is deleted.
 */
export async function retentionReport(prisma: PrismaClient, actor: Actor, today: string) {
  requireRole(actor, PRIVACY_STAFF, "Viewing the retention report");
  const rules = await prisma.retentionRule.findMany({ orderBy: { recordType: "asc" } });
  const trade = rules.find((x) => x.recordType === "TRADE_RECORDS")!;
  const cutoff = `${Number(today.slice(0, 4)) - trade.retentionYears}${today.slice(4)}`;
  const brokerageHold = await prisma.legalHold.count({ where: { transactionId: null, releasedAt: null } });
  const deals = brokerageHold ? [] : await prisma.$queryRaw<{ id: string; dealNumber: string; closeDate: string; status: string }[]>`
    SELECT t.id::text, t."dealNumber", to_char(t."closeDate", 'YYYY-MM-DD') AS "closeDate", t.status::text AS status
      FROM "Transaction" t
     WHERE t.status IN ('CLOSED', 'COLLAPSED', 'CANCELLED') AND t."closeDate" < ${cutoff}::date
       AND NOT EXISTS (SELECT 1 FROM "LegalHold" h WHERE h."transactionId" = t.id AND h."releasedAt" IS NULL)
     ORDER BY t."closeDate" LIMIT 500`;
  return {
    asOf: today,
    rules: rules.map((x) => ({ recordType: x.recordType, retentionYears: x.retentionYears, startsFrom: x.startsFrom, legalBasis: x.legalBasis })),
    brokerageWideHold: brokerageHold > 0,
    eligibleForDisposalReview: deals,
    note: "Eligible for review only. Disposal needs broker approval and secure destruction outside this system; trust and FINTRAC records may have longer periods if under examination.",
  };
}

export async function privacyRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; today?: () => string }) {
  const actorOf = async (request: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(request));
  const today = () => opts.today?.() ?? todayInToronto();
  app.post("/api/privacy/breaches", async (req, reply) => reply.code(201).send(await recordBreach(opts.prisma, await actorOf(req), req.body, today())));
  app.get<{ Params: Record<string, string> }>("/api/privacy/breaches/:id", async (req) => {
    requireRole(await actorOf(req), PRIVACY_STAFF, "Viewing a privacy breach");
    return breachView(opts.prisma, validatePathUuid(req.params.id, "id"));
  });
  app.post<{ Params: Record<string, string> }>("/api/privacy/breaches/:id/events", async (req, reply) =>
    reply.code(201).send(await addBreachEvent(opts.prisma, await actorOf(req), validatePathUuid(req.params.id, "id"), req.body, today())));
  app.post("/api/privacy/legal-holds", async (req, reply) => reply.code(201).send(await placeHold(opts.prisma, await actorOf(req), req.body)));
  app.post<{ Params: Record<string, string> }>("/api/privacy/legal-holds/:id/release", async (req) =>
    releaseHold(opts.prisma, await actorOf(req), validatePathUuid(req.params.id, "id"), req.body));
  app.get("/api/privacy/retention-report", async (req) => retentionReport(opts.prisma, await actorOf(req), today()));
}
