/**
 * Compliance obligations per deal: TRESA (tresa.ts) and FINTRAC (fintrac.ts),
 * evaluated from what's on file. Also the records the rules look for, the
 * FINTRAC report tasks and the compliance program. Nothing here contacts RECO
 * or FINTRAC: reports are filed by a person in FINTRAC's system and the
 * reference is recorded here.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Prisma, PrismaClient } from "@prisma/client";
import { loadActor, requireRole, type Actor, type ResolveUserId } from "../auth.ts";
import { DomainError, fromDatabaseError, NotFoundError, RuleViolationError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { formatCents, numericToCents } from "../lib/money.ts";
import { Reader } from "../lib/reader.ts";
import { validatePathUuid } from "../trust/validation.ts";
import { CLIENT_ROLES } from "../compliance/rules.ts";
import { ensureComplianceSlots } from "../compliance/service.ts";
import type { FieldCipher } from "../security/crypto.ts";
import { assertDealAccess } from "../deals/lifecycle.ts";
import { evaluateFintrac, evaluateProgram } from "./fintrac.ts";
import { classifyRepresentation, evaluateTresa, type TresaFacts } from "./tresa.ts";
import { summarize, type Finding, type PartyFacts, type Representation } from "./types.ts";

type Db = PrismaClient | Prisma.TransactionClient;
const COMPLIANCE = ["MANAGING_BROKER", "COMPLIANCE_ADMIN"] as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const LARGE_TRANSACTION_CENTS = 1_000_000;

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  throw fromDatabaseError(err) ?? err;
}

function timestamp(r: Reader, field: string, required = true): string | null {
  if (!required && !r.has(field)) return null;
  const v = r.raw(field);
  if (typeof v !== "string" || Number.isNaN(Date.parse(v)) || !/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    r.fail(field, 'must be a date and time, e.g. "2026-10-10T14:30:00-04:00"');
    return null;
  }
  return new Date(v).toISOString();
}

// ── Facts ────────────────────────────────────────────────────────────────────

async function partyFacts(db: Db, dealId: string): Promise<{ side: string; offerDate: string; agentIds: string[]; agentSides: { userId: string; side: string | null }[]; parties: PartyFacts[] }> {
  const deal = await db.transaction.findUnique({ where: { id: dealId }, include: { parties: true, agents: true } });
  if (!deal) throw new NotFoundError("Deal", dealId);
  const ours = CLIENT_ROLES[deal.side] as readonly string[];
  const otherBrokerage = deal.parties.some((p) => p.role === "COOP_BROKERAGE") || !!deal.coopBrokerageName;
  const parties = deal.parties.map((p): PartyFacts => {
    const principal = ["BUYER", "SELLER", "LANDLORD", "TENANT"].includes(p.role);
    const representation: Representation = (p.representation as Representation | null)
      ?? (ours.includes(p.role) ? "OUR_CLIENT" : principal ? (otherBrokerage ? "REPRESENTED_ELSEWHERE" : "UNKNOWN") : "REPRESENTED_ELSEWHERE");
    return { id: p.id, role: p.role, name: p.fullName, entityType: p.entityType, representation };
  });
  return { side: deal.side, offerDate: iso(deal.offerDate), agentIds: deal.agents.map((a) => a.userId),
    agentSides: deal.agents.map((a) => ({ userId: a.userId, side: a.side })), parties };
}

async function tresaFacts(db: Db, dealId: string, now: Date): Promise<TresaFacts> {
  const base = await partyFacts(db, dealId);
  const [disclosures, agreements, offers] = await Promise.all([
    db.tresaDisclosure.findMany({ where: { transactionId: dealId } }),
    db.representationAgreement.findMany({ where: { transactionId: dealId } }),
    db.offer.findMany({ where: { listingDealId: dealId }, include: { events: { orderBy: { createdAt: "asc" } } }, orderBy: { receivedAt: "asc" } }),
  ]);
  return {
    ...base,
    disclosures: disclosures.map((d) => ({
      kind: d.kind, partyId: d.partyId, offerId: d.offerId, deliveredAt: d.deliveredAt.toISOString(), explainedAt: d.explainedAt?.toISOString() ?? null,
      acknowledgedAt: d.acknowledgedAt?.toISOString() ?? null, bestEffortsNote: d.bestEffortsNote, formVersion: d.formVersion, numberDisclosed: d.numberDisclosed,
    })),
    agreements: agreements.map((a) => ({
      partyId: a.partyId, type: a.type as "BROKERAGE" | "DESIGNATED", designatedRepresentativeIds: a.designatedRepresentativeIds,
      signedAt: a.signedAt.toISOString(), effectiveFrom: iso(a.effectiveFrom), expiresOn: iso(a.expiresOn),
    })),
    offers: offers.map((o, i) => {
      const last = o.events.at(-1);
      const accepted = o.events.find((e) => e.status === "ACCEPTED");
      return {
        id: o.id, receivedAt: o.receivedAt.toISOString(), written: o.written, status: last?.status ?? "RECEIVED",
        acceptedAt: accepted?.eventAt.toISOString() ?? null, fromOurBrokerage: o.fromOurBrokerage,
        label: `offer ${i + 1} (${o.offerorSelfRepresented ? "self-represented buyer" : o.offerorBrokerage ?? "buyer"})`,
      };
    }),
    now: now.toISOString(),
  };
}

export async function evaluateDeal(db: Db, dealId: string, today: string, now = new Date(), opts: { acceptingOfferId?: string } = {}) {
  const tf = await tresaFacts(db, dealId, now);
  const slots = await db.documentSlot.findMany({
    where: { transactionId: dealId, partyId: { not: null }, documentType: { code: { in: ["FINTRAC_INDIVIDUAL", "FINTRAC_CORPORATE"] } } },
    include: { documentType: { select: { code: true } }, files: { orderBy: { version: "desc" }, take: 1, select: { metadata: true } } },
  });
  const determinations = await db.fintracDetermination.findMany({ where: { party: { transactionId: dealId } } });
  const deposits = await db.$queryRaw<{ entryId: string; amount: string; receivedDate: string; method: string; rof: boolean }[]>`
    SELECT e.id::text AS "entryId", e.amount::text, to_char(e."receivedDate", 'YYYY-MM-DD') AS "receivedDate", e.method::text AS method,
           EXISTS (SELECT 1 FROM "ReceiptOfFundsRecord" r WHERE r."trustEntryId" = e.id) AS rof
      FROM "TrustLedgerEntry" e
     WHERE e."transactionId" = ${dealId}::uuid AND e."entryType" = 'DEPOSIT_RECEIVED'
       AND NOT EXISTS (SELECT 1 FROM "TrustLedgerEntry" x WHERE x."reversesEntryId" = e.id)`;
  const reports = await db.fintracReport.findMany({ where: { transactionId: dealId }, include: { events: true } });
  const tresa = evaluateTresa(tf, opts);
  const fintrac = evaluateFintrac({
    side: tf.side, offerDate: tf.offerDate, parties: tf.parties, today,
    records: slots.map((s) => ({
      partyId: s.partyId!, kind: s.documentType.code as "FINTRAC_INDIVIDUAL" | "FINTRAC_CORPORATE", status: s.status,
      verificationDate: ((s.files[0]?.metadata as { verificationDate?: string } | null)?.verificationDate) ?? null,
    })),
    determinations: determinations.map((d) => ({ partyId: d.partyId, kind: d.kind, result: d.result, riskRating: d.riskRating, determinedAt: d.determinedAt.toISOString() })),
    deposits: deposits.map((d) => ({ entryId: d.entryId, amount: d.amount, receivedDate: d.receivedDate, method: d.method, hasReceiptOfFunds: d.rof })),
    reports: reports.map((r) => ({ id: r.id, kind: r.kind, dueAt: r.dueAt.toISOString(), status: (r.events[0]?.status ?? "OPEN") as "OPEN" | "FILED" | "NOT_REQUIRED" })),
  });
  return {
    dealId, asOf: now.toISOString(),
    parties: tf.parties.map(({ id, role, name, representation }) => ({ id, role, name, representation })),
    representation: classifyRepresentation(tf),
    tresa, fintrac,
    summary: { tresa: summarize(tresa), fintrac: summarize(fintrac) },
  };
}

/** Throws if any BLOCKING finding remains; used before the broker of record signs the trade record sheet. */
export async function requireNoBlockingFindings(db: Db, dealId: string, today: string, action: string) {
  const r = await evaluateDeal(db, dealId, today);
  const blocking: Finding[] = [...r.tresa, ...r.fintrac].filter((f) => f.severity === "BLOCKING");
  if (blocking.length) {
    throw new RuleViolationError("COMPLIANCE_OUTSTANDING", `${action}: ${blocking.length} compliance item(s) are outstanding`, {
      outstanding: blocking.map((f) => ({ rule: f.rule, citation: f.citation, message: f.message })),
    });
  }
}

