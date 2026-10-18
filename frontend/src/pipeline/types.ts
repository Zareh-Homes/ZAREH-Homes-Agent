/** GET /api/pipeline (backend/src/pipeline). Money is integer cents. */

export type ColumnKey = "ACTIVE" | "CONDITIONAL" | "FIRM" | "CLOSED";

export interface DepositBadgeData {
  state: "CLEARED" | "LATE_TO_TRUST" | "OVERDUE" | "PARTIAL" | "DUE" | "NOT_RECORDED" | "HELD_ELSEWHERE";
  tone: "good" | "critical" | "warning" | "neutral";
  label: string;
  detail: string;
  expectedCents: number;
  receivedCents: number;
}

export interface PipelineCard {
  id: string;
  kind: "LISTING" | "DEAL";
  href: string;
  dealNumber: string | null;
  side: string | null;
  address: string;
  city: string;
  mlsNumber: string | null;
  agentName: string | null;
  priceCents: number;
  priceLabel: "List price" | "Sale price";
  keyDate: { label: string; date: string; daysFromToday: number } | null;
  deposit: DepositBadgeData | null;
  finalized: boolean;
}

export interface PipelineResponse {
  today: string;
  month: string;
  scope: "ALL" | "MINE";
  columns: Record<ColumnKey, PipelineCard[]>;
}
