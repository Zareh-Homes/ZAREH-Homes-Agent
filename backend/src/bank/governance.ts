/**
 * Who holds the legal roles, and which decisions have professional sign-off.
 *
 *   Broker of record designations: the broker of record (and any designated
 *   substitute) is a legal role under TRESA, not a permission. Designations
 *   are recorded by someone other than the designee, with the reference that
 *   supports them, and the database checks them for every action the
 *   regulation gives to the broker of record.
 *
 *   Financial policies: switches for decisions that depend on counsel or the
 *   accountant. Off until the broker of record turns one on, citing the
 *   sign-off. The latest decision wins; every decision is kept.
 */

import type { PrismaClient } from "@prisma/client";
import { requireRole, TRUST_VIEWERS, type Actor } from "../auth.ts";
import { ConflictError, DomainError, fromDatabaseError, NotFoundError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { Reader } from "../lib/reader.ts";
import { BANK_STAFF } from "./service.ts";

export const POLICIES = {
  SOLE_OPERATOR_EXCEPTION:
    "Lets one person do two duties that are normally separated (import and verify a bank file, record and approve a commission, " +
    "approve and release a payment, prepare and sign a reconciliation). Each use must give a reason and is flagged on the record.",
  THIRD_PARTY_PAYABLES:
    "Allows co-op brokerage and referral payables to be approved and paid. Off until counsel and the accountant confirm which " +
    "account those funds are held in.",
  COMMISSION_TRUST_ACCOUNT:
    "Allows commission to be received into, and paid from, a commission trust account. Off until counsel and the accountant confirm " +
    "the legal basis and rules for that account (no regulation section was found; see docs/regulatory-references.md §1).",
  CIVIC_HOLIDAY_IS_HOLIDAY:
    "Treats the Civic Holiday (first Monday in August) as a holiday for the 5-business-day trust deposit deadline. Off by default, " +
    "which gives the earlier deadline; turn on only once counsel confirms the Legislation Act s.87 lists it.",
  UNCLAIMED_MONEY_REMITTANCE:
    "Allows recording that unclaimed trust money was remitted to RECO (TRESA s.27(4)). The payment itself is made outside this " +
    "system. Off until the broker of record confirms RECO's current remittance process.",
  MANUAL_OBLIGATIONS_PROCEDURE:
    "Allows the operating account's obligations (payroll, HST, rent, bills) to be entered by hand, line by line with the source " +
    "document, instead of read from the accounting system. Each figure still needs a second person's attestation. Off until the " +
    "accountant approves the written procedure.",
} as const;
export type PolicyKey = keyof typeof POLICIES;

interface Deps {
  prisma: PrismaClient;
  today?: () => string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  throw fromDatabaseError(err) ?? err;
}

export async function listDesignations(deps: Deps, actor: Actor) {
  requireRole(actor, TRUST_VIEWERS, "Viewing broker-of-record designations");
  const today = deps.today?.() ?? todayInToronto();
  const rows = await deps.prisma.brokerOfRecordDesignation.findMany({
    orderBy: { effectiveFrom: "desc" },
    include: { user: { select: { firstName: true, lastName: true } }, createdBy: { select: { firstName: true, lastName: true } } },
  });
  return rows.map((d) => ({
    id: d.id,
    userId: d.userId,
    name: `${d.user.firstName} ${d.user.lastName}`,
    role: d.role,
    effectiveFrom: iso(d.effectiveFrom),
    effectiveTo: d.effectiveTo ? iso(d.effectiveTo) : null,
    activeToday: iso(d.effectiveFrom) <= today && (!d.effectiveTo || iso(d.effectiveTo) >= today),
    reference: d.reference,
    recordedBy: `${d.createdBy.firstName} ${d.createdBy.lastName}`,
  }));
}

export async function createDesignation(deps: Deps, actor: Actor, body: unknown) {
  requireRole(actor, BANK_STAFF, "Recording a broker-of-record designation");
  const r = new Reader(body, ["userId", "role", "effectiveFrom", "effectiveTo", "reference"]);
  const input = {
    userId: r.uuid("userId"),
    role: r.oneOf("role", ["BROKER_OF_RECORD", "DESIGNATED_SUBSTITUTE"] as const),
    effectiveFrom: r.date("effectiveFrom"),
    effectiveTo: r.optionalDate("effectiveTo"),
    reference: r.text("reference", 500),
  };
  r.done();
  try {
    const [row] = await deps.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "BrokerOfRecordDesignation" (id, "userId", role, "effectiveFrom", "effectiveTo", reference, "createdById")
      VALUES (gen_random_uuid(), ${input.userId}::uuid, ${input.role}::"BrokerDesignationRole", ${input.effectiveFrom}::date,
              ${input.effectiveTo}::date, ${input.reference}, ${actor.id}::uuid)
      RETURNING id::text`;
    return { id: row!.id };
  } catch (err) {
    rethrow(err);
  }
}

export async function endDesignation(deps: Deps, actor: Actor, id: string, body: unknown) {
  requireRole(actor, BANK_STAFF, "Ending a broker-of-record designation");
  const r = new Reader(body, ["effectiveTo"]);
  const effectiveTo = r.date("effectiveTo");
  r.done();
  try {
    const n = await deps.prisma.$executeRaw`
      UPDATE "BrokerOfRecordDesignation" SET "effectiveTo" = ${effectiveTo}::date WHERE id = ${id}::uuid`;
    if (n === 0) throw new NotFoundError("Designation", id);
  } catch (err) {
    rethrow(err);
  }
  return { id, effectiveTo };
}

export async function listPolicies(deps: Deps, actor: Actor) {
  requireRole(actor, TRUST_VIEWERS, "Viewing financial policies");
  const decisions = await deps.prisma.financialPolicyDecision.findMany({
    orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
    include: { decidedBy: { select: { firstName: true, lastName: true } } },
  });
  return (Object.keys(POLICIES) as PolicyKey[]).map((key) => {
    const history = decisions.filter((d) => d.policy === key);
    return {
      policy: key,
      description: POLICIES[key],
      enabled: history[0]?.enabled ?? false,
      history: history.map((d) => ({
        enabled: d.enabled, reference: d.reference, note: d.note,
        decidedBy: `${d.decidedBy.firstName} ${d.decidedBy.lastName}`, decidedAt: d.decidedAt.toISOString(),
      })),
    };
  });
}

/** Broker of record only (checked by the database), citing the counsel / accountant sign-off. */
export async function decidePolicy(deps: Deps, actor: Actor, body: unknown) {
  requireRole(actor, ["MANAGING_BROKER"], "Changing a financial policy");
  const r = new Reader(body, ["policy", "enabled", "reference", "note"]);
  const input = {
    policy: r.oneOf("policy", Object.keys(POLICIES) as PolicyKey[]),
    enabled: r.bool("enabled"),
    reference: r.text("reference", 500),
    note: r.optionalText("note", 2000),
  };
  r.done();
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO "FinancialPolicyDecision" (id, policy, enabled, reference, note, "decidedById")
      VALUES (gen_random_uuid(), ${input.policy}, ${input.enabled}, ${input.reference}, ${input.note}, ${actor.id}::uuid)`;
  } catch (err) {
    rethrow(err);
  }
  return (await listPolicies(deps, actor)).find((p) => p.policy === input.policy)!;
}

// ── Proclaimed holidays ──────────────────────────────────────────────────────

/** Statutory holidays are generated; proclaimed ones (s.87) are added here by the broker of record with the proclamation. */
export async function listProclaimedHolidays(deps: Deps, actor: Actor) {
  requireRole(actor, TRUST_VIEWERS, "Viewing the holiday calendar");
  const rows = await deps.prisma.proclaimedHoliday.findMany({ orderBy: { date: "asc" }, include: { addedBy: { select: { firstName: true, lastName: true } } } });
  return rows.map((h) => ({
    date: iso(h.date), name: h.name, reference: h.reference, addedBy: `${h.addedBy.firstName} ${h.addedBy.lastName}`, addedAt: h.addedAt.toISOString(),
  }));
}

export async function addProclaimedHoliday(deps: Deps, actor: Actor, body: unknown) {
  requireRole(actor, ["MANAGING_BROKER"], "Adding a proclaimed holiday");
  const r = new Reader(body, ["date", "name", "reference"]);
  const input = { date: r.date("date"), name: r.text("name", 200), reference: r.text("reference", 500) };
  r.done();
  try {
    await deps.prisma.$executeRaw`
      INSERT INTO "ProclaimedHoliday" (date, name, reference, "addedById")
      VALUES (${input.date}::date, ${input.name}, ${input.reference}, ${actor.id}::uuid)`;
  } catch (err) {
    if ((err as { meta?: { code?: string } })?.meta?.code === "23505") throw new ConflictError("HOLIDAY_EXISTS", `${input.date} is already a proclaimed holiday`);
    rethrow(err);
  }
  return input;
}