/** Multiple representation must be disclosed and consented to before any step is taken for the clients. */
const CONSENT_RULES = new Set(["MULTIPLE_REPRESENTATION", "COMPETING_BUYER_CLIENTS"]);

/** Before a deal goes firm: written consent to multiple representation from every client it applies to. */
export async function requireRepresentationConsents(db: Db, dealId: string, today: string, action: string) {
  const r = await evaluateDeal(db, dealId, today);
  const blocking = r.tresa.filter((f) => CONSENT_RULES.has(f.rule) && f.severity === "BLOCKING");
  if (blocking.length) {
    throw new RuleViolationError("CONSENT_OUTSTANDING", `${action}: multiple representation needs each client's written disclosure and consent first`, {
      outstanding: blocking.map((f) => f.message),
    });
  }
}

/** Before an offer is accepted: every disclosure owed to the other offerors (s.22.7, s.22.0.3), and the clients' consent to multiple representation. */
export async function requireOfferDisclosures(db: Db, dealId: string, offerId: string, today: string) {
  const r = await evaluateDeal(db, dealId, today, new Date(), { acceptingOfferId: offerId });
  const blocking = r.tresa.filter((f) => (f.offerId || CONSENT_RULES.has(f.rule)) && f.severity === "BLOCKING");
  if (blocking.length) {
    throw new RuleViolationError("OFFER_DISCLOSURES_OUTSTANDING", "The other offerors are owed disclosures before any offer is accepted", {
      outstanding: blocking.map((f) => f.message),
    });
  }
}

