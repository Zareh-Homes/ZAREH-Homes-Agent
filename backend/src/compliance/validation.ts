/** Request validation for deals, parties and document reviews. Pure functions. */

import type { DealAgentRole, DealSide, DealStatus, DepositHolder, PartyEntityType, PartyRole } from "@prisma/client";
import { ValidationError } from "../errors.ts";
import { type Cents } from "../lib/money.ts";
import { Reader } from "../lib/reader.ts";
import { CLIENT_ROLES, MIN_REVISION_COMMENT_LENGTH } from "./rules.ts";

const SIDES = ["LISTING", "BUYER", "DUAL", "LANDLORD", "TENANT"] as const satisfies readonly DealSide[];
const OPEN_STATUSES = ["CONDITIONAL", "FIRM"] as const satisfies readonly DealStatus[];
const HOLDERS = ["OUR_BROKERAGE", "COOP_BROKERAGE", "LAWYER", "BUILDER"] as const satisfies readonly DepositHolder[];
const AGENT_ROLES = ["PRIMARY", "CO_AGENT", "REFERRAL"] as const satisfies readonly DealAgentRole[];
const PARTY_ROLES = [
  "SELLER", "BUYER", "LANDLORD", "TENANT", "SELLER_LAWYER", "BUYER_LAWYER", "COOP_BROKERAGE",
] as const satisfies readonly PartyRole[];
const ENTITY_TYPES = ["INDIVIDUAL", "CORPORATION"] as const satisfies readonly PartyEntityType[];
const DECISIONS = ["APPROVED", "NEEDS_REVISION"] as const;

export interface PartyInput {
  role: PartyRole;
  entityType: PartyEntityType;
  fullName: string;
  representation?: "OUR_CLIENT" | "REPRESENTED_ELSEWHERE" | "SELF_REPRESENTED";
  email: string | null;
  phone: string | null;
}

export interface DealAgentInput {
  userId: string;
  role: DealAgentRole;
  splitPct: number;
}

export interface CreateDealInput {
  side: DealSide;
  status: DealStatus;
  streetAddress: string;
  unit: string | null;
  city: string;
  mlsNumber: string | null;
  listingId: string | null;
  salePrice: Cents;
  offerDate: string;
  conditionsDueDate: string | null;
  closeDate: string;
  depositAmount: Cents;
  depositDueDate: string | null;
  trustDepositHolder: DepositHolder;
  totalGci: Cents;
  coopBrokerageName: string | null;
  /** Listing side: the co-operating brokerage's commission, before tax */
  coopCommission: Cents;
  outsideReferralPayee: string | null;
  outsideReferralPct: number | null;
  agents: DealAgentInput[];
  parties: PartyInput[];
}

