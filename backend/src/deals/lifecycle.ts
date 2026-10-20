/**
 * The deal after the offer: conditions and their deadlines, going firm,
 * amendments, termination and closing, plus the listing's offers register
 * (migration 015). The database enforces the status order and that a deal
 * can't go firm with a condition open; this module records each step with its
 * document and shows what's next.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import { loadActor, requireRole, type Actor, type ResolveUserId } from "../auth.ts";
import { ConflictError, DomainError, ForbiddenError, fromDatabaseError, NotFoundError, RuleViolationError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { formatCents, numericToCents } from "../lib/money.ts";
import { Reader } from "../lib/reader.ts";
import { validatePathUuid } from "../trust/validation.ts";
import { requireOfferDisclosures, requireRepresentationConsents, syncConsentSlot } from "../obligations/service.ts";

const STAFF = new Set(["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"]);
type Db = PrismaClient | Prisma.TransactionClient;
const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function assertDealAccess(db: Db, actor: Actor, dealId: string): Promise<void> {
  if (STAFF.has(actor.role)) return;
  const onDeal = await db.transactionAgent.findFirst({ where: { transactionId: dealId, userId: actor.id } });
  if (!onDeal) throw new ForbiddenError("You can only work on your own deals");
}

/**
 * Same-brokerage deals: the side an agent acts for when it's one side only (LISTING or BUYER). Null for staff,
 * an agent on both sides, or any other deal. A one-side agent sees and handles only their own client's records.
 */
export async function oneSideOnly(db: Db, actor: Actor, dealId: string): Promise<"LISTING" | "BUYER" | null> {
  if (STAFF.has(actor.role)) return null;
  const [row] = await db.$queryRaw<{ dealSide: string; agentSide: string | null }[]>`
    SELECT t.side::text AS "dealSide", a.side::text AS "agentSide" FROM "Transaction" t
      JOIN "TransactionAgent" a ON a."transactionId" = t.id AND a."userId" = ${actor.id}::uuid WHERE t.id = ${dealId}::uuid`;
  return row?.dealSide === "DUAL" && (row.agentSide === "LISTING" || row.agentSide === "BUYER") ? row.agentSide : null;
}

/** The seller's representative handles the listing's offers; a buyer-side agent only sees their own buyer's */
async function assertSellerSide(db: Db, actor: Actor, dealId: string) {
  if ((await oneSideOnly(db, actor, dealId)) === "BUYER") {
    throw new ForbiddenError("Offers on this listing are handled by the seller's representative; you act for the buyer");
  }
}

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  throw fromDatabaseError(err) ?? err;
}

function timestamp(r: Reader, field: string): string {
  const v = r.raw(field);
  if (typeof v !== "string" || Number.isNaN(Date.parse(v)) || !/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    r.fail(field, 'must be a date and time, e.g. "2026-10-20T23:59:00-04:00"');
    return "";
  }
  return new Date(v).toISOString();
}

export interface LifecycleView {
  dealId: string;
  status: string;
  side: string;
  conditions: {
    id: string; kind: string; description: string; forBenefitOf: string; dueAt: string; state: string; overdue: boolean;
    history: { outcome: string; eventAt: string; newDueAt: string | null; reference: string }[];
  }[];
  amendments: { field: string; oldValue: string | null; newValue: string; effectiveDate: string; reference: string }[];
  termination: { reason: string; terminatedOn: string; reference: string; note: string } | null;
  trustBalance: string;
  nextSteps: string[];
}

