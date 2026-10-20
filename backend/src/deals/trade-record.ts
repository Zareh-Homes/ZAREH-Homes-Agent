/**
 * Trade record sheet (O. Reg. 579/05 s.17), migration 015.
 *
 *   Prepared   items 1–10 generated from the deal: nature of the trade, property, true
 *              consideration, parties, lawyers, registrants, deposit, our remuneration and who
 *              pays it, remuneration to another brokerage and its name, and the scheduled
 *              completion date with any amended one (from the recorded amendments). Anything the
 *              deal doesn't have is listed as missing; nothing is guessed.
 *   Corrected  each correction is appended with a reason and the initials of whoever made it;
 *              the original entry stays legible (s.17(4)).
 *   Signed     by the agent representing the client once no conditions remain (s.17(3)), then
 *              by the broker of record after review (s.17(5)). Frozen once the broker signs.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, type Actor, type ResolveUserId } from "../auth.ts";
import { ConflictError, DomainError, fromDatabaseError, NotFoundError, RuleViolationError } from "../errors.ts";
import { formatCents, numericToCents } from "../lib/money.ts";
import { Reader } from "../lib/reader.ts";
import { validatePathUuid } from "../trust/validation.ts";
import { assertDealAccess } from "./lifecycle.ts";
import { requireNoBlockingFindings } from "../obligations/service.ts";
import { todayInToronto } from "../lib/dates.ts";

export const TRS_ITEMS = [
  "natureOfTrade", "property", "consideration", "parties", "lawyers", "registrants", "deposit", "brokerageRemuneration",
  "otherBrokerageRemuneration", "completionDate", "additionalItems",
] as const;
export type TrsItem = (typeof TRS_ITEMS)[number];
type Items = Record<TrsItem, unknown>;

const LABEL: Record<TrsItem, string> = {
  natureOfTrade: "1. Nature of the trade", property: "2. Property", consideration: "3. True consideration", parties: "4. Parties",
  lawyers: "5. Lawyers acting for the parties", registrants: "6. Registrants representing the parties", deposit: "7. Deposit",
  brokerageRemuneration: "8. Our remuneration and who pays it", otherBrokerageRemuneration: "9. Remuneration to another brokerage",
  completionDate: "10. Completion date (scheduled, and amended if any)",
  additionalItems: "Notes (broker of record's review)",
};

/** A record value as text with object keys sorted, so two values compare equal whatever their key order */
function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort)
      : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]))
        : x;
  return JSON.stringify(sort(v) ?? null);
}