// ── Large cash and virtual currency: opened automatically on receipt ─────────

export async function checkLargeTransaction(tx: Prisma.TransactionClient, entryId: string): Promise<string | null> {
  const [e] = await tx.$queryRaw<{ transactionId: string; method: string; counterparty: string; receivedDate: string; side: string }[]>`
    SELECT l."transactionId"::text AS "transactionId", l.method::text AS method, l.counterparty,
           to_char(l."receivedDate", 'YYYY-MM-DD') AS "receivedDate", t.side::text AS side
      FROM "TrustLedgerEntry" l JOIN "Transaction" t ON t.id = l."transactionId" WHERE l.id = ${entryId}::uuid`;
  if (!e || (e.method !== "CASH" && e.method !== "VIRTUAL_CURRENCY") || e.side === "LANDLORD" || e.side === "TENANT") return null;
  // The 24-hour rule: everything of the same kind from the same payer that day or the day before, on
  // purchases and sales only (FINTRAC's real estate obligations don't cover leasing)
  const window = await tx.$queryRaw<{ id: string; amount: string }[]>`
    SELECT l.id::text, l.amount::text FROM "TrustLedgerEntry" l JOIN "Transaction" t ON t.id = l."transactionId"
     WHERE l."entryType" = 'DEPOSIT_RECEIVED' AND l.method = ${e.method}::"PaymentMethod"
       AND t.side NOT IN ('LANDLORD', 'TENANT')
       AND lower(btrim(l.counterparty)) = lower(btrim(${e.counterparty}))
       AND l."receivedDate" BETWEEN ${e.receivedDate}::date - 1 AND ${e.receivedDate}::date`;
  const total = window.reduce((s, w) => s + numericToCents(w.amount), 0);
  if (total < LARGE_TRANSACTION_CENTS) return null;
  const kind = e.method === "CASH" ? "LARGE_CASH" : "LARGE_VIRTUAL_CURRENCY";
  const ids = window.map((w) => w.id);
  const [covered] = await tx.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM "FintracReport" WHERE kind = ${kind}::"FintracReportKind" AND "trustEntryIds" && ${ids}::uuid[]`;
  if (covered!.n > 0) return null;
  const [row] = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "FintracReport" (id, kind, "transactionId", "trustEntryIds", "triggeredAt", "dueAt", summary)
    VALUES (gen_random_uuid(), ${kind}::"FintracReportKind", ${e.transactionId}::uuid, ${ids}::uuid[], clock_timestamp(),
            (${e.receivedDate}::date + 15 + time '23:59') AT TIME ZONE 'America/Toronto',
            ${`$${formatCents(total)} in ${e.method === "CASH" ? "cash" : "virtual currency"} from ${e.counterparty} within 24 hours (${ids.length} receipt(s))`})
    RETURNING id::text`;
  return row!.id;
}

