/**
 * Commission plans, per-deal adjustments and agent recoveries (migration 014).
 *
 *   Plans         effective-dated versions. Proposed by admin or a managing broker, approved by a
 *                 different managing broker, never by the agent. A version can't be dated on or
 *                 before a closing already issued for the agent.
 *   Adjustments   bonuses and deductions on one deal, approved by a managing broker who didn't add
 *                 them. Locked once the CDA is issued.
 *   Recoveries    money an agent owes back. Recovered by a RECOVERY adjustment on a later deal, or
 *                 repaid with a bank reference. Nothing is deducted automatically.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, TRUST_VIEWERS, type Actor, type ResolveUserId } from "../auth.ts";
import { ConflictError, DomainError, fromDatabaseError, NotFoundError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { formatCents, numericToCents } from "../lib/money.ts";
import { Reader } from "../lib/reader.ts";
import { validatePathUuid } from "../trust/validation.ts";

const STAFF = ["ADMIN", "MANAGING_BROKER"] as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function rethrow(err: unknown, duplicate = "Already exists"): never {
  if (err instanceof DomainError) throw err;
  if ((err as { meta?: { code?: string } })?.meta?.code === "23505") throw new ConflictError("DUPLICATE", duplicate);
  throw fromDatabaseError(err) ?? err;
}

// ── Plans ────────────────────────────────────────────────────────────────────

export async function listPlans(prisma: PrismaClient, actor: Actor, userId: string, today: string) {
  if (actor.id !== userId) requireRole(actor, TRUST_VIEWERS, "Viewing another agent's commission plan");
  const versions = await prisma.commissionPlanVersion.findMany({
    where: { userId }, orderBy: { effectiveFrom: "asc" },
    include: { createdBy: { select: { firstName: true, lastName: true } }, approvedBy: { select: { firstName: true, lastName: true } } },
  });
  const [current] = await prisma.$queryRaw<{ id: string }[]>`
    SELECT (p).id::text AS id FROM (SELECT plan_in_force(${userId}::uuid, ${today}::date) AS p) x WHERE (p).id IS NOT NULL`;
  const name = (u: { firstName: string; lastName: string } | null) => (u ? `${u.firstName} ${u.lastName}` : null);
  return {
    userId,
    inForceToday: current?.id ?? null,
    versions: versions.map((v) => ({
      id: v.id, effectiveFrom: iso(v.effectiveFrom), splitBps: v.splitBps, annualCap: v.annualCap?.toFixed(2) ?? null,
      capYearStart: { month: v.capYearStartMonth, day: v.capYearStartDay }, fees: v.fees, reason: v.reason, source: v.source,
      status: v.source === "LEGACY_PLAN" ? "CARRIED_OVER" : v.approvedAt ? "APPROVED" : "PROPOSED",
      proposedBy: name(v.createdBy), approvedBy: name(v.approvedBy), approvedAt: v.approvedAt?.toISOString() ?? null,
    })),
  };
}

export async function proposePlan(prisma: PrismaClient, actor: Actor, userId: string, body: unknown, today: string) {
  requireRole(actor, STAFF, "Proposing a commission plan");
  const r = new Reader(body, ["effectiveFrom", "splitPct", "annualCap", "capYearStartMonth", "capYearStartDay", "fees", "reason"]);
  const input = {
    effectiveFrom: r.date("effectiveFrom"),
    splitBps: r.has("splitPct") ? Math.round(r.percent("splitPct", 0, 100) * 100) : null,
    annualCap: r.has("annualCap") ? r.amount("annualCap") : null,
    month: r.has("capYearStartMonth") ? r.percent("capYearStartMonth", 1, 12) : 1,
    day: r.has("capYearStartDay") ? r.percent("capYearStartDay", 1, 28) : 1,
    fees: r.objects("fees", ["name", "amount"], { max: 20 }).map((f) => ({ name: f.text("name", 100), amount: formatCents(f.amount("amount")) })),
    reason: r.text("reason", 1000),
  };
  r.check(Number.isInteger(input.month) && Number.isInteger(input.day), "capYearStartMonth", "month and day must be whole numbers");
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "CommissionPlanVersion" (id, "userId", "effectiveFrom", "splitBps", "annualCap", "capYearStartMonth", "capYearStartDay",
                                           fees, reason, "createdById")
      VALUES (gen_random_uuid(), ${userId}::uuid, ${input.effectiveFrom}::date, ${input.splitBps},
              ${input.annualCap === null ? null : formatCents(input.annualCap)}::numeric, ${input.month}, ${input.day},
              ${JSON.stringify(input.fees)}::jsonb, ${input.reason}, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err, `A plan version for this agent already starts on ${input.effectiveFrom}`);
  }
  return listPlans(prisma, actor, userId, today);
}

export async function approvePlan(prisma: PrismaClient, actor: Actor, versionId: string, body: unknown, today: string) {
  requireRole(actor, ["MANAGING_BROKER"], "Approving a commission plan");
  const r = new Reader(body ?? {}, ["exceptionReason"]);
  const exceptionReason = r.optionalText("exceptionReason", 500);
  r.done();
  const v = await prisma.commissionPlanVersion.findUnique({ where: { id: versionId }, select: { userId: true } });
  if (!v) throw new NotFoundError("Commission plan version", versionId);
  try {
    await prisma.$executeRaw`
      UPDATE "CommissionPlanVersion" SET "approvedById" = ${actor.id}::uuid, "approvedAt" = clock_timestamp(), "exceptionReason" = ${exceptionReason}
       WHERE id = ${versionId}::uuid`;
  } catch (err) {
    rethrow(err);
  }
  return listPlans(prisma, actor, v.userId, today);
}

// ── Adjustments ──────────────────────────────────────────────────────────────

export async function listAdjustments(prisma: PrismaClient, actor: Actor, dealId: string) {
  requireRole(actor, TRUST_VIEWERS, "Viewing commission adjustments");
  const rows = await prisma.commissionAdjustment.findMany({
    where: { transactionId: dealId }, orderBy: { createdAt: "asc" },
    include: { user: { select: { firstName: true, lastName: true } } },
  });
  return rows.map((a) => ({
    id: a.id, agent: `${a.user.firstName} ${a.user.lastName}`, userId: a.userId, kind: a.kind, description: a.description,
    amount: a.amount.toFixed(2), taxable: a.taxable, recoveryId: a.recoveryId,
    status: a.withdrawnAt ? "WITHDRAWN" : a.approvedAt ? "APPROVED" : "PROPOSED",
  }));
}

export async function addAdjustment(prisma: PrismaClient, actor: Actor, dealId: string, body: unknown) {
  requireRole(actor, STAFF, "Adding a commission adjustment");
  const r = new Reader(body, ["userId", "kind", "description", "amount", "taxable", "recoveryId"]);
  const input = {
    userId: r.uuid("userId"),
    kind: r.oneOf("kind", ["BONUS", "DEDUCTION", "RECOVERY"] as const),
    description: r.text("description", 300),
    amount: r.amount("amount"),
    taxable: r.has("taxable") ? r.bool("taxable") : false,
    recoveryId: r.optionalUuid("recoveryId"),
  };
  r.check((input.kind === "RECOVERY") === (input.recoveryId !== null), "recoveryId", "is required for a RECOVERY, and only then");
  r.check(input.kind !== "RECOVERY" || !input.taxable, "taxable", "a recovery isn't taxed again");
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "CommissionAdjustment" (id, "transactionId", "userId", kind, description, amount, taxable, "recoveryId", "createdById")
      VALUES (gen_random_uuid(), ${dealId}::uuid, ${input.userId}::uuid, ${input.kind}::"AdjustmentKind", ${input.description},
              ${formatCents(input.amount)}::numeric, ${input.taxable}, ${input.recoveryId}::uuid, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return listAdjustments(prisma, actor, dealId);
}

export async function decideAdjustment(prisma: PrismaClient, actor: Actor, id: string, decision: "approve" | "withdraw") {
  requireRole(actor, decision === "approve" ? ["MANAGING_BROKER"] : STAFF, decision === "approve" ? "Approving an adjustment" : "Withdrawing an adjustment");
  const a = await prisma.commissionAdjustment.findUnique({ where: { id }, select: { transactionId: true } });
  if (!a) throw new NotFoundError("Commission adjustment", id);
  try {
    if (decision === "approve") {
      await prisma.$executeRaw`UPDATE "CommissionAdjustment" SET "approvedById" = ${actor.id}::uuid, "approvedAt" = clock_timestamp() WHERE id = ${id}::uuid`;
    } else {
      await prisma.$executeRaw`UPDATE "CommissionAdjustment" SET "withdrawnById" = ${actor.id}::uuid, "withdrawnAt" = clock_timestamp() WHERE id = ${id}::uuid`;
    }
  } catch (err) {
    rethrow(err);
  }
  return listAdjustments(prisma, actor, a.transactionId);
}

// ── Recoveries ───────────────────────────────────────────────────────────────

export async function recoveryView(prisma: PrismaClient, id: string) {
  const r = await prisma.agentRecovery.findUnique({
    where: { id },
    include: { user: { select: { firstName: true, lastName: true } }, repayments: { orderBy: { createdAt: "asc" } }, sourceClosing: { select: { cdaNumber: true } } },
  });
  if (!r) throw new NotFoundError("Agent recovery", id);
  const [{ outstanding }] = await prisma.$queryRaw<{ outstanding: string }[]>`SELECT recovery_outstanding(${id}::uuid)::text AS outstanding`;
  return {
    id: r.id, agent: `${r.user.firstName} ${r.user.lastName}`, userId: r.userId, amount: r.amount.toFixed(2), reason: r.reason, note: r.note,
    sourceCda: r.sourceClosing?.cdaNumber ?? null, outstanding: formatCents(numericToCents(outstanding)),
    repayments: r.repayments.map((p) => ({ amount: p.amount.toFixed(2), paidDate: iso(p.paidDate), reference: p.reference })),
  };
}

export async function openRecovery(prisma: PrismaClient, actor: Actor, body: unknown) {
  requireRole(actor, ["MANAGING_BROKER"], "Recording money an agent owes back");
  const r = new Reader(body, ["userId", "amount", "reason", "note", "sourceClosingId"]);
  const input = {
    userId: r.uuid("userId"), amount: r.amount("amount"),
    reason: r.oneOf("reason", ["COMMISSION_RECALLED", "OVERPAYMENT", "OTHER"] as const),
    note: r.text("note", 2000), sourceClosingId: r.optionalUuid("sourceClosingId"),
  };
  r.done();
  try {
    const [row] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "AgentRecovery" (id, "userId", "sourceClosingId", amount, reason, note, "createdById")
      VALUES (gen_random_uuid(), ${input.userId}::uuid, ${input.sourceClosingId}::uuid, ${formatCents(input.amount)}::numeric,
              ${input.reason}::"RecoveryReason", ${input.note}, ${actor.id}::uuid)
      RETURNING id::text`;
    return recoveryView(prisma, row!.id);
  } catch (err) {
    rethrow(err);
  }
}

export async function recordRepayment(prisma: PrismaClient, actor: Actor, id: string, body: unknown, today: string) {
  requireRole(actor, STAFF, "Recording a repayment from an agent");
  const r = new Reader(body, ["amount", "paidDate", "reference"]);
  const input = { amount: r.amount("amount"), paidDate: r.pastDate("paidDate", today), reference: r.text("reference", 200) };
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "AgentRecoveryRepayment" (id, "recoveryId", amount, "paidDate", reference, "actorId")
      VALUES (gen_random_uuid(), ${id}::uuid, ${formatCents(input.amount)}::numeric, ${input.paidDate}::date, ${input.reference}, ${actor.id}::uuid)`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23503") throw new NotFoundError("Agent recovery", id);
    rethrow(err);
  }
  return recoveryView(prisma, id);
}

export async function commissionRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; today?: () => string }) {
  const actorOf = async (req: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(req));
  const today = () => opts.today?.() ?? todayInToronto();
  type P = { Params: Record<string, string> };
  const id = (req: { params: Record<string, string> }, k = "id") => validatePathUuid(req.params[k]!, k);
  app.get<P>("/api/agents/:userId/commission-plans", async (req) => listPlans(opts.prisma, await actorOf(req), id(req, "userId"), today()));
  app.post<P>("/api/agents/:userId/commission-plans", async (req, reply) =>
    reply.code(201).send(await proposePlan(opts.prisma, await actorOf(req), id(req, "userId"), req.body, today())));
  app.post<P>("/api/commission-plans/:id/approve", async (req) => approvePlan(opts.prisma, await actorOf(req), id(req), req.body, today()));
  app.get<P>("/api/deals/:dealId/commission-adjustments", async (req) => listAdjustments(opts.prisma, await actorOf(req), id(req, "dealId")));
  app.post<P>("/api/deals/:dealId/commission-adjustments", async (req, reply) =>
    reply.code(201).send(await addAdjustment(opts.prisma, await actorOf(req), id(req, "dealId"), req.body)));
  app.post<P>("/api/commission-adjustments/:id/approve", async (req) => decideAdjustment(opts.prisma, await actorOf(req), id(req), "approve"));
  app.post<P>("/api/commission-adjustments/:id/withdraw", async (req) => decideAdjustment(opts.prisma, await actorOf(req), id(req), "withdraw"));
  app.post("/api/agent-recoveries", async (req, reply) => reply.code(201).send(await openRecovery(opts.prisma, await actorOf(req), req.body)));
  app.get<P>("/api/agent-recoveries/:id", async (req) => {
    requireRole(await actorOf(req), TRUST_VIEWERS, "Viewing an agent recovery");
    return recoveryView(opts.prisma, id(req));
  });
  app.post<P>("/api/agent-recoveries/:id/repayments", async (req, reply) =>
    reply.code(201).send(await recordRepayment(opts.prisma, await actorOf(req), id(req), req.body, today())));
}
