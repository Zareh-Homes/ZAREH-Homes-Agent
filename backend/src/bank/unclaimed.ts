/**
 * Unclaimed trust money (TRESA s.27(4); RECO Bulletin 8.1).
 *
 * Money held in trust for two years where the person entitled can't be found,
 * or entitlement is unclear, is paid to RECO. Before that, the brokerage must
 * make reasonable efforts to locate the person, throughout the two years.
 *
 * The register records the money, every attempt to reach the owner, interest,
 * changes in entitlement and the outcome. It escalates at 18, 21 and 23
 * months and assembles the remittance package. It never pays anything:
 * recording a remittance needs the UNCLAIMED_MONEY_REMITTANCE policy and a
 * reference to a payment made outside the system.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, TRUST_VIEWERS, type Actor, type ResolveUserId } from "../auth.ts";
import { ConflictError, DomainError, fromDatabaseError, NotFoundError, RuleViolationError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { formatCents, numericToCents, type Cents } from "../lib/money.ts";
import { Reader } from "../lib/reader.ts";
import { validatePathUuid } from "../trust/validation.ts";
import { BANK_STAFF } from "./service.ts";

/** RECO Bulletin 8.1: under $25 the brokerage may, but needn't, remit */
export const REMITTANCE_MINIMUM_CENTS = 2_500;
const ESCALATION_MONTHS = [18, 21, 23] as const;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const cents = (d: { toFixed(n: number): string }) => numericToCents(d.toFixed(2));

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d!, last));
  return target.toISOString().slice(0, 10);
}

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  const code = (err as { meta?: { code?: string } })?.meta?.code;
  if (code === "23505") throw new ConflictError("ALREADY_REGISTERED", "This deal's trust money is already on the unclaimed register");
  throw fromDatabaseError(err) ?? err;
}

async function trustBalance(db: PrismaClient, dealId: string, accountId: string): Promise<Cents> {
  const [{ balance }] = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(amount * direction), 0)::text AS balance FROM "TrustLedgerEntry"
     WHERE "transactionId" = ${dealId}::uuid AND "trustAccountId" = ${accountId}::uuid`;
  return numericToCents(balance);
}

export async function openUnclaimed(prisma: PrismaClient, actor: Actor, body: unknown, today: string) {
  requireRole(actor, BANK_STAFF, "Opening an unclaimed trust money record");
  const r = new Reader(body, ["dealId", "trustAccountId", "heldSince", "entitledSince", "entitlement", "entitledParty", "reason"]);
  const input = {
    dealId: r.uuid("dealId"),
    trustAccountId: r.uuid("trustAccountId"),
    heldSince: r.pastDate("heldSince", today),
    entitledSince: r.has("entitledSince") ? r.pastDate("entitledSince", today) : null,
    entitlement: r.oneOf("entitlement", ["ENTITLED_PARTY_NOT_LOCATED", "ENTITLEMENT_UNCLEAR", "DISPUTED"] as const),
    entitledParty: r.optionalText("entitledParty", 300),
    reason: r.text("reason", 2000),
  };
  r.check(input.entitlement !== "ENTITLED_PARTY_NOT_LOCATED" || input.entitledParty !== null, "entitledParty", "name the person who can't be located");
  r.done();
  // The amount is the ledger's, never typed in
  const amount = await trustBalance(prisma, input.dealId, input.trustAccountId);
  if (amount <= 0) throw new RuleViolationError("NO_TRUST_BALANCE", "This deal holds no money in that trust account");
  const id = randomUUID();
  try {
    await prisma.$executeRaw`
      INSERT INTO "UnclaimedTrustFund" (id, "transactionId", "trustAccountId", amount, "heldSince", "entitledSince", entitlement,
                                        "entitledParty", reason, "openedById")
      VALUES (${id}::uuid, ${input.dealId}::uuid, ${input.trustAccountId}::uuid, ${formatCents(amount)}::numeric, ${input.heldSince}::date,
              ${input.entitledSince}::date, ${input.entitlement}::"UnclaimedEntitlement", ${input.entitledParty}, ${input.reason}, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return unclaimedView(prisma, id, today);
}