export async function lifecycleView(db: Db, dealId: string, now = new Date()): Promise<LifecycleView> {
  const deal = await db.transaction.findUnique({
    where: { id: dealId },
    include: {
      conditions: { orderBy: { dueAt: "asc" }, include: { events: { orderBy: { createdAt: "asc" } } } },
      amendments: { orderBy: { createdAt: "asc" } },
      termination: true,
    },
  });
  if (!deal) throw new NotFoundError("Deal", dealId);
  const [{ balance }] = await db.$queryRaw<{ balance: string }[]>`
    SELECT COALESCE(SUM(amount * direction), 0)::text AS balance FROM "TrustLedgerEntry" WHERE "transactionId" = ${dealId}::uuid`;
  const conditions = deal.conditions.map((c) => {
    const last = c.events.at(-1);
    const state = last?.outcome ?? "OPEN";
    const dueAt = last?.outcome === "EXTENDED" ? last.newDueAt! : c.dueAt;
    return {
      id: c.id, kind: c.kind, description: c.description, forBenefitOf: c.forBenefitOf, dueAt: dueAt.toISOString(), state,
      overdue: (state === "OPEN" || state === "EXTENDED") && dueAt < now,
      history: c.events.map((e) => ({ outcome: e.outcome, eventAt: e.eventAt.toISOString(), newDueAt: e.newDueAt?.toISOString() ?? null, reference: e.reference })),
    };
  });
  const open = conditions.filter((c) => c.state === "OPEN" || c.state === "EXTENDED");
  const nextSteps: string[] = [];
  const held = numericToCents(balance);
  if (deal.status === "CONDITIONAL") {
    for (const c of open) nextSteps.push(`${c.description}: fulfil, waive or extend by ${c.dueAt}${c.overdue ? " (deadline passed: record what happened)" : ""}`);
    if (conditions.some((c) => c.state === "FAILED")) nextSteps.push("A condition failed: record the termination (and the signed mutual release)");
    else if (open.length === 0) nextSteps.push("All conditions are resolved: mark the deal firm");
  } else if (deal.status === "FIRM") {
    nextSteps.push(`Close on ${iso(deal.closeDate)}, then mark the deal closed`);
  }
  // The trade record stays on the list until both the agent and the broker of record have signed it (s.17(3), (5))
  if (deal.status === "FIRM" || deal.status === "CLOSED") {
    const sheet = await db.tradeRecordSheet.findUnique({ where: { transactionId: dealId }, select: { agentSignedAt: true, brokerSignedAt: true } });
    if (!sheet) nextSteps.push("Trade record sheet: not prepared yet");
    else if (!sheet.agentSignedAt) nextSteps.push("Trade record sheet: waiting for the agent's review and signature, then the broker of record's");
    else if (!sheet.brokerSignedAt) nextSteps.push("Trade record sheet: signed by the agent, waiting for the broker of record's review and signature");
  } else if (deal.status === "COLLAPSED" && held > 0) {
    nextSteps.push(`$${formatCents(held)} is still in trust: release it only under a signed mutual release or a court order; ` +
      "if entitlement is disputed, put the funds on hold");
  }
  return {
    dealId, status: deal.status, side: deal.side, conditions,
    amendments: deal.amendments.map((a) => ({ field: a.field, oldValue: a.oldValue, newValue: a.newValue, effectiveDate: iso(a.effectiveDate), reference: a.reference })),
    termination: deal.termination
      ? { reason: deal.termination.reason, terminatedOn: iso(deal.termination.terminatedOn), reference: deal.termination.reference, note: deal.termination.note }
      : null,
    trustBalance: formatCents(held),
    nextSteps,
  };
}