// ── Records ──────────────────────────────────────────────────────────────────

export async function setRepresentation(prisma: PrismaClient, actor: Actor, dealId: string, partyId: string, body: unknown, today: string) {
  await assertDealAccess(prisma, actor, dealId);
  const r = new Reader(body, ["representation"]);
  const representation = r.oneOf("representation", ["OUR_CLIENT", "REPRESENTED_ELSEWHERE", "SELF_REPRESENTED"] as const);
  r.done();
  await prisma.$transaction(async (tx) => {
    const n = await tx.transactionParty.updateMany({ where: { id: partyId, transactionId: dealId }, data: { representation } });
    if (n.count === 0) throw new NotFoundError("Party on this deal", partyId);
    await ensureComplianceSlots(tx, dealId); // an unrepresented party needs a FINTRAC record too
  });
  return evaluateDeal(prisma, dealId, today);
}

export async function recordDisclosure(prisma: PrismaClient, actor: Actor, dealId: string, body: unknown, today: string) {
  await assertDealAccess(prisma, actor, dealId);
  const r = new Reader(body, ["kind", "partyId", "offerId", "deliveredAt", "method", "explainedAt", "acknowledgedAt", "bestEffortsNote",
    "formVersion", "numberDisclosed", "content", "directionId", "documentFileId"]);
  const input = {
    kind: r.oneOf("kind", ["INFORMATION_GUIDE", "SELF_REPRESENTED_PARTY_FORM", "MULTIPLE_REPRESENTATION_DISCLOSURE", "MULTIPLE_REPRESENTATION_CONSENT",
      "COMPETING_OFFERS_NUMBER", "COMPETING_OFFERS_CONTENT", "SAME_BROKERAGE_REPRESENTATION", "COMPETING_BUYERS_CONSENT"] as const),
    partyId: r.optionalUuid("partyId"), offerId: r.optionalUuid("offerId"),
    deliveredAt: timestamp(r, "deliveredAt"), method: r.text("method", 200),
    explainedAt: timestamp(r, "explainedAt", false), acknowledgedAt: timestamp(r, "acknowledgedAt", false),
    bestEffortsNote: r.optionalText("bestEffortsNote", 1000),
    formVersion: r.has("formVersion") ? r.oneOf("formVersion", ["BROKERAGE_REPRESENTATION", "DESIGNATED_REPRESENTATION"] as const) : null,
    numberDisclosed: r.has("numberDisclosed") ? r.percent("numberDisclosed", 0, 1000) : null,
    content: r.optionalText("content", 4000), directionId: r.optionalUuid("directionId"), documentFileId: r.optionalUuid("documentFileId"),
  };
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "TresaDisclosure" (id, "transactionId", kind, "partyId", "offerId", "deliveredAt", method, "explainedAt", "acknowledgedAt",
        "bestEffortsNote", "formVersion", "numberDisclosed", content, "directionId", "documentFileId", "recordedById")
      VALUES (gen_random_uuid(), ${dealId}::uuid, ${input.kind}::"DisclosureKind", ${input.partyId}::uuid, ${input.offerId}::uuid,
        ${input.deliveredAt}::timestamptz, ${input.method}, ${input.explainedAt}::timestamptz, ${input.acknowledgedAt}::timestamptz,
        ${input.bestEffortsNote}, ${input.formVersion}, ${input.numberDisclosed}, ${input.content}, ${input.directionId}::uuid,
        ${input.documentFileId}::uuid, ${actor.id}::uuid)`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23514") {
      throw new RuleViolationError("DISCLOSURE_INCOMPLETE", "That disclosure is missing what it needs (the party or offer, the count, the content and direction, the form version, or the written consent date and what was confirmed)");
    }
    rethrow(err);
  }
  return evaluateDeal(prisma, dealId, today);
}

export async function recordAgreement(prisma: PrismaClient, actor: Actor, dealId: string, body: unknown, today: string) {
  await assertDealAccess(prisma, actor, dealId);
  const r = new Reader(body, ["partyId", "type", "designatedRepresentativeIds", "signedAt", "effectiveFrom", "expiresOn",
    "remunerationTerms", "services", "terminationTerms", "documentFileId"]);
  const input = {
    partyId: r.uuid("partyId"), type: r.oneOf("type", ["BROKERAGE", "DESIGNATED"] as const),
    designated: r.has("designatedRepresentativeIds") ? r.textList("designatedRepresentativeIds", 10, 36) : [],
    signedAt: timestamp(r, "signedAt"), effectiveFrom: r.date("effectiveFrom"), expiresOn: r.date("expiresOn"),
    remunerationTerms: r.text("remunerationTerms", 2000), services: r.text("services", 4000), terminationTerms: r.text("terminationTerms", 2000),
    documentFileId: r.optionalUuid("documentFileId"),
  };
  r.check(input.type === "BROKERAGE" || input.designated.length > 0, "designatedRepresentativeIds", "a designated agreement names each designated representative");
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "RepresentationAgreement" (id, "transactionId", "partyId", type, "designatedRepresentativeIds", "signedAt", "effectiveFrom", "expiresOn",
        "remunerationTerms", services, "terminationTerms", "documentFileId", "recordedById")
      VALUES (gen_random_uuid(), ${dealId}::uuid, ${input.partyId}::uuid, ${input.type}, ${input.designated}::uuid[], ${input.signedAt}::timestamptz,
        ${input.effectiveFrom}::date, ${input.expiresOn}::date, ${input.remunerationTerms}, ${input.services}, ${input.terminationTerms},
        ${input.documentFileId}::uuid, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return evaluateDeal(prisma, dealId, today);
}

export async function recordOfferDirection(prisma: PrismaClient, actor: Actor, dealId: string, body: unknown) {
  await assertDealAccess(prisma, actor, dealId);
  const r = new Reader(body, ["givenAt", "shareContent", "scope", "documentFileId"]);
  const input = { givenAt: timestamp(r, "givenAt"), shareContent: r.bool("shareContent"), scope: r.optionalText("scope", 2000), documentFileId: r.optionalUuid("documentFileId") };
  r.check(!input.shareContent || input.scope !== null, "scope", "say which content the seller has directed be shared");
  r.done();
  try {
    const [row] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "SellerOfferDirection" (id, "listingDealId", "givenAt", "shareContent", scope, "documentFileId", "recordedById")
      VALUES (gen_random_uuid(), ${dealId}::uuid, ${input.givenAt}::timestamptz, ${input.shareContent}, ${input.scope}, ${input.documentFileId}::uuid, ${actor.id}::uuid)
      RETURNING id::text`;
    return { id: row!.id, ...input };
  } catch (err) {
    rethrow(err);
  }
}

