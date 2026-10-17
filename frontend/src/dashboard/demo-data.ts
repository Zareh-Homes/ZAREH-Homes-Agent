/**
 * Fictional data for local previews (?demo=admin | agent | broker) and
 * component tests. Not used in production builds unless VITE_ENABLE_DEMO=true.
 */

import type { BrokerageDashboard, DashboardResponse, PersonalDashboard } from "./types.ts";

const period = { year: 2026, today: "2026-10-17" };

export const demoBrokerage: BrokerageDashboard = {
  financials: {
    companyDollarCents: 18_642_500,
    closedVolumeCents: 4_216_550_000,
    closedDeals: 41,
    hstCollectedCents: 13_871_300,
    hstToRemitCents: 2_423_525,
    finalizedClosings: 38,
  },
  trust: {
    totalCents: 61_250_000,
    accounts: [
      { id: "a1", name: "Real Estate Trust", bankName: "TD", accountLast4: "4821", balanceCents: 58_750_000 },
      { id: "a2", name: "Pre-construction Trust", bankName: "RBC", accountLast4: "0193", balanceCents: 2_500_000 },
    ],
    pastClosing: [
      { id: "d1", dealNumber: "2026-0117", address: "41 Ridge Rd, Stoney Creek", closeDate: "2026-09-30", balanceCents: 4_000_000, daysPastClose: 17, status: "COLLAPSED", onHold: true },
      { id: "d2", dealNumber: "2026-0131", address: "1205 – 88 Queens Quay W, Toronto", closeDate: "2026-10-10", balanceCents: 6_065_000, daysPastClose: 7, status: "FIRM", onHold: false },
    ],
  },
  complianceQueue: [
    { id: "d3", dealNumber: "2026-0148", address: "22 Main St E, Grimsby", closeDate: "2026-10-16", daysToClose: -1, primaryAgent: "Priya Shah",
      missing: [{ document: "FINTRAC Individual Identification Record", party: "Leo Martins", status: "NEEDS_REVISION" }] },
    { id: "d4", dealNumber: "2026-0152", address: "310 Lakeshore Rd E, Oakville", closeDate: "2026-10-19", daysToClose: 2, primaryAgent: "Jane Smith",
      missing: [
        { document: "FINTRAC Individual Identification Record", party: "Maria Santos", status: "MISSING" },
        { document: "FINTRAC Individual Identification Record", party: "Daniel Santos", status: "PENDING_REVIEW" },
      ] },
    { id: "d5", dealNumber: "2026-0155", address: "8 Barton St, Hamilton", closeDate: "2026-10-23", daysToClose: 6, primaryAgent: "Omar Haddad",
      missing: [{ document: "FINTRAC Corporate / Beneficial Ownership Record", party: "2468013 Ontario Inc.", status: "MISSING" }] },
    { id: "d6", dealNumber: "2026-0160", address: "1450 Dundas St W, Mississauga", closeDate: "2026-10-29", daysToClose: 12, primaryAgent: "Jane Smith",
      missing: [{ document: "FINTRAC records", party: null, status: "NOT_SET_UP" }] },
  ],
};

export const demoPersonal: PersonalDashboard = {
  volumeCents: 1_187_500_000,
  closedDeals: 11,
  grossGciCents: 28_870_000,
  netPayoutsCents: 25_603_310,
  prec: { legalName: "Jane Smith Real Estate Professional Corporation", hstNumber: "123456789RT0001", hstReceivedCents: 2_945_810, commissionIncomeCents: 22_660_000 },
  cap: { capCents: 1_500_000, paidCents: 1_245_000, yearStart: "2026-01-01", yearEnd: "2027-01-01" },
  needsRevision: [
    { slotId: "s1", id: "d4", dealNumber: "2026-0152", address: "310 Lakeshore Rd E, Oakville", closeDate: "2026-10-19",
      document: "FINTRAC Individual Identification Record", party: "Maria Santos",
      comment: "FINTRAC ID expired before the verification date. Re-verify with current photo ID.", reviewer: "Alex Chen", reviewedAt: "2026-10-16" },
    { slotId: "s2", id: "d7", dealNumber: "2026-0158", address: "17 Elm Ave, Grimsby", closeDate: "2026-11-06",
      document: "Agreement of Purchase and Sale (APS)", party: null,
      comment: "APS missing Seller initials on page 3 (Schedule A, clause 4).", reviewer: "Daniel Zareh", reviewedAt: "2026-10-15" },
  ],
};

export const demoResponses: Record<string, DashboardResponse> = {
  admin: { viewer: { id: "u1", name: "Alex Chen", role: "COMPLIANCE_ADMIN", isPrec: false }, period, brokerage: demoBrokerage, personal: null },
  agent: { viewer: { id: "u2", name: "Jane Smith", role: "AGENT", isPrec: true }, period, brokerage: null, personal: demoPersonal },
  broker: { viewer: { id: "u3", name: "Daniel Zareh", role: "MANAGING_BROKER", isPrec: false }, period, brokerage: demoBrokerage, personal: { ...demoPersonal, prec: null } },
};