export async function addCondition(prisma: PrismaClient, actor: Actor, dealId: string, body: unknown) {
  await assertDealAccess(prisma, actor, dealId);
  const r = new Reader(body, ["kind", "description", "forBenefitOf", "dueAt"]);
  const input = {
    kind: r.oneOf("kind", ["FINANCING", "INSPECTION", "STATUS_CERTIFICATE", "SALE_OF_BUYERS_PROPERTY", "LAWYER_REVIEW", "INSURANCE", "OTHER"] as const),
    description: r.text("description", 500),
    forBenefitOf: r.oneOf("forBenefitOf", ["BUYER", "SELLER", "BOTH", "LANDLORD", "TENANT"] as const),
    dueAt: timestamp(r, "dueAt"),
  };
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "DealCondition" (id, "transactionId", kind, description, "forBenefitOf", "dueAt", "createdById")
      VALUES (gen_random_uuid(), ${dealId}::uuid, ${input.kind}::"ConditionKind", ${input.description}, ${input.forBenefitOf},
              ${input.dueAt}::timestamptz, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return lifecycleView(prisma, dealId);
}

export async function recordConditionOutcome(prisma: PrismaClient, actor: Actor, conditionId: string, body: unknown) {
  const cond = await prisma.dealCondition.findUnique({ where: { id: conditionId }, select: { transactionId: true } });
  if (!cond) throw new NotFoundError("Condition", conditionId);
  await assertDealAccess(prisma, actor, cond.transactionId);
  const r = new Reader(body, ["outcome", "eventAt", "newDueAt", "reference", "documentFileId", "note"]);
  const input = {
    outcome: r.oneOf("outcome", ["FULFILLED", "WAIVED", "EXTENDED", "FAILED"] as const),
    eventAt: r.has("eventAt") ? timestamp(r, "eventAt") : new Date().toISOString(),
    newDueAt: r.has("newDueAt") ? timestamp(r, "newDueAt") : null,
    reference: r.text("reference", 300),
    documentFileId: r.optionalUuid("documentFileId"),
    note: r.optionalText("note", 2000),
  };
  r.check((input.outcome === "EXTENDED") === (input.newDueAt !== null), "newDueAt", "is required for an extension, and only then");
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "DealConditionEvent" (id, "conditionId", outcome, "eventAt", "newDueAt", reference, "documentFileId", note, "actorId")
      VALUES (gen_random_uuid(), ${conditionId}::uuid, ${input.outcome}::"ConditionOutcome", ${input.eventAt}::timestamptz,
              ${input.newDueAt}::timestamptz, ${input.reference}, ${input.documentFileId}::uuid, ${input.note}, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return lifecycleView(prisma, cond.transactionId);
}

async function setStatus(prisma: PrismaClient, dealId: string, status: "FIRM" | "CLOSED", closedOn: string | null = null) {
  try {
    const n = await prisma.$executeRaw`
      UPDATE "Transaction" SET status = ${status}::"DealStatus", "closeDate" = COALESCE(${closedOn}::date, "closeDate"), "updatedAt" = now()
       WHERE id = ${dealId}::uuid`;
    if (n === 0) throw new NotFoundError("Deal", dealId);
  } catch (err) {
    rethrow(err);
  }
}

export async function markFirm(prisma: PrismaClient, actor: Actor, dealId: string) {
  await assertDealAccess(prisma, actor, dealId);
  // No step for clients in a multiple representation until each has consented in writing (s.22)
  await requireRepresentationConsents(prisma, dealId, todayInToronto(), "Marking the deal firm");
  await setStatus(prisma, dealId, "FIRM");
  return lifecycleView(prisma, dealId);
}

export async function markClosed(prisma: PrismaClient, actor: Actor, dealId: string, body: unknown, today: string) {
  await assertDealAccess(prisma, actor, dealId);
  const r = new Reader(body ?? {}, ["closedOn"]);
  const closedOn = r.has("closedOn") ? r.pastDate("closedOn", today) : null;
  r.done();
  await setStatus(prisma, dealId, "CLOSED", closedOn);
  return lifecycleView(prisma, dealId);
}

const AMENDABLE = {
  SALE_PRICE: "salePrice", CLOSE_DATE: "closeDate", DEPOSIT_AMOUNT: "depositAmount", DEPOSIT_DUE_DATE: "depositDueDate",
  TOTAL_GCI: "totalGci", COOP_COMMISSION: "coopCommission", LISTING_SIDE_GCI: "listingSideGci", BUYER_SIDE_GCI: "buyerSideGci",
  BUYER_SIDE_SELLER_PAYS: "buyerSideSellerPays",
} as const;
/** Commission figures feed the CDA: only a managing broker or admin changes them after the deal is opened */
const COMMISSION_FIELDS = new Set(["TOTAL_GCI", "COOP_COMMISSION", "LISTING_SIDE_GCI", "BUYER_SIDE_GCI", "BUYER_SIDE_SELLER_PAYS"]);

/** Records the amendment and applies it to the deal, in one step. */
export async function amendDeal(prisma: PrismaClient, actor: Actor, dealId: string, body: unknown, today: string) {
  await assertDealAccess(prisma, actor, dealId);
  const r = new Reader(body, ["field", "newValue", "effectiveDate", "reference", "documentFileId", "description"]);
  const field = r.oneOf("field", ["SALE_PRICE", "CLOSE_DATE", "DEPOSIT_AMOUNT", "DEPOSIT_DUE_DATE", "TOTAL_GCI", "COOP_COMMISSION",
    "LISTING_SIDE_GCI", "BUYER_SIDE_GCI", "BUYER_SIDE_SELLER_PAYS", "OTHER"] as const);
  const isDate = field === "CLOSE_DATE" || field === "DEPOSIT_DUE_DATE";
  const isMoney = field === "SALE_PRICE" || field === "DEPOSIT_AMOUNT" || COMMISSION_FIELDS.has(field);
  if (COMMISSION_FIELDS.has(field)) requireRole(actor, ["MANAGING_BROKER", "ADMIN"], "Changing a deal's commission figures");
  const newValue = isDate ? r.date("newValue") : isMoney ? formatCents(r.amount("newValue")) : r.text("newValue", 2000);
  const input = {
    effectiveDate: r.has("effectiveDate") ? r.pastDate("effectiveDate", today) : today,
    reference: r.text("reference", 300), documentFileId: r.optionalUuid("documentFileId"),
  };
  r.done();
  const deal = await prisma.transaction.findUnique({ where: { id: dealId } });
  if (!deal) throw new NotFoundError("Deal", dealId);
  // Same-brokerage deals: each side is amended under its own agreement, and the deal's commission follows
  const sided = deal.listingSideGci !== null && deal.buyerSideGci !== null;
  if (sided && field === "TOTAL_GCI") throw new RuleViolationError("AMEND_A_SIDE", "This deal's commission is the two sides' total: amend the listing side or the buyer side");
  if (!sided && (field === "LISTING_SIDE_GCI" || field === "BUYER_SIDE_GCI" || field === "BUYER_SIDE_SELLER_PAYS")) {
    throw new RuleViolationError("NOT_SIDED", "Only deals where our brokerage acts for both sides have a commission per side");
  }
  const column = field === "OTHER" ? null : AMENDABLE[field];
  const current = column ? deal[column] : null;
  const oldValue = current === null ? null : current instanceof Date ? iso(current) : (current as { toFixed(n: number): string }).toFixed(2);
  if (oldValue === newValue) throw new RuleViolationError("NO_CHANGE", "That's already the value on the deal");
  const sellerPays = field === "BUYER_SIDE_SELLER_PAYS" ? newValue : deal.buyerSideSellerPays?.toFixed(2) ?? null;
  const buyerSide = field === "BUYER_SIDE_GCI" ? newValue : deal.buyerSideGci?.toFixed(2) ?? null;
  if (sellerPays !== null && buyerSide !== null && numericToCents(sellerPays) > numericToCents(buyerSide)) {
    throw new RuleViolationError("SELLER_PAYS_MORE_THAN_BUYER_SIDE", "The part of the buyer side the seller pays can't be more than the buyer side's commission");
  }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "DealAmendment" (id, "transactionId", field, "oldValue", "newValue", "effectiveDate", reference, "documentFileId", "actorId")
        VALUES (gen_random_uuid(), ${dealId}::uuid, ${field}, ${oldValue}, ${newValue}, ${input.effectiveDate}::date, ${input.reference},
                ${input.documentFileId}::uuid, ${actor.id}::uuid)`;
      if (column) {
        const other = field === "LISTING_SIDE_GCI" ? deal.buyerSideGci : field === "BUYER_SIDE_GCI" ? deal.listingSideGci : null;
        await tx.transaction.update({
          where: { id: dealId },
          data: {
            [column]: isDate ? new Date(`${newValue}T00:00:00Z`) : newValue,
            ...(other !== null ? { totalGci: formatCents(numericToCents(newValue) + numericToCents(other.toFixed(2))) } : {}),
          },
        });
      }
    });
  } catch (err) {
    rethrow(err);
  }
  return lifecycleView(prisma, dealId);
}

export async function terminateDeal(prisma: PrismaClient, actor: Actor, dealId: string, body: unknown, today: string) {
  await assertDealAccess(prisma, actor, dealId);
  const r = new Reader(body, ["reason", "terminatedOn", "reference", "documentFileId", "note"]);
  const input = {
    reason: r.oneOf("reason", ["CONDITION_NOT_MET", "MUTUAL_RELEASE", "BUYER_DEFAULT", "SELLER_DEFAULT", "OTHER"] as const),
    terminatedOn: r.has("terminatedOn") ? r.pastDate("terminatedOn", today) : today,
    reference: r.text("reference", 300), documentFileId: r.optionalUuid("documentFileId"), note: r.text("note", 2000),
  };
  r.done();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "DealTermination" ("transactionId", reason, "terminatedOn", reference, "documentFileId", note, "actorId")
        VALUES (${dealId}::uuid, ${input.reason}::"TerminationReason", ${input.terminatedOn}::date, ${input.reference},
                ${input.documentFileId}::uuid, ${input.note}, ${actor.id}::uuid)`;
      await tx.$executeRaw`UPDATE "Transaction" SET status = 'COLLAPSED', "updatedAt" = now() WHERE id = ${dealId}::uuid`;
    });
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23505") throw new ConflictError("ALREADY_TERMINATED", "This deal is already terminated");
    rethrow(err);
  }
  return lifecycleView(prisma, dealId);
}