/** A record value in words, for messages: "$18,750.00 · payer Lakeshore Realty Ltd. · plus HST" */
function describe(v: unknown): string {
  const dollars = (x: string) => `$${Number(x).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (v === null || v === undefined || v === "") return "nothing";
  if (typeof v === "string") return /^-?\d+(\.\d+)?$/.test(v) ? dollars(v) : v;
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(describe).join("; ");
  return Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== null && x !== undefined && x !== false)
    .map(([k, x]) => (k === "taxExtra" ? "plus HST" : k === "amount" ? describe(x) : `${k.replace(/([A-Z])/g, " $1").toLowerCase()} ${describe(x)}`))
    .join(" · ");
}

const NATURE: Record<string, string> = {
  LISTING: "Sale of real property: the brokerage represents the seller",
  BUYER: "Purchase of real property: the brokerage represents the buyer",
  DUAL: "Sale of real property: the seller and the buyer are both clients of this brokerage (see their representation agreements)",
  LANDLORD: "Lease of real property: the brokerage represents the landlord",
  TENANT: "Lease of real property: the brokerage represents the tenant",
};

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  if ((err as { meta?: { code?: string } })?.meta?.code === "23505") throw new ConflictError("ALREADY_PREPARED", "This deal already has a trade record sheet");
  throw fromDatabaseError(err) ?? err;
}

/** Items 1–10 from the deal as it stands; missing items are reported, never filled in. */
export async function generateItems(prisma: PrismaClient, dealId: string): Promise<Items> {
  const deal = await prisma.transaction.findUnique({
    where: { id: dealId },
    include: { parties: true, agents: { include: { user: true } }, amendments: { where: { field: "CLOSE_DATE" }, orderBy: { createdAt: "asc" } } },
  });
  if (!deal) throw new NotFoundError("Deal", dealId);
  const closeDate = deal.closeDate.toISOString().slice(0, 10);
  // Same-brokerage deals: each client pays what their own agreement says
  const sellerPays = deal.listingSideGci !== null && deal.buyerSideSellerPays !== null
    ? numericToCents(deal.listingSideGci.toFixed(2)) + numericToCents(deal.buyerSideSellerPays.toFixed(2)) : null;
  const buyerPays = deal.buyerSideGci !== null && deal.buyerSideSellerPays !== null
    ? numericToCents(deal.buyerSideGci.toFixed(2)) - numericToCents(deal.buyerSideSellerPays.toFixed(2)) : null;
  const byRole = (...roles: string[]) => deal.parties.filter((p) => roles.includes(p.role));
  const principals = deal.side === "LANDLORD" || deal.side === "TENANT" ? ["LANDLORD", "TENANT"] : ["SELLER", "BUYER"];
  const coop = byRole("COOP_BROKERAGE")[0]?.fullName ?? deal.coopBrokerageName ?? null;
  const listingSide = ["LISTING", "DUAL", "LANDLORD"].includes(deal.side);
  const payers = buyerPays !== null && buyerPays > 0
    ? [...byRole("SELLER").map((p) => p.fullName), ...byRole("BUYER").map((p) => p.fullName)]
    : listingSide ? byRole(principals[0]!).map((p) => p.fullName) : coop ? [coop] : [];
  return {
    natureOfTrade: NATURE[deal.side] ?? deal.side,
    property: { address: deal.streetAddress, unit: deal.unit, city: deal.city, province: deal.province, mlsNumber: deal.mlsNumber },
    consideration: deal.salePrice.toFixed(2),
    parties: byRole(...principals).map((p) => ({ role: p.role, name: p.fullName, entityType: p.entityType })),
    lawyers: byRole("SELLER_LAWYER", "BUYER_LAWYER").map((p) => ({ role: p.role, name: p.fullName, email: p.email, phone: p.phone })),
    registrants: [
      ...deal.agents.map((a) => ({
        // Same-brokerage deals: the client each agent actually represents (an agent on both sides, BOTH)
        side: deal.side === "DUAL" ? (a.side === "LISTING" ? "SELLER" : a.side === "BUYER" ? "BUYER" : "BOTH") : listingSide ? principals[0] : principals[1],
        brokerage: "this brokerage",
        name: `${a.user.firstName} ${a.user.lastName}`, recoRegistrationNo: a.user.recoRegistrationNo, email: a.user.email, phone: a.user.phone,
      })),
      ...(deal.side !== "DUAL" && coop ? [{ side: listingSide ? principals[1] : principals[0], brokerage: coop, name: null, email: null, phone: null }] : []),
    ],
    deposit: { amount: deal.depositAmount.toFixed(2), heldBy: deal.trustDepositHolder },
    brokerageRemuneration: {
      amount: deal.totalGci.toFixed(2), payer: payers.length ? payers.join(", ") : null, taxExtra: true,
      // Same-brokerage deals: what each side's agreement provides (part of the amount above, not in addition)
      ...(deal.listingSideGci !== null && deal.buyerSideGci !== null
        ? { listingSide: deal.listingSideGci.toFixed(2), buyerSide: deal.buyerSideGci.toFixed(2) } : {}),
      ...(sellerPays !== null && buyerPays !== null ? { paidBySeller: formatCents(sellerPays), paidByBuyer: formatCents(buyerPays) } : {}),
    },
    otherBrokerageRemuneration: listingSide && deal.side !== "DUAL" && coop
      ? { amount: deal.coopCommission.toFixed(2), brokerage: coop }
      : { amount: "0.00", brokerage: null },
    // O. Reg. 579/05 s.17(1) item 10: the scheduled completion date and any amended completion date (the amendment
    // history stays in the deal's amendments)
    completionDate: {
      scheduled: deal.amendments[0]?.oldValue ?? closeDate,
      amendedDate: deal.amendments.length ? closeDate : null,
    },
    additionalItems: null,
  };
}

export function missingItems(items: Items): { item: TrsItem; reason: string }[] {
  const out: { item: TrsItem; reason: string }[] = [];
  const parties = items.parties as { role: string }[];
  const roles = new Set(parties.map((p) => p.role));
  if (!(roles.has("SELLER") && roles.has("BUYER")) && !(roles.has("LANDLORD") && roles.has("TENANT"))) {
    out.push({ item: "parties", reason: "both sides of the trade must be named" });
  }
  if ((items.lawyers as unknown[]).length === 0) out.push({ item: "lawyers", reason: "name the lawyers acting, or correct this item to state that none act" });
  const registrants = items.registrants as { name: string | null; email: string | null; phone: string | null; brokerage: string }[];
  for (const r of registrants) {
    if (!r.name || !(r.email || r.phone)) out.push({ item: "registrants", reason: `name and contact details of the registrant at ${r.brokerage}` });
  }
  const pay = items.brokerageRemuneration as { payer: string | null } | null;
  if (!pay?.payer) out.push({ item: "brokerageRemuneration", reason: "who pays the brokerage's remuneration" });
  const other = items.otherBrokerageRemuneration as { amount: string; brokerage: string | null } | null;
  if (other && Number(other.amount) > 0 && !other.brokerage) out.push({ item: "otherBrokerageRemuneration", reason: "the name of the other brokerage" });
  return out;
}

function effectiveItems(sheet: { items: unknown; corrections: { item: string; newValue: unknown }[] }): Items {
  const items = { ...(sheet.items as Items) };
  for (const c of sheet.corrections) items[c.item as TrsItem] = c.newValue;
  return items;
}

export async function tradeRecordView(prisma: PrismaClient, dealId: string) {
  const sheet = await prisma.tradeRecordSheet.findUnique({
    where: { transactionId: dealId },
    include: {
      corrections: { orderBy: { createdAt: "asc" }, include: { initialledBy: { select: { firstName: true, lastName: true } } } },
      preparedBy: { select: { firstName: true, lastName: true } },
      agentSigner: { select: { firstName: true, lastName: true } },
      brokerSigner: { select: { firstName: true, lastName: true } },
    },
  });
  if (!sheet) throw new NotFoundError("Trade record sheet for deal", dealId);
  const items = effectiveItems(sheet);
  const current = await generateItems(prisma, dealId);
  // The deal changed after the sheet was prepared (an amendment): flag it, don't rewrite the record.
  // Compared without key order: the stored copy is jsonb, which re-sorts an object's keys.
  const drift = (["consideration", "deposit", "otherBrokerageRemuneration", "brokerageRemuneration", "completionDate"] as const)
    .filter((k) => canonical(items[k]) !== canonical(current[k]))
    .map((k) => `${LABEL[k]}: the deal now shows ${describe(current[k])}`);
  const name = (u: { firstName: string; lastName: string } | null) => (u ? `${u.firstName} ${u.lastName}` : null);
  const initials = (u: { firstName: string; lastName: string }) => `${u.firstName[0]}${u.lastName[0]}`.toUpperCase();
  return {
    id: sheet.id, dealId,
    status: sheet.brokerSignedAt ? "SIGNED_BY_BROKER_OF_RECORD" : sheet.agentSignedAt ? "SIGNED_BY_AGENT" : "PREPARED",
    items: TRS_ITEMS.map((k) => ({
      item: k, label: LABEL[k], value: items[k],
      history: [
        { value: (sheet.items as Items)[k], by: name(sheet.preparedBy), at: sheet.preparedAt.toISOString(), reason: "As prepared", initials: null },
        ...sheet.corrections.filter((c) => c.item === k).map((c) => ({
          value: c.newValue, by: name(c.initialledBy), at: c.createdAt.toISOString(), reason: c.reason, initials: initials(c.initialledBy),
        })),
      ],
    })),
    missing: sheet.missing,
    differsFromDeal: drift,
    agentSignedBy: name(sheet.agentSigner), agentSignedAt: sheet.agentSignedAt?.toISOString() ?? null,
    brokerSignedBy: name(sheet.brokerSigner), brokerSignedAt: sheet.brokerSignedAt?.toISOString() ?? null,
    retainUntil: sheet.brokerSignedAt ? `${sheet.brokerSignedAt.getUTCFullYear() + 6}${sheet.brokerSignedAt.toISOString().slice(4, 10)}` : null,
  };
}

export async function prepareTradeRecord(prisma: PrismaClient, actor: Actor, dealId: string) {
  await assertDealAccess(prisma, actor, dealId);
  const items = await generateItems(prisma, dealId);
  try {
    await prisma.$executeRaw`
      INSERT INTO "TradeRecordSheet" (id, "transactionId", items, missing, "preparedById")
      VALUES (gen_random_uuid(), ${dealId}::uuid, ${JSON.stringify(items)}::jsonb, ${JSON.stringify(missingItems(items))}::jsonb, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return tradeRecordView(prisma, dealId);
}

export async function correctTradeRecord(prisma: PrismaClient, actor: Actor, dealId: string, body: unknown) {
  await assertDealAccess(prisma, actor, dealId);
  const r = new Reader(body, ["item", "value", "reason"]);
  const item = r.oneOf("item", TRS_ITEMS);
  r.check(r.raw("value") !== undefined, "value", "is required");
  const reason = r.text("reason", 1000);
  r.done();
  const sheet = await prisma.tradeRecordSheet.findUnique({ where: { transactionId: dealId }, include: { corrections: { orderBy: { createdAt: "asc" } } } });
  if (!sheet) throw new NotFoundError("Trade record sheet for deal", dealId);
  const value = r.raw("value");
  const next = effectiveItems({ items: sheet.items, corrections: [...sheet.corrections, { item, newValue: value }] });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "TradeRecordCorrection" (id, "sheetId", item, "newValue", reason, "initialledById")
        VALUES (gen_random_uuid(), ${sheet.id}::uuid, ${item}, ${JSON.stringify(value)}::jsonb, ${reason}, ${actor.id}::uuid)`;
      await tx.$executeRaw`UPDATE "TradeRecordSheet" SET missing = ${JSON.stringify(missingItems(next))}::jsonb WHERE id = ${sheet.id}::uuid`;
    });
  } catch (err) {
    rethrow(err);
  }
  return tradeRecordView(prisma, dealId);
}

export async function signTradeRecord(prisma: PrismaClient, actor: Actor, dealId: string, as: "agent" | "broker", body: unknown, today = todayInToronto()) {
  const r = new Reader(body ?? {}, ["exceptionReason"]);
  const exceptionReason = r.optionalText("exceptionReason", 500);
  r.done();
  const sheet = await prisma.tradeRecordSheet.findUnique({ where: { transactionId: dealId }, select: { id: true } });
  if (!sheet) throw new NotFoundError("Trade record sheet for deal", dealId);
  // The broker of record's review covers the deal's TRESA and FINTRAC obligations too
  if (as === "broker") {
    requireRole(actor, ["MANAGING_BROKER"], "Signing the trade record sheet as broker of record"); // the database checks the designation
    await requireNoBlockingFindings(prisma, dealId, today, "Signing the trade record sheet");
  } else {
    // Only an agent on the deal signs as its agent (the database checks this too)
    await assertDealAccess(prisma, actor, dealId);
  }
  try {
    if (as === "agent") {
      await prisma.$executeRaw`UPDATE "TradeRecordSheet" SET "agentSignedById" = ${actor.id}::uuid, "agentSignedAt" = clock_timestamp() WHERE id = ${sheet.id}::uuid`;
    } else {
      await prisma.$executeRaw`
        UPDATE "TradeRecordSheet" SET "brokerSignedById" = ${actor.id}::uuid, "brokerSignedAt" = clock_timestamp(), "brokerExceptionReason" = ${exceptionReason}
         WHERE id = ${sheet.id}::uuid`;
    }
  } catch (err) {
    // The database lists the missing items as data; say them in words
    if (/complete every item before signing/.test((err as Error)?.message ?? "")) {
      const missing = ((await tradeRecordView(prisma, dealId)).missing ?? []) as { item: string; reason: string }[];
      throw new RuleViolationError("TRS_INCOMPLETE",
        `Complete these items before signing: ${missing.map((m) => `${LABEL[m.item as TrsItem] ?? m.item} (${m.reason})`).join("; ")}`, { missing });
    }
    rethrow(err);
  }
  return tradeRecordView(prisma, dealId);
}

export async function tradeRecordRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; today?: () => string }) {
  const actorOf = async (req: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(req));
  type P = { Params: Record<string, string> };
  const id = (req: { params: Record<string, string> }) => validatePathUuid(req.params.dealId!, "dealId");
  app.get<P>("/api/deals/:dealId/trade-record", async (req) => {
    await assertDealAccess(opts.prisma, await actorOf(req), id(req));
    return tradeRecordView(opts.prisma, id(req));
  });
  app.post<P>("/api/deals/:dealId/trade-record", async (req, reply) => reply.code(201).send(await prepareTradeRecord(opts.prisma, await actorOf(req), id(req))));
  app.post<P>("/api/deals/:dealId/trade-record/corrections", async (req, reply) =>
    reply.code(201).send(await correctTradeRecord(opts.prisma, await actorOf(req), id(req), req.body)));
  app.post<P>("/api/deals/:dealId/trade-record/sign", async (req) => signTradeRecord(opts.prisma, await actorOf(req), id(req), "agent", req.body));
  app.post<P>("/api/deals/:dealId/trade-record/broker-sign", async (req) =>
    signTradeRecord(opts.prisma, await actorOf(req), id(req), "broker", req.body, opts.today?.() ?? todayInToronto()));
}