export async function recordDetermination(prisma: PrismaClient, actor: Actor, partyId: string, body: unknown, today: string) {
  const party = await prisma.transactionParty.findUnique({ where: { id: partyId }, select: { transactionId: true } });
  if (!party) throw new NotFoundError("Party", partyId);
  await assertDealAccess(prisma, actor, party.transactionId);
  const r = new Reader(body, ["kind", "determinedAt", "result", "riskRating", "details"]);
  const input = {
    kind: r.oneOf("kind", ["PEP_HIO", "BUSINESS_RELATIONSHIP", "BENEFICIAL_OWNERSHIP_CONFIRMED", "ENTITY_EXISTENCE_CONFIRMED"] as const),
    determinedAt: r.has("determinedAt") ? timestamp(r, "determinedAt") : new Date().toISOString(),
    result: r.text("result", 200), riskRating: r.has("riskRating") ? r.oneOf("riskRating", ["LOW", "MEDIUM", "HIGH"] as const) : null,
    details: r.text("details", 4000),
  };
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "FintracDetermination" (id, "partyId", kind, "determinedAt", result, "riskRating", details, "recordedById")
      VALUES (gen_random_uuid(), ${partyId}::uuid, ${input.kind}::"FintracDeterminationKind", ${input.determinedAt}::timestamptz, ${input.result},
              ${input.riskRating}, ${input.details}, ${actor.id}::uuid)`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23514") {
      throw new RuleViolationError("DETERMINATION_INVALID", "A PEP/HIO determination needs a result (NONE, FOREIGN_PEP, DOMESTIC_PEP, HIO, FAMILY_OR_CLOSE_ASSOCIATE) and a risk rating; a foreign PEP is always high risk");
    }
    rethrow(err);
  }
  return evaluateDeal(prisma, party.transactionId, today);
}

export async function recordReceiptOfFunds(prisma: PrismaClient, cipher: FieldCipher, actor: Actor, entryId: string, body: unknown, today: string) {
  const entry = await prisma.trustLedgerEntry.findUnique({ where: { id: entryId }, select: { transactionId: true } });
  if (!entry) throw new NotFoundError("Trust entry", entryId);
  await assertDealAccess(prisma, actor, entry.transactionId);
  const r = new Reader(body, ["payerType", "payerName", "payerDetails", "cashAmount", "currency", "sourceAccount", "onBehalfOf", "exemptReason"]);
  const payerType = r.oneOf("payerType", ["PERSON", "ENTITY", "FINANCIAL_ENTITY", "PUBLIC_BODY"] as const);
  const exempt = payerType === "FINANCIAL_ENTITY" || payerType === "PUBLIC_BODY";
  const details = exempt ? null : r.nested("payerDetails", ["address", "dateOfBirth", "occupation", "telephone", "incorporationNumber", "jurisdiction", "principalBusiness"]);
  const payer = details ? (payerType === "PERSON"
    ? { address: details.text("address", 300), dateOfBirth: details.date("dateOfBirth"), occupation: details.text("occupation", 200), telephone: details.optionalText("telephone", 40) }
    : { address: details.text("address", 300), incorporationNumber: details.optionalText("incorporationNumber", 50), jurisdiction: details.text("jurisdiction", 100),
        principalBusiness: details.text("principalBusiness", 200) }) : null;
  const input = {
    payerName: r.text("payerName", 300), cashAmount: r.has("cashAmount") ? r.amount("cashAmount") : 0,
    currency: r.has("currency") ? r.text("currency", 3, 3) : "CAD", sourceAccount: r.optionalText("sourceAccount", 200),
    onBehalfOf: r.optionalText("onBehalfOf", 300), exemptReason: r.optionalText("exemptReason", 300),
  };
  r.check(exempt === (input.exemptReason !== null), "exemptReason", "give the exemption (funds from a financial entity or public body), and only then");
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "ReceiptOfFundsRecord" ("trustEntryId", "payerType", "payerName", "payerDetailsEnc", "cashAmount", currency, "sourceAccount",
        "onBehalfOf", "exemptReason", "recordedById")
      VALUES (${entryId}::uuid, ${payerType}, ${input.payerName}, ${payer ? cipher.encrypt(JSON.stringify(payer)) : null},
        ${formatCents(input.cashAmount)}::numeric, ${input.currency}, ${input.sourceAccount}, ${input.onBehalfOf}, ${input.exemptReason}, ${actor.id}::uuid)`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23505") throw new RuleViolationError("ALREADY_RECORDED", "This deposit already has a receipt of funds record");
    rethrow(err);
  }
  return evaluateDeal(prisma, entry.transactionId, today);
}