// ── Offers register ──────────────────────────────────────────────────────────

export async function listOffers(prisma: PrismaClient, actor: Actor, dealId: string) {
  await assertDealAccess(prisma, actor, dealId);
  // A buyer-side agent on a same-brokerage deal sees only their own buyer's offer, never the competing ones
  const buyerSideOnly = (await oneSideOnly(prisma, actor, dealId)) === "BUYER";
  const offers = await prisma.offer.findMany({
    where: { listingDealId: dealId, ...(buyerSideOnly ? { buyerAgentIds: { has: actor.id } } : {}) },
    orderBy: { receivedAt: "asc" }, include: { events: { orderBy: { createdAt: "asc" } } },
  });
  return offers.map((o) => {
    const status = o.events.at(-1)?.status ?? "RECEIVED";
    const keepUntil = new Date(o.receivedAt.getTime());
    keepUntil.setUTCFullYear(keepUntil.getUTCFullYear() + (status === "ACCEPTED" ? 6 : 1));
    return {
      id: o.id, receivedAt: o.receivedAt.toISOString(), written: o.written, offerorBrokerage: o.offerorBrokerage, fromOurBrokerage: o.fromOurBrokerage,
      buyerRepresentation: o.buyerRepresentation, buyerAgentIds: o.buyerAgentIds,
      offerorSelfRepresented: o.offerorSelfRepresented, price: o.price?.toFixed(2) ?? null, status,
      documentFileId: o.documentFileId, keepUntil: iso(keepUntil),
      history: o.events.map((e) => ({ status: e.status, eventAt: e.eventAt.toISOString(), note: e.note })),
    };
  });
}