export async function addUnclaimedEvent(prisma: PrismaClient, actor: Actor, fundId: string, body: unknown, today: string) {
  requireRole(actor, BANK_STAFF, "Updating an unclaimed trust money record");
  const r = new Reader(body, ["kind", "eventDate", "method", "outcome", "entitlement", "amount", "reference", "note", "documentFileId"]);
  const input = {
    kind: r.oneOf("kind", ["CONTACT_ATTEMPT", "NOTE", "INTEREST_ACCRUED", "ENTITLEMENT_CHANGED", "PARTY_LOCATED", "RESOLVED_PAID_OUT",
      "REMITTED_TO_RECO", "CLOSED"] as const),
    eventDate: r.has("eventDate") ? r.pastDate("eventDate", today) : today,
    method: r.optionalText("method", 100),
    outcome: r.optionalText("outcome", 1000),
    entitlement: r.has("entitlement") ? r.oneOf("entitlement", ["ENTITLED_PARTY_NOT_LOCATED", "ENTITLEMENT_UNCLEAR", "DISPUTED"] as const) : null,
    amount: r.has("amount") ? r.amount("amount") : null,
    reference: r.optionalText("reference", 300),
    note: r.text("note", 4000),
    documentFileId: r.optionalUuid("documentFileId"),
  };
  r.check(input.kind !== "CONTACT_ATTEMPT" || (input.method !== null && input.outcome !== null), "method", "method and outcome are required for a contact attempt");
  r.check(input.kind !== "ENTITLEMENT_CHANGED" || input.entitlement !== null, "entitlement", "is required");
  r.check(!["INTEREST_ACCRUED", "REMITTED_TO_RECO"].includes(input.kind) || input.amount !== null, "amount", "is required");
  r.check(!["REMITTED_TO_RECO", "RESOLVED_PAID_OUT"].includes(input.kind) || input.reference !== null, "reference", "is required as evidence");
  r.done();
  if (input.kind === "REMITTED_TO_RECO") {
    const v = await unclaimedView(prisma, fundId, today);
    if (input.amount !== numericToCents(v.amountDue)) {
      throw new RuleViolationError("REMITTANCE_AMOUNT", `RECO is owed principal plus interest: $${v.amountDue}`);
    }
  }
  try {
    await prisma.$executeRaw`
      INSERT INTO "UnclaimedFundEvent" (id, "fundId", kind, "eventDate", method, outcome, entitlement, amount, reference, note, "documentFileId", "actorId")
      VALUES (gen_random_uuid(), ${fundId}::uuid, ${input.kind}::"UnclaimedEventKind", ${input.eventDate}::date, ${input.method}, ${input.outcome},
              ${input.entitlement}::"UnclaimedEntitlement", ${input.amount === null ? null : formatCents(input.amount)}::numeric,
              ${input.reference}, ${input.note}, ${input.documentFileId}::uuid, ${actor.id}::uuid)`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23503") throw new NotFoundError("Unclaimed trust money record", fundId);
    rethrow(err);
  }
  return unclaimedView(prisma, fundId, today);
}

export interface UnclaimedView {
  id: string;
  dealId: string;
  dealNumber: string;
  trustAccountId: string;
  entitlement: string;
  entitledParty: string | null;
  heldSince: string;
  clockStarts: string;
  remitDue: string;
  monthsHeld: number;
  /** Escalations reached: 18, 21 and 23 months */
  escalation: 0 | 18 | 21 | 23 | 24;
  principal: string;
  interest: string;
  amountDue: string;
  currentTrustBalance: string;
  belowRemittanceMinimum: boolean;
  contactAttempts: number;
  lastContactAttempt: string | null;
  status: "OPEN" | "PARTY_LOCATED" | "PAID_OUT" | "REMITTED" | "CLOSED";
  outstanding: string[];
  events: { kind: string; eventDate: string; method: string | null; outcome: string | null; amount: string | null; reference: string | null; note: string; by: string }[];
}

const monthsBetween = (from: string, to: string) => {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return (ty! - fy!) * 12 + (tm! - fm!) - (td! < fd! ? 1 : 0);
};

