/**
 * Which compliance slots a deal needs, and how a slot's status may change.
 * Pure functions, mirrored by the database trigger in migration 004.
 */

import type { DealSide, DocumentStatus, PartyEntityType, PartyRole, UserRole } from "@prisma/client";

/** Our clients on each side of the trade: the people FINTRAC says we must identify. */
export const CLIENT_ROLES: Record<DealSide, readonly PartyRole[]> = {
  BUYER: ["BUYER"],
  LISTING: ["SELLER"],
  DUAL: ["BUYER", "SELLER"],
  LANDLORD: ["LANDLORD"],
  TENANT: ["TENANT"],
};

export interface DocumentTypeRule {
  id: string;
  code: string;
  requiredFor: DealSide[];
  slotScope: "DEAL" | "CLIENT_INDIVIDUAL" | "CLIENT_CORPORATION";
  isActive: boolean;
}

export interface PartyForRules {
  id: string;
  role: PartyRole;
  entityType: PartyEntityType;
  representation?: string | null;
}

export interface SlotSpec {
  documentTypeId: string;
  code: string;
  partyId: string | null;
}

/** The buyer and seller (or landlord and tenant): the principals to the trade. */
const PRINCIPALS: readonly PartyRole[] = ["BUYER", "SELLER", "LANDLORD", "TENANT"];

/**
 * The full set of slots a deal should have. Deal-level documents once per
 * deal; FINTRAC records once per individual client and once per corporate
 * client on our side of the trade, and for any self-represented party on the
 * other side (FINTRAC, in force 2025-10-01).
 */
export function requiredSlots(side: DealSide, parties: PartyForRules[], types: DocumentTypeRule[]): SlotSpec[] {
  const clients = parties.filter((p) => CLIENT_ROLES[side].includes(p.role)
    || (PRINCIPALS.includes(p.role) && p.representation === "SELF_REPRESENTED"));
  const specs: SlotSpec[] = [];
  for (const type of types) {
    if (!type.isActive || !type.requiredFor.includes(side)) continue;
    if (type.slotScope === "DEAL") {
      specs.push({ documentTypeId: type.id, code: type.code, partyId: null });
      continue;
    }
    const wanted: PartyEntityType = type.slotScope === "CLIENT_INDIVIDUAL" ? "INDIVIDUAL" : "CORPORATION";
    for (const party of clients) {
      if (party.entityType === wanted) specs.push({ documentTypeId: type.id, code: type.code, partyId: party.id });
    }
  }
  return specs;
}

// ── Status lifecycle ─────────────────────────────────────────────────────────

const TRANSITIONS: Record<DocumentStatus, readonly DocumentStatus[]> = {
  MISSING: ["PENDING_REVIEW", "WAIVED"],
  PENDING_REVIEW: ["PENDING_REVIEW", "APPROVED", "NEEDS_REVISION"],
  NEEDS_REVISION: ["PENDING_REVIEW"],
  APPROVED: [],
  WAIVED: [],
};

export function canTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Uploading a new version is allowed until the slot is approved or waived. */
export function canUpload(status: DocumentStatus): boolean {
  return canTransition(status, "PENDING_REVIEW");
}

export const DOCUMENT_REVIEWERS: readonly UserRole[] = ["MANAGING_BROKER", "COMPLIANCE_ADMIN"];

/** "Detailed" means more than a word or two. */
export const MIN_REVISION_COMMENT_LENGTH = 10;