// ── Reports ──────────────────────────────────────────────────────────────────

export async function listReports(prisma: PrismaClient, actor: Actor, openOnly: boolean) {
  requireRole(actor, COMPLIANCE, "Viewing FINTRAC reports");
  const rows = await prisma.fintracReport.findMany({ orderBy: { dueAt: "asc" }, include: { events: true, transaction: { select: { dealNumber: true } } } });
  return rows.map((r) => ({
    id: r.id, kind: r.kind, dealNumber: r.transaction?.dealNumber ?? null, summary: r.summary, triggeredAt: r.triggeredAt.toISOString(),
    dueAt: r.dueAt.toISOString(), status: r.events[0]?.status ?? "OPEN", reference: r.events[0]?.reference ?? null,
    overdue: !r.events[0] && r.dueAt < new Date(),
  })).filter((r) => !openOnly || r.status === "OPEN");
}

/** Suspicion or listed-person property: opened by compliance staff, due as soon as practicable / immediately. */
export async function openReport(prisma: PrismaClient, actor: Actor, body: unknown) {
  requireRole(actor, COMPLIANCE, "Opening a FINTRAC report");
  const r = new Reader(body, ["kind", "dealId", "summary"]);
  const input = { kind: r.oneOf("kind", ["SUSPICIOUS_TRANSACTION", "LISTED_PERSON_PROPERTY"] as const), dealId: r.optionalUuid("dealId"), summary: r.text("summary", 4000) };
  r.done();
  try {
    // "As soon as practicable" / "immediately": due now, so it heads every list until filed
    await prisma.$executeRaw`
      INSERT INTO "FintracReport" (id, kind, "transactionId", "triggeredAt", "dueAt", summary, "openedById")
      VALUES (gen_random_uuid(), ${input.kind}::"FintracReportKind", ${input.dealId}::uuid, clock_timestamp(), clock_timestamp(), ${input.summary}, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return listReports(prisma, actor, true);
}

export async function closeReport(prisma: PrismaClient, actor: Actor, reportId: string, body: unknown) {
  requireRole(actor, COMPLIANCE, "Recording a FINTRAC report");
  const r = new Reader(body, ["status", "reference", "note"]);
  const input = { status: r.oneOf("status", ["FILED", "NOT_REQUIRED"] as const), reference: r.optionalText("reference", 200), note: r.text("note", 2000) };
  r.check(input.status !== "FILED" || input.reference !== null, "reference", "the FINTRAC acknowledgement number is required");
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "FintracReportEvent" (id, "reportId", status, reference, note, "actorId")
      VALUES (gen_random_uuid(), ${reportId}::uuid, ${input.status}::"FintracReportStatus", ${input.reference}, ${input.note}, ${actor.id}::uuid)`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23503") throw new NotFoundError("FINTRAC report", reportId);
    rethrow(err);
  }
  return listReports(prisma, actor, false);
}

