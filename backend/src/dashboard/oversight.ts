/**
 * Oversight dashboards: broker of record, accounting, agent. Every number
 * carries what it means, where it comes from and when it was true, so nobody
 * has to guess what a figure includes.
 *
 *   GET /api/dashboard/oversight?view=broker|accounting|agent
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, type Actor, type ResolveUserId } from "../auth.ts";
import { reconciliationStatus } from "../bank/service.ts";
import { fundsAvailability } from "../accounting/funds.ts";
import { evaluateDeal } from "../obligations/service.ts";
import { filingPackage } from "../reco/filing.ts";
import { todayInToronto } from "../lib/dates.ts";
import { formatCents, numericToCents } from "../lib/money.ts";
import { RuleViolationError } from "../errors.ts";

export interface Metric {
  key: string;
  label: string;
  value: string | number | null;
  unit: "CAD" | "count" | "date" | "days" | "text";
  definition: string;
  source: string;
  asOf: string;
  status: "ok" | "attention" | "critical";
  items?: string[];
}

export interface OversightView {
  view: "broker" | "accounting" | "agent";
  asOf: string;
  sections: { title: string; metrics: Metric[] }[];
}

const OPEN = ["CONDITIONAL", "FIRM"] as const;

async function trustSection(prisma: PrismaClient, today: string, now: string): Promise<{ title: string; metrics: Metric[] }> {
  const [t] = await prisma.$queryRaw<{ total: string; uncleared: string }[]>`
    SELECT COALESCE(SUM(e.amount * e.direction), 0)::text AS total,
           COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 1 AND NOT trust_entry_cleared(e.id)), 0)::text AS uncleared
      FROM "TrustLedgerEntry" e JOIN "TrustAccount" a ON a.id = e."trustAccountId" WHERE a.kind = 'REAL_ESTATE_TRUST'`;
  const status = await reconciliationStatus(prisma, today);
  const overdue = status.flatMap((a) => [...a.awaitingSignature.filter((x) => x.overdue).map((x) => `${a.name}: ${x.periodEnd} due ${x.dueBy}`),
    ...a.missingStatements.filter((x) => x.overdue).map((x) => `${a.name}: no statement for ${x.month} (due ${x.dueBy})`)]);
  const shortfalls = status.flatMap((a) => a.openIncidents.filter((i) => i.kind === "SHORTFALL").map((i) => `${a.name}: $${i.amount} since ${i.detectedAt.slice(0, 10)}`));
  return {
    title: "Trust",
    metrics: [
      { key: "trust.total", label: "Held in real estate trust", value: t!.total, unit: "CAD", status: "ok", asOf: now,
        definition: "Sum of every deal's trust ledger balance in real estate trust accounts (what the brokerage owes its clients)",
        source: "Trust ledger (append-only)" },
      { key: "trust.uncleared", label: "Deposits not yet verified at the bank", value: t!.uncleared, unit: "CAD", asOf: now,
        status: numericToCents(t!.uncleared) > 0 ? "attention" : "ok",
        definition: "Deposits recorded in the trust ledger that aren't matched to a bank line verified by a second person; nothing can be paid out against them",
        source: "Trust ledger and bank matches" },
      { key: "trust.reconciliationsOverdue", label: "Reconciliations overdue", value: overdue.length, unit: "count", asOf: now, items: overdue,
        status: overdue.length ? "critical" : "ok",
        definition: "Months past the earlier of s.13 (30 days after the statement is received) and RECO's 30 days after month end, not yet signed by the broker of record",
        source: "Bank statements and trust reconciliations" },
      { key: "trust.openShortfalls", label: "Open trust shortfalls", value: shortfalls.length, unit: "count", asOf: now, items: shortfalls,
        status: shortfalls.length ? "critical" : "ok",
        definition: "Shortfall incidents (O. Reg. 579/05 s.14) not yet resolved: report to RECO and replenish immediately unless solely bank service fees",
        source: "Trust incidents" },
    ],
  };
}

async function complianceSection(prisma: PrismaClient, today: string, now: string, agentId?: string) {
  const deals = await prisma.transaction.findMany({
    where: { status: { in: [...OPEN] }, ...(agentId ? { agents: { some: { userId: agentId } } } : {}) },
    select: { id: true, dealNumber: true, streetAddress: true },
  });
  const blocked: string[] = [];
  const breaches: string[] = [];
  for (const d of deals) {
    const r = await evaluateDeal(prisma, d.id, today);
    const all = [...r.tresa, ...r.fintrac];
    const b = all.filter((f) => f.severity === "BLOCKING").length;
    if (b) blocked.push(`${d.dealNumber} · ${d.streetAddress}: ${b} item(s), e.g. ${all.find((f) => f.severity === "BLOCKING")!.message}`);
    for (const f of all.filter((x) => x.severity === "BREACH")) breaches.push(`${d.dealNumber}: ${f.message}`);
  }
  const reports = await prisma.fintracReport.findMany({ where: { events: { none: {} } }, select: { kind: true, dueAt: true, summary: true } });
  return {
    title: "Compliance",
    metrics: [
      { key: "compliance.dealsWithOutstanding", label: "Open deals with outstanding TRESA / FINTRAC items", value: blocked.length, unit: "count" as const,
        asOf: now, items: blocked.slice(0, 25), status: (blocked.length ? "attention" : "ok") as Metric["status"],
        definition: "Conditional and firm deals with at least one BLOCKING finding; the broker of record can't sign their trade record sheets until cleared",
        source: "TRESA and FINTRAC rules (backend/src/obligations) evaluated now" },
      { key: "compliance.breaches", label: "Steps recorded too late", value: breaches.length, unit: "count" as const, asOf: now, items: breaches.slice(0, 25),
        status: (breaches.length ? "critical" : "ok") as Metric["status"],
        definition: "Findings that can't be fixed (a disclosure or verification done after its deadline): for the broker of record's review",
        source: "TRESA and FINTRAC rules evaluated now" },
      ...(agentId ? [] : [{ key: "fintrac.reportsOpen", label: "FINTRAC reports to file", value: reports.length, unit: "count" as const, asOf: now,
        items: reports.map((r) => `${r.kind}: due ${r.dueAt.toISOString().slice(0, 16).replace("T", " ")} UTC · ${r.summary}`),
        status: (reports.some((r) => r.dueAt < new Date()) ? "critical" : reports.length ? "attention" : "ok") as Metric["status"],
        definition: "Large cash / virtual currency (15 days), suspicious transaction (as soon as practicable) and listed-property (immediately) reports not yet recorded as filed",
        source: "FINTRAC report tasks" }]),
    ],
  };
}

async function brokerView(prisma: PrismaClient, today: string, now: string): Promise<OversightView> {
  const year = await prisma.recoFilingYear.findFirst({ where: { submission: null }, orderBy: { fiscalYearEnd: "asc" } });
  let reco: Metric;
  if (!year) {
    reco = { key: "reco.filing", label: "RECO annual filing", value: "Not set up", unit: "text", asOf: now, status: today <= "2026-10-30" ? "critical" : "attention",
      definition: "Set up the fiscal year to prepare the filing. Fiscal years ending 2025-08-01 to 2026-07-31 are due 2026-10-30; later years 90 days after year end",
      source: "RECO filing years" };
  } else {
    const end = year.fiscalYearEnd.toISOString().slice(0, 10);
    const p = await filingPackage(prisma, end, today);
    reco = { key: "reco.filing", label: `RECO annual filing (year ending ${end})`, value: p.dueDate, unit: "date", asOf: now, items: p.missing.slice(0, 25),
      status: p.daysToDue <= 14 ? "critical" : p.missing.length ? "attention" : "ok",
      definition: `Due ${p.dueDate} (${p.daysToDue} days). Filed by the broker of record in MyWeb; ${p.missing.length} item(s) still missing from the package`,
      source: "RECO filing package" };
  }
  const [awaiting] = await prisma.$queryRaw<{ n: number; trs: number }[]>`
    SELECT (SELECT COUNT(*) FROM "PayoutEvent" e WHERE e.kind = 'APPROVED' AND e.seq = (SELECT MAX(seq) FROM "PayoutEvent" x
             WHERE x."payoutId" IS NOT DISTINCT FROM e."payoutId" AND x."payableId" IS NOT DISTINCT FROM e."payableId"))::int AS n,
           (SELECT COUNT(*) FROM "TradeRecordSheet" WHERE "agentSignedAt" IS NOT NULL AND "brokerSignedAt" IS NULL)::int AS trs`;
  const [unclaimed] = await prisma.$queryRaw<{ n: number; due: number }[]>`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE COALESCE("entitledSince", "heldSince") <= ${today}::date - interval '2 years')::int AS due
      FROM "UnclaimedTrustFund" u WHERE NOT EXISTS (SELECT 1 FROM "UnclaimedFundEvent" e WHERE e."fundId" = u.id AND e.kind = 'CLOSED')`;
  return {
    view: "broker", asOf: now,
    sections: [
      await trustSection(prisma, today, now),
      await complianceSection(prisma, today, now),
      { title: "Broker of record", metrics: [
        reco,
        { key: "trs.awaitingBroker", label: "Trade record sheets to sign", value: awaiting!.trs, unit: "count", asOf: now, status: awaiting!.trs ? "attention" : "ok",
          definition: "Signed by the agent, awaiting the broker of record's review and signature (O. Reg. 579/05 s.17(5))", source: "Trade record sheets" },
        { key: "payouts.approvedNotSent", label: "Payouts approved, not yet sent", value: awaiting!.n, unit: "count", asOf: now, status: awaiting!.n ? "attention" : "ok",
          definition: "Approved by a managing broker; someone other than the approver records the payment", source: "Payout events" },
        { key: "unclaimed.open", label: "Unclaimed trust money records", value: unclaimed!.n, unit: "count", asOf: now,
          status: unclaimed!.due ? "critical" : unclaimed!.n ? "attention" : "ok",
          definition: `Open records on the unclaimed money register; ${unclaimed!.due} held two years or more (TRESA s.27(4): remit to RECO)`, source: "Unclaimed trust money register" },
      ] },
    ],
  };
}

async function accountingView(prisma: PrismaClient, today: string, now: string): Promise<OversightView> {
  const operating = await prisma.operatingAccount.findMany({ where: { isActive: true } });
  const cta = await prisma.trustAccount.findMany({ where: { isActive: true, kind: "COMMISSION_TRUST" } });
  const funds: Metric[] = [];
  for (const a of [...operating.map((x) => ({ type: "OPERATING" as const, id: x.id, name: x.name })), ...cta.map((x) => ({ type: "COMMISSION_TRUST" as const, id: x.id, name: x.name }))]) {
    const f = await fundsAvailability(prisma, { type: a.type, id: a.id }, today);
    funds.push({ key: `funds.${a.id}`, label: `Available: ${a.name}`, value: f.available, unit: "CAD", asOf: f.asOf ?? now, items: f.blockedBecause,
      status: f.blockedBecause.length ? "critical" : "ok", definition: f.definition,
      source: `Verified bank balance (${f.asOf ?? "none"}), payout events, obligations figure${f.obligations ? ` (${f.obligations.asOf}, ${f.obligations.source})` : " (none current)"}` });
  }
  const [p] = await prisma.$queryRaw<{ unconfirmed: number; unconfirmedTotal: string; unverified: number; unverifiedTotal: string; recoveries: string }[]>`
    SELECT (SELECT COUNT(*) FROM "PayoutEvent" e WHERE e.kind = 'PAID' AND NOT payout_event_confirmed(e.id))::int AS unconfirmed,
           (SELECT COALESCE(SUM(amount), 0) FROM "PayoutEvent" e WHERE e.kind = 'PAID' AND NOT payout_event_confirmed(e.id))::text AS "unconfirmedTotal",
           (SELECT COUNT(*) FROM "CommissionReceipt" r WHERE NOT receipt_cleared(r.id)
              AND NOT EXISTS (SELECT 1 FROM "CommissionReceiptReversal" x WHERE x."receiptId" = r.id))::int AS unverified,
           (SELECT COALESCE(SUM(amount), 0) FROM "CommissionReceipt" r WHERE NOT receipt_cleared(r.id)
              AND NOT EXISTS (SELECT 1 FROM "CommissionReceiptReversal" x WHERE x."receiptId" = r.id))::text AS "unverifiedTotal",
           (SELECT COALESCE(SUM(recovery_outstanding(id)), 0) FROM "AgentRecovery")::text AS recoveries`;
  return {
    view: "accounting", asOf: now,
    sections: [
      { title: "Funds", metrics: funds },
      { title: "Money in and out", metrics: [
        { key: "receipts.unverified", label: "Commission received, not verified at the bank", value: formatCents(numericToCents(p!.unverifiedTotal)), unit: "CAD", asOf: now,
          status: p!.unverified ? "attention" : "ok", definition: `${p!.unverified} receipt(s) not matched to a bank line verified by a second person; no payout can be approved against them`,
          source: "Commission receipts and bank matches" },
        { key: "payments.unconfirmed", label: "Payments sent, not confirmed at the bank", value: formatCents(numericToCents(p!.unconfirmedTotal)), unit: "CAD", asOf: now,
          status: p!.unconfirmed ? "attention" : "ok", definition: `${p!.unconfirmed} payment(s) recorded as sent with no bank line verified by someone other than whoever recorded them`,
          source: "Payout events and bank matches" },
        { key: "recoveries.outstanding", label: "Owed back by agents", value: formatCents(numericToCents(p!.recoveries)), unit: "CAD", asOf: now,
          status: numericToCents(p!.recoveries) > 0 ? "attention" : "ok", definition: "Agent recoveries less repayments and deductions on issued CDAs", source: "Agent recoveries" },
      ] },
      await trustSection(prisma, today, now),
    ],
  };
}

async function agentView(prisma: PrismaClient, actor: Actor, today: string, now: string): Promise<OversightView> {
  const soon = new Date(Date.parse(now) + 3 * 86_400_000);
  const conditions = await prisma.dealCondition.findMany({
    where: { transaction: { status: "CONDITIONAL", agents: { some: { userId: actor.id } } }, dueAt: { lte: soon } },
    include: { events: { orderBy: { createdAt: "desc" }, take: 1 }, transaction: { select: { dealNumber: true } } },
  });
  const due = conditions.filter((c) => !c.events[0] || c.events[0].outcome === "EXTENDED")
    .map((c) => `${c.transaction.dealNumber}: ${c.description} by ${(c.events[0]?.newDueAt ?? c.dueAt).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  const trs = await prisma.tradeRecordSheet.findMany({
    where: { agentSignedAt: null, transaction: { status: { in: ["FIRM", "CLOSED"] }, agents: { some: { userId: actor.id } } } },
    select: { transaction: { select: { dealNumber: true } } },
  });
  return {
    view: "agent", asOf: now,
    sections: [
      await complianceSection(prisma, today, now, actor.id),
      { title: "My deals", metrics: [
        { key: "conditions.dueSoon", label: "Conditions due in the next 3 days", value: due.length, unit: "count", asOf: now, items: due,
          status: due.length ? "attention" : "ok", definition: "Open or extended conditions on your conditional deals, by deadline", source: "Deal conditions" },
        { key: "trs.toSign", label: "Trade record sheets to sign", value: trs.length, unit: "count", asOf: now, items: trs.map((t) => t.transaction.dealNumber),
          status: trs.length ? "attention" : "ok", definition: "Firm or closed deals whose trade record sheet you haven't signed (s.17(3))", source: "Trade record sheets" },
      ] },
    ],
  };
}

export async function oversight(prisma: PrismaClient, actor: Actor, view: string, today = todayInToronto(), now = new Date().toISOString()): Promise<OversightView> {
  if (view === "broker") {
    requireRole(actor, ["MANAGING_BROKER", "COMPLIANCE_ADMIN"], "Viewing the broker of record dashboard");
    return brokerView(prisma, today, now);
  }
  if (view === "accounting") {
    requireRole(actor, ["ADMIN", "MANAGING_BROKER"], "Viewing the accounting dashboard");
    return accountingView(prisma, today, now);
  }
  if (view === "agent") return agentView(prisma, actor, today, now);
  throw new RuleViolationError("UNKNOWN_VIEW", "view must be broker, accounting or agent");
}

export async function oversightRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; today?: () => string }) {
  const actorOf = async (req: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(req));
  app.get<{ Querystring: { view?: string } }>("/api/dashboard/oversight", async (req) =>
    oversight(opts.prisma, await actorOf(req), req.query.view ?? "agent", opts.today?.() ?? todayInToronto()));
}