export async function recordOffer(prisma: PrismaClient, actor: Actor, dealId: string, body: unknown) {
  await assertDealAccess(prisma, actor, dealId);
  await assertSellerSide(prisma, actor, dealId);
  const r = new Reader(body, ["receivedAt", "written", "offerorBrokerage", "offerorSelfRepresented", "fromOurBrokerage", "buyerRepresentation",
    "buyerAgentIds", "price", "documentFileId"]);
  const input = {
    // The buyer is also our client (s.22.0.3: the other offerors are told), and how they're represented: multiple
    // representation with the seller or another of our buyers is decided from that
    fromOurBrokerage: r.has("fromOurBrokerage") ? r.bool("fromOurBrokerage") : false,
    buyerRepresentation: r.has("buyerRepresentation") ? r.oneOf("buyerRepresentation", ["BROKERAGE", "DESIGNATED"] as const) : null,
    buyerAgentIds: r.has("buyerAgentIds") ? r.textList("buyerAgentIds", 10, 36) : [],
    receivedAt: timestamp(r, "receivedAt"), written: r.bool("written"), offerorBrokerage: r.optionalText("offerorBrokerage", 200),
    offerorSelfRepresented: r.has("offerorSelfRepresented") ? r.bool("offerorSelfRepresented") : false,
    price: r.has("price") ? r.amount("price") : null, documentFileId: r.optionalUuid("documentFileId"),
  };
  r.check(input.offerorSelfRepresented || input.offerorBrokerage !== null, "offerorBrokerage", "name the buyer's brokerage, or mark the buyer self-represented");
  r.check(input.fromOurBrokerage || (input.buyerRepresentation === null && input.buyerAgentIds.length === 0), "buyerRepresentation",
    "only for a buyer this brokerage represents");
  r.check(input.buyerRepresentation !== "DESIGNATED" || input.buyerAgentIds.length > 0, "buyerAgentIds", "name the buyer's designated representatives");
  r.done();
  if (input.buyerAgentIds.length) {
    const found = await prisma.user.count({ where: { id: { in: input.buyerAgentIds }, isActive: true } });
    if (found !== new Set(input.buyerAgentIds).size) throw new RuleViolationError("UNKNOWN_AGENT", "Every designated representative must be an active person in this brokerage");
  }
  try {
    await prisma.$executeRaw`
      INSERT INTO "Offer" (id, "listingDealId", "receivedAt", written, "offerorBrokerage", "offerorSelfRepresented", "fromOurBrokerage",
        "buyerRepresentation", "buyerAgentIds", price, "documentFileId", "recordedById")
      VALUES (gen_random_uuid(), ${dealId}::uuid, ${input.receivedAt}::timestamptz, ${input.written}, ${input.offerorBrokerage},
              ${input.offerorSelfRepresented}, ${input.fromOurBrokerage}, ${input.buyerRepresentation}, ${input.buyerAgentIds}::uuid[],
              ${input.price === null ? null : formatCents(input.price)}::numeric, ${input.documentFileId}::uuid, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  await syncConsentSlot(prisma, dealId, todayInToronto());
  return listOffers(prisma, actor, dealId);
}

export async function offerEvent(prisma: PrismaClient, actor: Actor, offerId: string, body: unknown) {
  const offer = await prisma.offer.findUnique({ where: { id: offerId }, select: { listingDealId: true } });
  if (!offer) throw new NotFoundError("Offer", offerId);
  await assertDealAccess(prisma, actor, offer.listingDealId);
  await assertSellerSide(prisma, actor, offer.listingDealId);
  const r = new Reader(body, ["status", "eventAt", "note"]);
  const input = {
    status: r.oneOf("status", ["SIGNED_BACK", "ACCEPTED", "REJECTED", "EXPIRED", "WITHDRAWN"] as const),
    eventAt: r.has("eventAt") ? timestamp(r, "eventAt") : new Date().toISOString(), note: r.optionalText("note", 1000),
  };
  r.done();
  // s.22.7 / s.22.0.3: every other offeror is owed their disclosures before an offer is accepted
  if (input.status === "ACCEPTED") await requireOfferDisclosures(prisma, offer.listingDealId, offerId, todayInToronto());
  try {
    await prisma.$executeRaw`
      INSERT INTO "OfferEvent" (id, "offerId", status, "eventAt", note, "actorId")
      VALUES (gen_random_uuid(), ${offerId}::uuid, ${input.status}::"OfferStatus", ${input.eventAt}::timestamptz, ${input.note}, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return listOffers(prisma, actor, offer.listingDealId);
}

export async function lifecycleRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; today?: () => string }) {
  const actorOf = async (req: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(req));
  const today = () => opts.today?.() ?? todayInToronto();
  type P = { Params: Record<string, string> };
  const id = (req: { params: Record<string, string> }, k = "dealId") => validatePathUuid(req.params[k]!, k);
  app.get<P>("/api/deals/:dealId/lifecycle", async (req) => {
    await assertDealAccess(opts.prisma, await actorOf(req), id(req));
    return lifecycleView(opts.prisma, id(req));
  });
  app.post<P>("/api/deals/:dealId/conditions", async (req, reply) => reply.code(201).send(await addCondition(opts.prisma, await actorOf(req), id(req), req.body)));
  app.post<P>("/api/conditions/:id/outcome", async (req, reply) => reply.code(201).send(await recordConditionOutcome(opts.prisma, await actorOf(req), id(req, "id"), req.body)));
  app.post<P>("/api/deals/:dealId/firm", async (req) => markFirm(opts.prisma, await actorOf(req), id(req)));
  app.post<P>("/api/deals/:dealId/close", async (req) => markClosed(opts.prisma, await actorOf(req), id(req), req.body, today()));
  app.post<P>("/api/deals/:dealId/amendments", async (req, reply) => reply.code(201).send(await amendDeal(opts.prisma, await actorOf(req), id(req), req.body, today())));
  app.post<P>("/api/deals/:dealId/terminate", async (req) => terminateDeal(opts.prisma, await actorOf(req), id(req), req.body, today()));
  app.get<P>("/api/deals/:dealId/offers", async (req) => ({ offers: await listOffers(opts.prisma, await actorOf(req), id(req)) }));
  app.post<P>("/api/deals/:dealId/offers", async (req, reply) => reply.code(201).send({ offers: await recordOffer(opts.prisma, await actorOf(req), id(req), req.body) }));
  app.post<P>("/api/offers/:id/events", async (req, reply) => reply.code(201).send({ offers: await offerEvent(opts.prisma, await actorOf(req), id(req, "id"), req.body) }));
}