// ── Compliance program ───────────────────────────────────────────────────────

export async function programStatus(prisma: PrismaClient, actor: Actor, today: string) {
  requireRole(actor, ["ADMIN", ...COMPLIANCE], "Viewing the FINTRAC compliance program");
  const records = await prisma.complianceProgramRecord.findMany({ orderBy: { effectiveDate: "desc" }, include: { subject: { select: { firstName: true, lastName: true } } } });
  const latest = (k: string) => records.find((r) => r.kind === k);
  const agents = await prisma.user.findMany({ where: { isActive: true, role: { in: ["AGENT", "MANAGING_BROKER"] } }, select: { id: true, firstName: true, lastName: true } });
  const officer = latest("COMPLIANCE_OFFICER");
  const findings = evaluateProgram({
    officer: officer ? { name: `${officer.subject!.firstName} ${officer.subject!.lastName}`, since: iso(officer.effectiveDate) } : null,
    policiesApprovedOn: latest("POLICIES_APPROVED") ? iso(latest("POLICIES_APPROVED")!.effectiveDate) : null,
    riskAssessmentOn: latest("RISK_ASSESSMENT") ? iso(latest("RISK_ASSESSMENT")!.effectiveDate) : null,
    lastReviewOn: latest("EFFECTIVENESS_REVIEW") ? iso(latest("EFFECTIVENESS_REVIEW")!.effectiveDate) : null,
    agents: agents.map((a) => {
      const t = records.find((r) => r.kind === "TRAINING" && r.subjectUserId === a.id);
      return { id: a.id, name: `${a.firstName} ${a.lastName}`, lastTrainedOn: t ? iso(t.effectiveDate) : null };
    }),
    today,
  });
  return {
    asOf: today, findings, summary: summarize(findings),
    records: records.slice(0, 200).map((r) => ({ kind: r.kind, effectiveDate: iso(r.effectiveDate), title: r.title,
      subject: r.subject ? `${r.subject.firstName} ${r.subject.lastName}` : null })),
  };
}

