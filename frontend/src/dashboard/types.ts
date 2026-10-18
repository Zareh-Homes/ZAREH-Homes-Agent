/** GET /api/dashboard (backend/src/dashboard/service.ts). Money is integer cents. */

export type UserRole = "ADMIN" | "MANAGING_BROKER" | "COMPLIANCE_ADMIN" | "AGENT";

export interface DealRef {
  id: string;
  dealNumber: string;
  address: string;
  closeDate: string;
}

export interface BrokerageDashboard {
  financials: {
    companyDollarCents: number;
    closedVolumeCents: number;
    closedDeals: number;
    hstCollectedCents: number;
    netHstEstimateCents: number;
    finalizedClosings: number;
  };
  trust: {
    totalCents: number;
    accounts: { id: string; name: string; bankName: string; accountLast4: string; balanceCents: number }[];
    pastClosing: (DealRef & { balanceCents: number; daysPastClose: number; status: string; onHold: boolean })[];
    unclearedCents: number;
    reconciliations: {
      trustAccountId: string;
      name: string;
      kind: "REAL_ESTATE_TRUST" | "COMMISSION_TRUST";
      lastStatementEnd: string | null;
      lastSignedPeriodEnd: string | null;
      awaitingSignature: { periodEnd: string; received: string | null; dueBy: string; overdue: boolean }[];
      missingStatements: { month: string; dueBy: string; overdue: boolean }[];
      openIncidents: { id: string; kind: "SHORTFALL" | "DISCREPANCY"; amount: string; detectedAt: string }[];
    }[];
  };
  complianceQueue: (DealRef & {
    daysToClose: number;
    primaryAgent: string | null;
    missing: { document: string; party: string | null; status: string }[];
  })[];
}

export interface PersonalDashboard {
  volumeCents: number;
  closedDeals: number;
  grossGciCents: number;
  netPayoutsCents: number;
  prec: null | { legalName: string; hstNumber: string | null; hstReceivedCents: number; commissionIncomeCents: number };
  cap: null | { capCents: number; paidCents: number; yearStart: string; yearEnd: string };
  needsRevision: (DealRef & {
    slotId: string;
    document: string;
    party: string | null;
    comment: string;
    reviewer: string | null;
    reviewedAt: string | null;
  })[];
}

export interface DashboardResponse {
  viewer: { id: string; name: string; role: UserRole; isPrec: boolean };
  period: { year: number; today: string };
  brokerage: BrokerageDashboard | null;
  personal: PersonalDashboard | null;
}
