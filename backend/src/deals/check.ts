/**
 * Deal check: the deal secretary's review, done by the system on every deal, every time it's opened. It reads what's
 * on file and says what's missing, what looks wrong, and which dates don't line up, so the agent can fix it before
 * anyone has to chase them.
 *
 *   MUST_FIX   wrong or missing in a way that stops the deal moving (or breaks a rule)
 *   CHECK      looks wrong or unusual: confirm it, or correct it
 *
 * Checks are grouped: Dates, Conditions & waivers, Amendments, Deposit, Commission, People, Agents, Documents,
 * Compliance (the TRESA and FINTRAC items that are blocking or late). Every check reads the records already kept;
 * nothing here changes a deal. The pure part (evaluateDealCheck) is tested on its own.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, type ResolveUserId } from "../auth.ts";
import { NotFoundError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { BusinessCalendar } from "../lib/ontario-calendar.ts";
import { validatePathUuid } from "../trust/validation.ts";
import { assertDealAccess } from "./lifecycle.ts";
import { obligationsFor } from "../obligations/service.ts";

export type Severity = "MUST_FIX" | "CHECK";
export type Area = "Dates" | "Conditions & waivers" | "Amendments" | "Deposit" | "Commission" | "People" | "Agents" | "Documents" | "Compliance";
export interface Issue { area: Area; severity: Severity; message: string; fix: string; tab: string }

export interface DealCheckFacts {
  side: string; status: string;
  salePrice: number; offerDate: string; conditionsDueDate: string | null; closeDate: string;
  depositAmount: number; depositDueDate: string | null; depositHolder: string;
  totalGci: number; coopCommission: number; coopBrokerage: string | null; buyerPays: number;
  parties: { role: string; name: string; representation: string | null; email: string | null; phone: string | null }[];
  agents: { name: string; recoExpiryDate: string | null; profile: boolean; planInForceAtClose: boolean }[];
  conditions: { description: string; dueAt: string; state: string; lastEventAt: string | null; lastEventHasDocument: boolean; extensions: number }[];
  amendments: { field: string; newValue: string; createdAt: string; hasDocument: boolean }[];
  termination: { terminatedOn: string; hasDocument: boolean } | null;
  deposits: { receivedDate: string | null; amount: number }[];
  documents: { name: string; status: string; required: boolean }[];
  agreementsExpiring: { client: string; expiresOn: string }[];
  compliance: { severity: string; message: string }[];
}

const money = (n: number) => `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso: string) => iso.slice(0, 10);
// Closings need the land registry and the banks open: weekends, statutory holidays and the Civic Holiday are out
const CLOSING_CALENDAR = new BusinessCalendar({ civicHoliday: true });
const OPEN = new Set(["CONDITIONAL", "FIRM"]);

export function evaluateDealCheck(f: DealCheckFacts, today: string): Issue[] {
  const out: Issue[] = [];
  const add = (area: Area, severity: Severity, message: string, fix: string, tab = "overview") => out.push({ area, severity, message, fix, tab });
  const open = OPEN.has(f.status);
  const listing = ["LISTING", "DUAL", "LANDLORD"].includes(f.side);
  const lease = f.side === "LANDLORD" || f.side === "TENANT";

  // ── Dates ──────────────────────────────────────────────────────────────────
  if (f.closeDate < f.offerDate) add("Dates", "MUST_FIX", `Closing (${f.closeDate}) is before the offer date (${f.offerDate})`, "Correct the closing or offer date, with an amendment if it changed");
  if (f.conditionsDueDate && (f.conditionsDueDate < f.offerDate || f.conditionsDueDate > f.closeDate)) {
    add("Dates", "MUST_FIX", `Conditions are due ${f.conditionsDueDate}, outside the offer (${f.offerDate}) to closing (${f.closeDate}) window`, "Check the conditions date against the agreement");
  }
  if (f.depositDueDate && f.depositDueDate < f.offerDate) add("Dates", "MUST_FIX", `The deposit is due ${f.depositDueDate}, before the offer date`, "Check the deposit due date against the agreement");
  if (f.depositDueDate && f.depositDueDate > f.closeDate) add("Dates", "CHECK", `The deposit is due ${f.depositDueDate}, after closing`, "Check the deposit due date");
  if (!CLOSING_CALENDAR.isBusinessDay(f.closeDate)) {
    const why = CLOSING_CALENDAR.holidayName(f.closeDate) ?? "a weekend";
    add("Dates", "CHECK", `Closing is on ${f.closeDate} (${why}): the land registry and banks are closed`, "Confirm the closing date with both lawyers; amend it if needed");
  }
  if (open && f.closeDate < today) add("Dates", "MUST_FIX", `The closing date (${f.closeDate}) has passed and the deal isn't closed`, "Mark it closed, or record the extension as an amendment with the signed form");
  if (f.status === "CONDITIONAL" && f.conditions.length === 0) add("Conditions & waivers", "CHECK", "Marked conditional, but no conditions are recorded", "Add each condition from the agreement, or mark the deal firm");
  if (f.offerDate > today) add("Dates", "CHECK", `The offer date (${f.offerDate}) is in the future`, "Check the offer date");

  // ── Conditions & waivers ─────────────────────────────────────────────────────
  for (const c of f.conditions) {
    if (day(c.dueAt) > f.closeDate) add("Conditions & waivers", "MUST_FIX", `"${c.description}" is due ${day(c.dueAt)}, after closing`, "Check the condition's date against the agreement");
    if ((c.state === "OPEN" || c.state === "EXTENDED") && c.dueAt < `${today}T00:00:00Z`) {
      add("Conditions & waivers", "MUST_FIX", `"${c.description}" was due ${day(c.dueAt)} and nothing is recorded`, "Record the waiver, fulfilment, extension or failure, with the signed document");
    }
    if ((c.state === "WAIVED" || c.state === "FULFILLED") && c.lastEventAt && c.lastEventAt > c.dueAt) {
      add("Conditions & waivers", "CHECK", `"${c.description}" was ${c.state.toLowerCase()} ${day(c.lastEventAt)}, after its deadline (${day(c.dueAt)})`,
        "Make sure an extension was signed before the deadline; otherwise the deal may have become void");
    }
    if (c.state !== "OPEN" && !c.lastEventHasDocument) {
      add("Conditions & waivers", "MUST_FIX", `"${c.description}" is ${c.state.toLowerCase()} with no signed document attached`, "Attach the signed waiver, notice of fulfilment or amendment");
    }
  }

  // ── Amendments & termination ─────────────────────────────────────────────────
  for (const a of f.amendments) {
    if (!a.hasDocument) add("Amendments", "MUST_FIX", `The ${a.field.toLowerCase().replace(/_/g, " ")} amendment (${day(a.createdAt)}) has no signed amendment attached`, "Attach the signed amendment (e.g. OREA Form 120)");
  }
  if (f.termination && !f.termination.hasDocument) add("Amendments", "MUST_FIX", "The termination has no signed mutual release attached", "Attach the signed mutual release");

  // ── Deposit ──────────────────────────────────────────────────────────────────
  if (f.depositAmount <= 0 && !lease) add("Deposit", "CHECK", "No deposit amount", "Enter the deposit from the agreement");
  if (f.depositAmount > f.salePrice) add("Deposit", "MUST_FIX", `The deposit (${money(f.depositAmount)}) is more than the price`, "Check the deposit and price");
  if (f.depositHolder === "OUR_BROKERAGE" && open) {
    const received = f.deposits.reduce((s, d) => s + d.amount, 0);
    if (received === 0 && f.depositDueDate && f.depositDueDate < today) add("Deposit", "MUST_FIX", `The deposit was due ${f.depositDueDate} and isn't recorded in trust`, "Record the deposit receipt, or follow up with the buyer's side", "trust");
    if (received > 0 && Math.abs(received - f.depositAmount) >= 0.01) add("Deposit", "CHECK", `Trust holds ${money(received)}; the agreement says ${money(f.depositAmount)}`, "Check for a missing or extra deposit, or amend the deposit amount", "trust");
    for (const d of f.deposits) {
      if (d.receivedDate && f.depositDueDate && d.receivedDate > f.depositDueDate) add("Deposit", "CHECK", `A deposit was received ${d.receivedDate}, after its due date (${f.depositDueDate})`, "Confirm a late deposit was accepted in writing", "trust");
    }
  }

  // ── Commission ───────────────────────────────────────────────────────────────
  if (f.totalGci <= 0) add("Commission", "MUST_FIX", "No commission recorded", "Enter the commission from the agreement");
  else if (!lease && f.salePrice > 0 && f.totalGci / f.salePrice > 0.07) add("Commission", "CHECK", `The commission (${money(f.totalGci)}) is over 7% of the price`, "Check the commission against the agreement");
  if (f.coopCommission > f.totalGci && f.totalGci > 0) add("Commission", "CHECK", "The co-op commission is more than our commission", "Check both amounts");
  if (f.coopCommission > 0 && !f.coopBrokerage) add("Commission", "MUST_FIX", "A co-op commission with no co-operating brokerage named", "Add the other brokerage");

  // ── People ───────────────────────────────────────────────────────────────────
  const has = (role: string) => f.parties.some((p) => p.role === role);
  const [sellerRole, buyerRole] = lease ? ["LANDLORD", "TENANT"] : ["SELLER", "BUYER"];
  if (!has(sellerRole)) add("People", "MUST_FIX", `No ${sellerRole.toLowerCase()} on the deal`, `Add the ${sellerRole.toLowerCase()}'s full legal name`);
  if (!has(buyerRole)) add("People", "MUST_FIX", `No ${buyerRole.toLowerCase()} on the deal`, `Add the ${buyerRole.toLowerCase()}'s full legal name`);
  if (!lease && listing && !has("SELLER_LAWYER")) add("People", f.status === "CONDITIONAL" ? "CHECK" : "MUST_FIX", "No seller's lawyer: the CDA is addressed to them", "Add the seller's lawyer with an email or phone");
  if (!lease && (f.side === "BUYER" || f.buyerPays > 0) && !has("BUYER_LAWYER")) add("People", "CHECK", "No buyer's lawyer", "Add the buyer's lawyer");
  if (!listing && !f.coopBrokerage && !has("COOP_BROKERAGE")) add("People", "MUST_FIX", "No listing brokerage named: they pay our commission", "Add the listing (co-operating) brokerage");
  for (const p of f.parties) {
    if (p.role.endsWith("LAWYER") && !p.email && !p.phone) add("People", "CHECK", `${p.name} has no email or phone`, "Add the lawyer's contact details");
    if (["SELLER", "BUYER", "LANDLORD", "TENANT"].includes(p.role) && !p.representation) add("People", "MUST_FIX", `Whether ${p.name} is our client isn't recorded`, "Record who represents them", "compliance");
  }

  // ── Agents ───────────────────────────────────────────────────────────────────
  for (const a of f.agents) {
    if (!a.profile) add("Agents", "CHECK", `${a.name}'s agent profile isn't filled in`, "Fill in their profile (Admin → People)");
    else if (a.recoExpiryDate && a.recoExpiryDate <= f.closeDate && open) add("Agents", "CHECK", `${a.name}'s RECO registration expires ${a.recoExpiryDate}, on or before closing`, "Make sure they renew before it expires");
    if (!a.planInForceAtClose) add("Agents", "MUST_FIX", `${a.name} has no approved commission plan for the closing date`, "Propose and approve their plan (Admin → Commission plans)");
  }
  for (const g of f.agreementsExpiring) {
    if (open) add("Agents", "CHECK", `${g.client}'s representation agreement expires ${g.expiresOn}, before closing`, "Get an extension signed", "compliance");
  }

  // ── Documents ────────────────────────────────────────────────────────────────
  for (const d of f.documents.filter((x) => x.required)) {
    if (d.status === "MISSING") add("Documents", open ? "MUST_FIX" : "CHECK", `${d.name} isn't uploaded`, "Upload it on the Documents tab", "documents");
    if (d.status === "NEEDS_REVISION") add("Documents", "MUST_FIX", `${d.name} was sent back`, "Fix it as the reviewer asked and upload the new version", "documents");
  }

  // ── Compliance (TRESA / FINTRAC) ─────────────────────────────────────────────
  for (const c of f.compliance) {
    add("Compliance", c.severity === "BREACH" ? "CHECK" : "MUST_FIX", c.severity === "BREACH" ? `Late: ${c.message}` : c.message,
      c.severity === "BREACH" ? "Done late: the broker of record reviews it" : "Record it on the TRESA & FINTRAC tab", "compliance");
  }
  return out;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const num = (d: { toFixed(n: number): string } | null) => (d ? Number(d.toFixed(2)) : 0);

async function facts(prisma: PrismaClient, actor: Parameters<typeof obligationsFor>[1], dealId: string, today: string): Promise<DealCheckFacts> {
  const d = await prisma.transaction.findUnique({
    where: { id: dealId },
    include: {
      parties: true,
      agents: { include: { user: { select: { firstName: true, lastName: true, id: true, agentProfile: { select: { recoExpiryDate: true } } } } } },
      conditions: { include: { events: { orderBy: { createdAt: "asc" } } } },
      amendments: true, termination: true,
      documentSlots: { include: { documentType: { select: { name: true } }, party: { select: { fullName: true } } } },
    },
  });
  if (!d) throw new NotFoundError("Deal", dealId);
  const closeDate = iso(d.closeDate);
  const plans = await prisma.$queryRaw<{ userId: string }[]>`
    SELECT a."userId"::text AS "userId" FROM "TransactionAgent" a
     WHERE a."transactionId" = ${dealId}::uuid AND (plan_in_force(a."userId", ${closeDate}::date)).id IS NOT NULL`;
  const withPlan = new Set(plans.map((p) => p.userId));
  const deposits = await prisma.trustLedgerEntry.findMany({ where: { transactionId: dealId, entryType: "DEPOSIT_RECEIVED", reversedBy: null },
    select: { receivedDate: true, amount: true } });
  const agreements = await prisma.representationAgreement.findMany({ where: { transactionId: dealId }, include: { party: { select: { fullName: true } } },
    orderBy: { signedAt: "desc" } });
  const latestByParty = new Map<string, (typeof agreements)[number]>();
  for (const a of agreements) if (!latestByParty.has(a.partyId)) latestByParty.set(a.partyId, a);
  const ob = await obligationsFor(prisma, actor, dealId, today);
  return {
    side: d.side, status: d.status, salePrice: num(d.salePrice), offerDate: iso(d.offerDate),
    conditionsDueDate: d.conditionsDueDate ? iso(d.conditionsDueDate) : null, closeDate,
    depositAmount: num(d.depositAmount), depositDueDate: d.depositDueDate ? iso(d.depositDueDate) : null, depositHolder: d.trustDepositHolder,
    totalGci: num(d.totalGci), coopCommission: num(d.coopCommission), coopBrokerage: d.coopBrokerageName,
    buyerPays: d.buyerSideGci && d.buyerSideSellerPays ? num(d.buyerSideGci) - num(d.buyerSideSellerPays) : 0,
    parties: d.parties.map((p) => ({ role: p.role, name: p.fullName, representation: p.representation, email: p.email, phone: p.phone })),
    agents: d.agents.map((a) => ({ name: `${a.user.firstName} ${a.user.lastName}`, profile: a.user.agentProfile !== null,
      recoExpiryDate: a.user.agentProfile ? iso(a.user.agentProfile.recoExpiryDate) : null, planInForceAtClose: withPlan.has(a.userId) })),
    conditions: d.conditions.map((c) => {
      const last = c.events.at(-1);
      return { description: c.description, dueAt: (last?.outcome === "EXTENDED" && last.newDueAt ? last.newDueAt : c.dueAt).toISOString(), state: last?.outcome ?? "OPEN",
        lastEventAt: last?.eventAt.toISOString() ?? null, lastEventHasDocument: !!last?.documentFileId, extensions: c.events.filter((e) => e.outcome === "EXTENDED").length };
    }),
    amendments: d.amendments.map((a) => ({ field: a.field, newValue: a.newValue, createdAt: a.createdAt.toISOString(), hasDocument: !!a.documentFileId })),
    termination: d.termination ? { terminatedOn: iso(d.termination.terminatedOn), hasDocument: !!d.termination.documentFileId } : null,
    deposits: deposits.map((x) => ({ receivedDate: x.receivedDate ? iso(x.receivedDate) : null, amount: num(x.amount) })),
    documents: d.documentSlots.map((s) => ({ name: `${s.documentType.name}${s.party ? ` (${s.party.fullName})` : ""}`, status: s.status, required: s.isRequired })),
    agreementsExpiring: [...latestByParty.values()].filter((a) => iso(a.expiresOn) < closeDate).map((a) => ({ client: a.party.fullName, expiresOn: iso(a.expiresOn) })),
    compliance: [...ob.tresa, ...ob.fintrac].filter((x) => x.severity === "BLOCKING" || x.severity === "BREACH").map((x) => ({ severity: x.severity, message: x.message })),
  };
}

export async function checkDeal(prisma: PrismaClient, actor: Parameters<typeof obligationsFor>[1], dealId: string, today: string) {
  await assertDealAccess(prisma, actor, dealId);
  const issues = evaluateDealCheck(await facts(prisma, actor, dealId, today), today);
  return { dealId, checkedOn: today, issues, summary: { mustFix: issues.filter((i) => i.severity === "MUST_FIX").length, check: issues.filter((i) => i.severity === "CHECK").length } };
}

/** The deal secretary's queue: every open deal with something to fix, most problems first */
export async function dealCheckQueue(prisma: PrismaClient, actor: Parameters<typeof obligationsFor>[1], today: string) {
  requireRole(actor, ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"], "Viewing the deal check queue");
  const deals = await prisma.transaction.findMany({ where: { status: { in: ["CONDITIONAL", "FIRM"] } },
    select: { id: true, dealNumber: true, streetAddress: true, city: true, closeDate: true, agents: { where: { role: "PRIMARY" }, include: { user: { select: { firstName: true, lastName: true } } } } } });
  const rows = [];
  for (const d of deals) {
    const r = await checkDeal(prisma, actor, d.id, today);
    if (r.issues.length === 0) continue;
    rows.push({ dealId: d.id, dealNumber: d.dealNumber, address: `${d.streetAddress}, ${d.city}`, closeDate: iso(d.closeDate),
      agent: d.agents[0] ? `${d.agents[0].user.firstName} ${d.agents[0].user.lastName}` : null, ...r.summary,
      top: r.issues.filter((i) => i.severity === "MUST_FIX").slice(0, 3).map((i) => i.message) });
  }
  rows.sort((a, b) => b.mustFix - a.mustFix || a.closeDate.localeCompare(b.closeDate));
  return { deals: rows };
}

export async function dealCheckRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; today?: () => string }) {
  const actorOf = async (req: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(req));
  const today = () => opts.today?.() ?? todayInToronto();
  app.get<{ Params: { dealId: string } }>("/api/deals/:dealId/check", async (req) =>
    checkDeal(opts.prisma, await actorOf(req), validatePathUuid(req.params.dealId, "dealId"), today()));
  app.get("/api/deal-checks", async (req) => dealCheckQueue(opts.prisma, await actorOf(req), today()));
}