export async function recordProgram(prisma: PrismaClient, actor: Actor, body: unknown, today: string) {
  requireRole(actor, COMPLIANCE, "Recording the FINTRAC compliance program");
  const r = new Reader(body, ["kind", "effectiveDate", "subjectUserId", "title", "details", "documentFileId"]);
  const input = {
    kind: r.oneOf("kind", ["COMPLIANCE_OFFICER", "POLICIES_APPROVED", "RISK_ASSESSMENT", "TRAINING", "EFFECTIVENESS_REVIEW"] as const),
    effectiveDate: r.pastDate("effectiveDate", today), subjectUserId: r.optionalUuid("subjectUserId"),
    title: r.text("title", 300), details: r.text("details", 4000), documentFileId: r.optionalUuid("documentFileId"),
  };
  r.check(!["COMPLIANCE_OFFICER", "TRAINING"].includes(input.kind) || input.subjectUserId !== null, "subjectUserId", "name the person");
  r.done();
  try {
    await prisma.$executeRaw`
      INSERT INTO "ComplianceProgramRecord" (id, kind, "effectiveDate", "subjectUserId", title, details, "documentFileId", "recordedById")
      VALUES (gen_random_uuid(), ${input.kind}::"ComplianceProgramKind", ${input.effectiveDate}::date, ${input.subjectUserId}::uuid, ${input.title},
              ${input.details}, ${input.documentFileId}::uuid, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return programStatus(prisma, actor, today);
}

export async function obligationRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; fieldCipher: FieldCipher; today?: () => string }) {
  const actorOf = async (req: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(req));
  const today = () => opts.today?.() ?? todayInToronto();
  type P = { Params: Record<string, string> };
  const id = (req: { params: Record<string, string> }, k: string) => validatePathUuid(req.params[k]!, k);
  app.get<P>("/api/deals/:dealId/obligations", async (req) => {
    await assertDealAccess(opts.prisma, await actorOf(req), id(req, "dealId"));
    return evaluateDeal(opts.prisma, id(req, "dealId"), today());
  });
  app.post<P>("/api/deals/:dealId/parties/:partyId/representation", async (req) =>
    setRepresentation(opts.prisma, await actorOf(req), id(req, "dealId"), id(req, "partyId"), req.body, today()));
  app.post<P>("/api/deals/:dealId/disclosures", async (req, reply) => reply.code(201).send(await recordDisclosure(opts.prisma, await actorOf(req), id(req, "dealId"), req.body, today())));
  app.post<P>("/api/deals/:dealId/representation-agreements", async (req, reply) =>
    reply.code(201).send(await recordAgreement(opts.prisma, await actorOf(req), id(req, "dealId"), req.body, today())));
  app.post<P>("/api/deals/:dealId/offer-directions", async (req, reply) => reply.code(201).send(await recordOfferDirection(opts.prisma, await actorOf(req), id(req, "dealId"), req.body)));
  app.post<P>("/api/parties/:partyId/fintrac-determinations", async (req, reply) =>
    reply.code(201).send(await recordDetermination(opts.prisma, await actorOf(req), id(req, "partyId"), req.body, today())));
  app.post<P>("/api/trust/entries/:entryId/receipt-of-funds", async (req, reply) =>
    reply.code(201).send(await recordReceiptOfFunds(opts.prisma, opts.fieldCipher, await actorOf(req), id(req, "entryId"), req.body, today())));
  app.get<{ Querystring: { open?: string } }>("/api/fintrac/reports", async (req) => ({ reports: await listReports(opts.prisma, await actorOf(req), req.query.open === "true") }));
  app.post("/api/fintrac/reports", async (req, reply) => reply.code(201).send({ reports: await openReport(opts.prisma, await actorOf(req), req.body) }));
  app.post<P>("/api/fintrac/reports/:id/events", async (req) => ({ reports: await closeReport(opts.prisma, await actorOf(req), id(req, "id"), req.body) }));
  app.get("/api/fintrac/program", async (req) => programStatus(opts.prisma, await actorOf(req), today()));
  app.post("/api/fintrac/program", async (req, reply) => reply.code(201).send(await recordProgram(opts.prisma, await actorOf(req), req.body, today())));
}