export async function unclaimedView(prisma: PrismaClient, id: string, today: string): Promise<UnclaimedView> {
  const f = await prisma.unclaimedTrustFund.findUnique({
    where: { id },
    include: {
      transaction: { select: { dealNumber: true } },
      events: { orderBy: { createdAt: "asc" }, include: { actor: { select: { firstName: true, lastName: true } } } },
    },
  });
  if (!f) throw new NotFoundError("Unclaimed trust money record", id);
  const has = (k: string) => f.events.some((e) => e.kind === k);
  const clockStarts = iso(f.entitledSince ?? f.heldSince);
  const remitDue = addMonths(clockStarts, 24);
  const months = monthsBetween(clockStarts, today);
  const escalation = months >= 24 ? 24 : ([...ESCALATION_MONTHS].reverse().find((m) => months >= m) ?? 0);
  const principal = cents(f.amount);
  const interest = f.events.filter((e) => e.kind === "INTEREST_ACCRUED").reduce((s, e) => s + cents(e.amount!), 0);
  const contacts = f.events.filter((e) => e.kind === "CONTACT_ATTEMPT");
  const latestEntitlement = [...f.events].reverse().find((e) => e.kind === "ENTITLEMENT_CHANGED")?.entitlement ?? f.entitlement;
  const status = has("CLOSED") ? "CLOSED" : has("REMITTED_TO_RECO") ? "REMITTED" : has("RESOLVED_PAID_OUT") ? "PAID_OUT"
    : has("PARTY_LOCATED") ? "PARTY_LOCATED" : "OPEN";
  const outstanding: string[] = [];
  if (status === "OPEN") {
    const lastContact = contacts.at(-1) ? iso(contacts.at(-1)!.eventDate) : null;
    if (!lastContact || monthsBetween(lastContact, today) >= 3) {
      outstanding.push("Make and record another attempt to locate the person entitled (RECO expects efforts throughout the two years)");
    }
    if (escalation >= 18) outstanding.push(`Held ${months} months: broker of record to review; RECO remittance is due ${remitDue}`);
    if (escalation === 24) {
      outstanding.push(principal + interest < REMITTANCE_MINIMUM_CENTS
        ? "Two years have passed. Under $25: remitting is optional; record the decision"
        : "Two years have passed: prepare the remittance package and pay RECO (outside this system), then record it");
    }
  } else if (status === "PARTY_LOCATED") {
    outstanding.push("Pay the person entitled through the trust disbursement process, then record it here with the reference");
  } else if (status !== "CLOSED") {
    outstanding.push("Close the record");
  }
  return {
    id: f.id, dealId: f.transactionId, dealNumber: f.transaction.dealNumber, trustAccountId: f.trustAccountId,
    entitlement: latestEntitlement, entitledParty: f.entitledParty, heldSince: iso(f.heldSince), clockStarts, remitDue,
    monthsHeld: months, escalation: escalation as UnclaimedView["escalation"],
    principal: formatCents(principal), interest: formatCents(interest), amountDue: formatCents(principal + interest),
    currentTrustBalance: formatCents(await trustBalance(prisma, f.transactionId, f.trustAccountId)),
    belowRemittanceMinimum: principal + interest < REMITTANCE_MINIMUM_CENTS,
    contactAttempts: contacts.length, lastContactAttempt: contacts.at(-1) ? iso(contacts.at(-1)!.eventDate) : null,
    status, outstanding,
    events: f.events.map((e) => ({
      kind: e.kind, eventDate: iso(e.eventDate), method: e.method, outcome: e.outcome, amount: e.amount?.toFixed(2) ?? null,
      reference: e.reference, note: e.note, by: `${e.actor.firstName} ${e.actor.lastName}`,
    })),
  };
}

export async function listUnclaimed(prisma: PrismaClient, actor: Actor, today: string) {
  requireRole(actor, TRUST_VIEWERS, "Viewing unclaimed trust money");
  const ids = await prisma.unclaimedTrustFund.findMany({ select: { id: true }, orderBy: { heldSince: "asc" } });
  const records = await Promise.all(ids.map((r) => unclaimedView(prisma, r.id, today)));
  const open = records.filter((r) => r.status !== "CLOSED");
  return {
    asOf: today,
    records,
    totals: {
      open: open.length,
      held: formatCents(open.reduce((s, r) => s + numericToCents(r.amountDue), 0)),
      dueToReco: open.filter((r) => r.escalation === 24 && !r.belowRemittanceMinimum).length,
    },
  };
}

/**
 * Trust balances that may be unclaimed and aren't registered yet: deals that
 * collapsed or were cancelled, or closed more than 90 days ago, still holding
 * money. A person decides; nothing is registered automatically.
 */
export async function unclaimedCandidates(prisma: PrismaClient, actor: Actor, today: string) {
  requireRole(actor, TRUST_VIEWERS, "Viewing unclaimed trust money candidates");
  const rows = await prisma.$queryRaw<{ dealId: string; dealNumber: string; status: string; trustAccountId: string; balance: string; lastActivity: string }[]>`
    SELECT t.id::text AS "dealId", t."dealNumber", t.status::text AS status, e."trustAccountId"::text AS "trustAccountId",
           SUM(e.amount * e.direction)::text AS balance, to_char(MAX(e."effectiveDate"), 'YYYY-MM-DD') AS "lastActivity"
      FROM "TrustLedgerEntry" e JOIN "Transaction" t ON t.id = e."transactionId"
     WHERE NOT EXISTS (SELECT 1 FROM "UnclaimedTrustFund" u WHERE u."transactionId" = t.id AND u."trustAccountId" = e."trustAccountId")
       AND (t.status IN ('COLLAPSED', 'CANCELLED') OR (t.status = 'CLOSED' AND t."closeDate" < ${today}::date - 90))
     GROUP BY t.id, t."dealNumber", t.status, e."trustAccountId"
    HAVING SUM(e.amount * e.direction) > 0
     ORDER BY MAX(e."effectiveDate")`;
  return rows;
}