export interface ReviewInput {
  decision: (typeof DECISIONS)[number];
  comment: string | null;
  fileId: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readParty(p: Reader): PartyInput {
  const party: PartyInput = {
    role: p.oneOf("role", PARTY_ROLES),
    entityType: p.has("entityType") ? p.oneOf("entityType", ENTITY_TYPES) : "INDIVIDUAL",
    fullName: p.text("fullName", 300, 2),
    email: p.optionalText("email", 200),
    phone: p.optionalText("phone", 40),
    ...(p.has("representation") ? { representation: p.oneOf("representation", ["OUR_CLIENT", "REPRESENTED_ELSEWHERE", "SELF_REPRESENTED"] as const) } : {}),
  };
  if (party.email) p.check(EMAIL.test(party.email), "email", "is not a valid email address");
  return party;
}

export function validateCreateDeal(body: unknown): CreateDealInput {
  const r = new Reader(body, [
    "side", "status", "streetAddress", "unit", "city", "mlsNumber", "listingId", "salePrice", "offerDate",
    "conditionsDueDate", "closeDate", "depositAmount", "depositDueDate", "trustDepositHolder", "totalGci",
    "coopBrokerageName", "coopCommission", "outsideReferralPayee", "outsideReferralPct", "agents", "parties",
  ]);
  const agentReaders = r.objects("agents", ["userId", "role", "splitPct"], { min: 1, max: 4 });
  const partyReaders = r.objects("parties", ["role", "entityType", "fullName", "email", "phone", "representation"], { min: 1, max: 20 });

  const input: CreateDealInput = {
    side: r.oneOf("side", SIDES),
    status: r.has("status") ? r.oneOf("status", OPEN_STATUSES) : "CONDITIONAL",
    streetAddress: r.text("streetAddress", 200),
    unit: r.optionalText("unit", 20),
    city: r.text("city", 100),
    mlsNumber: r.optionalText("mlsNumber", 20),
    listingId: r.optionalUuid("listingId"),
    salePrice: r.amount("salePrice"),
    offerDate: r.date("offerDate"),
    conditionsDueDate: r.optionalDate("conditionsDueDate"),
    closeDate: r.date("closeDate"),
    depositAmount: r.amount("depositAmount"),
    depositDueDate: r.optionalDate("depositDueDate"),
    trustDepositHolder: r.oneOf("trustDepositHolder", HOLDERS),
    totalGci: r.amount("totalGci"),
    coopBrokerageName: r.optionalText("coopBrokerageName", 200),
    coopCommission: r.has("coopCommission") ? r.amount("coopCommission") : 0,
    outsideReferralPayee: r.optionalText("outsideReferralPayee", 200),
    outsideReferralPct: r.has("outsideReferralPct") ? r.percent("outsideReferralPct", 0, 100) : null,
    agents: agentReaders.map((a) => ({
      userId: a.uuid("userId"),
      role: a.oneOf("role", AGENT_ROLES),
      splitPct: a.percent("splitPct", 0, 100),
    })),
    parties: partyReaders.map(readParty),
  };

  r.check((input.outsideReferralPayee === null) === (input.outsideReferralPct === null), "outsideReferralPct",
    "an outside referral needs both the payee and the percentage");
  if (input.outsideReferralPct !== null) {
    r.check(input.outsideReferralPct > 0 && input.outsideReferralPct < 100, "outsideReferralPct", "must be more than 0 and less than 100");
  }
  if (input.side && input.coopCommission > 0) {
    r.check(input.side === "LISTING" || input.side === "LANDLORD", "coopCommission",
      "is only for listing-side deals (sale listings and landlord-side leases); on other deals the listing brokerage pays the co-op");
  }
  if (input.offerDate && input.closeDate) {
    r.check(input.closeDate >= input.offerDate, "closeDate", "cannot be before offerDate");
  }
  if (agentReaders.length > 0) {
    r.check(input.agents.filter((a) => a.role === "PRIMARY").length === 1, "agents", "needs exactly one PRIMARY agent");
    r.check(new Set(input.agents.map((a) => a.userId)).size === input.agents.length, "agents", "lists the same agent twice");
  }
  if (input.side && partyReaders.length > 0) {
    const clientRoles = CLIENT_ROLES[input.side] ?? [];
    r.check(
      input.parties.some((p) => clientRoles.includes(p.role)),
      "parties",
      `a ${input.side} deal needs at least one client (${clientRoles.join(" or ")}) so FINTRAC records can be set up`,
    );
  }
  r.done();
  return input;
}

export function validateAddParty(body: unknown): PartyInput {
  const r = new Reader(body, ["role", "entityType", "fullName", "email", "phone", "representation"]);
  const party = readParty(r);
  r.done();
  return party;
}

export function validateReview(body: unknown): ReviewInput {
  const r = new Reader(body, ["decision", "comment", "fileId"]);
  const input: ReviewInput = {
    decision: r.oneOf("decision", DECISIONS),
    comment: r.optionalText("comment", 2000),
    fileId: r.uuid("fileId"),
  };
  if (input.decision === "NEEDS_REVISION") {
    r.check(
      (input.comment?.length ?? 0) >= MIN_REVISION_COMMENT_LENGTH,
      "comment",
      `is required when sending a document back, and must say what to fix (at least ${MIN_REVISION_COMMENT_LENGTH} characters), ` +
        'e.g. "APS missing seller initials on page 3"',
    );
  }
  r.done();
  return input;
}

/** The `metadata` multipart field arrives as a JSON string. */
export function parseMetadataField(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new ValidationError([{ field: "metadata", message: "must be valid JSON" }]);
  }
}