/** What RECO's Bulletin 8.1 asks for with a remittance, and what's on file. */
export async function remittancePackage(prisma: PrismaClient, actor: Actor, fundId: string, today: string) {
  requireRole(actor, TRUST_VIEWERS, "Viewing an unclaimed money remittance package");
  const v = await unclaimedView(prisma, fundId, today);
  const aps = await prisma.documentSlot.findFirst({
    where: { transactionId: v.dealId, documentType: { code: "APS" }, status: "APPROVED" }, select: { id: true },
  });
  const tradeRecord = (await prisma.tradeRecordSheet.count({ where: { transactionId: v.dealId, brokerSignedAt: { not: null } } })) > 0;
  const ledger = await prisma.trustLedgerEntry.findMany({
    where: { transactionId: v.dealId, trustAccountId: v.trustAccountId }, orderBy: { createdAt: "asc" },
    select: { id: true, entryType: true, amount: true, direction: true, effectiveDate: true, receiptNumber: true, counterparty: true },
  });
  const contacts = v.events.filter((e) => e.kind === "CONTACT_ATTEMPT");
  const items = [
    { item: "Payment of principal plus interest", ready: v.status === "OPEN" && v.escalation === 24, detail: `$${v.amountDue}` },
    { item: "Agreement of purchase and sale", ready: aps !== null, detail: aps ? "Approved copy on the deal" : "No approved APS on the deal" },
    { item: "Trade record sheet", ready: tradeRecord, detail: tradeRecord ? "Signed by the broker of record" : "No signed trade record sheet on file" },
    { item: "Trust account records for the money", ready: ledger.length > 0, detail: `${ledger.length} ledger entries` },
    {
      item: "Proof of attempts to contact the person entitled, or why entitlement is unclear",
      ready: contacts.length > 0 || v.entitlement !== "ENTITLED_PARTY_NOT_LOCATED",
      detail: `${contacts.length} contact attempts recorded`,
    },
  ];
  return {
    record: v,
    items,
    ready: items.every((i) => i.ready),
    ledger: ledger.map((e) => ({
      id: e.id, entryType: e.entryType, signed: formatCents(cents(e.amount) * e.direction), effectiveDate: iso(e.effectiveDate),
      receiptNumber: e.receiptNumber, counterparty: e.counterparty,
    })),
    contactAttempts: contacts,
    note: "This package is assembled for review. Payment to RECO is made outside this system by the broker of record.",
  };
}

/** For the annual filing: unclaimed money held at a date. */
export async function unclaimedAsOf(prisma: PrismaClient, asOf: string) {
  const rows = await prisma.$queryRaw<{ n: number; total: string }[]>`
    SELECT COUNT(*)::int AS n, COALESCE(SUM(u.amount), 0)::text AS total FROM "UnclaimedTrustFund" u
     WHERE u."heldSince" <= ${asOf}::date
       AND NOT EXISTS (SELECT 1 FROM "UnclaimedFundEvent" e WHERE e."fundId" = u.id
                        AND e.kind IN ('REMITTED_TO_RECO', 'RESOLVED_PAID_OUT') AND e."eventDate" <= ${asOf}::date)`;
  return { records: rows[0]!.n, principal: rows[0]!.total };
}

export async function unclaimedRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; today?: () => string }) {
  const actorOf = async (request: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(request));
  const today = () => opts.today?.() ?? todayInToronto();
  app.get("/api/trust/unclaimed", async (req) => listUnclaimed(opts.prisma, await actorOf(req), today()));
  app.get("/api/trust/unclaimed/candidates", async (req) => ({ candidates: await unclaimedCandidates(opts.prisma, await actorOf(req), today()) }));
  app.post("/api/trust/unclaimed", async (req, reply) => reply.code(201).send(await openUnclaimed(opts.prisma, await actorOf(req), req.body, today())));
  app.get<{ Params: Record<string, string> }>("/api/trust/unclaimed/:id", async (req) => {
    requireRole(await actorOf(req), TRUST_VIEWERS, "Viewing unclaimed trust money");
    return unclaimedView(opts.prisma, validatePathUuid(req.params.id, "id"), today());
  });
  app.post<{ Params: Record<string, string> }>("/api/trust/unclaimed/:id/events", async (req, reply) =>
    reply.code(201).send(await addUnclaimedEvent(opts.prisma, await actorOf(req), validatePathUuid(req.params.id, "id"), req.body, today())));
  app.get<{ Params: Record<string, string> }>("/api/trust/unclaimed/:id/package", async (req) =>
    remittancePackage(opts.prisma, await actorOf(req), validatePathUuid(req.params.id, "id"), today()));
}
