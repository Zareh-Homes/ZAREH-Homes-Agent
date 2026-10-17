/**
 * Compliance module client state: a pure reducer plus selectors.
 * Server responses are the source of truth; the reducer only stores them and
 * tracks in-flight work, errors and per-field validation messages.
 */

import type {
  DealDocuments,
  DealSummary,
  DocumentStatus,
  NotificationView,
  SlotView,
  UploadResult,
  ReviewResult,
  UserRole,
  Viewer,
} from "./types.ts";

// ── State ────────────────────────────────────────────────────────────────────

export interface DealEntry {
  status: "loading" | "ready" | "error";
  error: string | null;
  deal: DealDocuments["deal"] | null;
  slotIds: string[];
  /** A notification says something changed on the server; refetch when convenient. */
  stale: boolean;
}

export interface SlotOperation {
  status: "idle" | "working" | "error" | "done";
  error: string | null;
  code: string | null;
  fieldErrors: Record<string, string>;
  warnings: string[];
}

export interface ComplianceState {
  deals: Record<string, DealEntry>;
  slots: Record<string, SlotView>;
  uploads: Record<string, SlotOperation>;
  reviews: Record<string, SlotOperation>;
  notifications: { items: NotificationView[]; connected: boolean };
}

export const initialState: ComplianceState = {
  deals: {},
  slots: {},
  uploads: {},
  reviews: {},
  notifications: { items: [], connected: false },
};

export interface OperationError {
  message: string;
  code: string;
  fieldErrors: Record<string, string>;
}

export type Action =
  | { type: "deal/loadStarted"; dealId: string }
  | { type: "deal/loaded"; docs: DealDocuments }
  | { type: "deal/loadFailed"; dealId: string; error: string }
  | { type: "slot/uploadStarted"; slotId: string }
  | { type: "slot/uploadSucceeded"; result: UploadResult }
  | { type: "slot/uploadFailed"; slotId: string; error: OperationError }
  | { type: "slot/reviewStarted"; slotId: string }
  | { type: "slot/reviewSucceeded"; result: ReviewResult }
  | { type: "slot/reviewFailed"; slotId: string; error: OperationError }
  | { type: "notifications/loaded"; items: NotificationView[] }
  | { type: "notifications/received"; notification: NotificationView }
  | { type: "notifications/markedRead"; notification: NotificationView }
  | { type: "notifications/connection"; connected: boolean };

const IDLE: SlotOperation = { status: "idle", error: null, code: null, fieldErrors: {}, warnings: [] };
const WORKING: SlotOperation = { ...IDLE, status: "working" };

function failed(error: OperationError): SlotOperation {
  return { status: "error", error: error.message, code: error.code, fieldErrors: error.fieldErrors, warnings: [] };
}

function withSlot(state: ComplianceState, slot: SlotView): ComplianceState["slots"] {
  return { ...state.slots, [slot.id]: slot };
}

// ── Reducer ──────────────────────────────────────────────────────────────────

export function complianceReducer(state: ComplianceState, action: Action): ComplianceState {
  switch (action.type) {
    case "deal/loadStarted": {
      const prev = state.deals[action.dealId];
      // Keep showing the old checklist while refreshing
      const entry: DealEntry = prev
        ? { ...prev, status: prev.status === "ready" ? "ready" : "loading", error: null }
        : { status: "loading", error: null, deal: null, slotIds: [], stale: false };
      return { ...state, deals: { ...state.deals, [action.dealId]: entry } };
    }

    case "deal/loaded": {
      const { docs } = action;
      const slots = { ...state.slots };
      for (const slot of docs.slots) slots[slot.id] = slot;
      return {
        ...state,
        slots,
        deals: {
          ...state.deals,
          [docs.deal.id]: { status: "ready", error: null, deal: docs.deal, slotIds: docs.slots.map((s) => s.id), stale: false },
        },
      };
    }

    case "deal/loadFailed": {
      const prev: DealEntry = state.deals[action.dealId] ?? { status: "error", error: null, deal: null, slotIds: [], stale: false };
      return {
        ...state,
        deals: { ...state.deals, [action.dealId]: { ...prev, status: "error", error: action.error } },
      };
    }

    case "slot/uploadStarted":
      return { ...state, uploads: { ...state.uploads, [action.slotId]: WORKING } };

    case "slot/uploadSucceeded": {
      const { slot, warnings } = action.result;
      return {
        ...state,
        slots: withSlot(state, slot),
        uploads: { ...state.uploads, [slot.id]: { ...IDLE, status: "done", warnings } },
        // A new version means any half-finished review of the old one is moot
        reviews: { ...state.reviews, [slot.id]: IDLE },
      };
    }

    case "slot/uploadFailed":
      return { ...state, uploads: { ...state.uploads, [action.slotId]: failed(action.error) } };

    case "slot/reviewStarted":
      return { ...state, reviews: { ...state.reviews, [action.slotId]: WORKING } };

    case "slot/reviewSucceeded": {
      const { slot } = action.result;
      return {
        ...state,
        slots: withSlot(state, slot),
        reviews: { ...state.reviews, [slot.id]: { ...IDLE, status: "done" } },
      };
    }

    case "slot/reviewFailed":
      return { ...state, reviews: { ...state.reviews, [action.slotId]: failed(action.error) } };

    case "notifications/loaded":
      return { ...state, notifications: { ...state.notifications, items: mergeNotifications([], action.items) } };

    case "notifications/received": {
      const n = action.notification;
      const deal = n.dealId ? state.deals[n.dealId] : undefined;
      return {
        ...state,
        notifications: { ...state.notifications, items: mergeNotifications(state.notifications.items, [n]) },
        deals: deal && n.dealId ? { ...state.deals, [n.dealId]: { ...deal, stale: true } } : state.deals,
      };
    }

    case "notifications/markedRead":
      return {
        ...state,
        notifications: { ...state.notifications, items: mergeNotifications(state.notifications.items, [action.notification]) },
      };

    case "notifications/connection":
      return { ...state, notifications: { ...state.notifications, connected: action.connected } };
  }
}

/** Upsert by id, newest first. The stream can redeliver after a reconnect. */
function mergeNotifications(current: NotificationView[], incoming: NotificationView[]): NotificationView[] {
  const byId = new Map(current.map((n) => [n.id, n]));
  for (const n of incoming) byId.set(n.id, n);
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Selectors ────────────────────────────────────────────────────────────────

const REVIEWERS: readonly UserRole[] = ["MANAGING_BROKER", "COMPLIANCE_ADMIN"];
const UPLOADABLE: readonly DocumentStatus[] = ["MISSING", "PENDING_REVIEW", "NEEDS_REVISION"];

export const STATUS_DISPLAY: Record<DocumentStatus, { label: string; tone: "neutral" | "info" | "success" | "warning" | "muted" }> = {
  MISSING: { label: "Missing", tone: "neutral" },
  PENDING_REVIEW: { label: "Pending review", tone: "info" },
  APPROVED: { label: "Approved", tone: "success" },
  NEEDS_REVISION: { label: "Needs revision", tone: "warning" },
  WAIVED: { label: "Waived", tone: "muted" },
};

export function summarize(slots: SlotView[]): DealSummary & { percentComplete: number } {
  const required = slots.filter((s) => s.isRequired);
  const count = (status: DocumentStatus) => required.filter((s) => s.status === status).length;
  const done = required.filter((s) => s.status === "APPROVED" || s.status === "WAIVED").length;
  return {
    required: required.length,
    approved: count("APPROVED"),
    pendingReview: count("PENDING_REVIEW"),
    needsRevision: count("NEEDS_REVISION"),
    missing: count("MISSING"),
    complete: done === required.length,
    percentComplete: required.length === 0 ? 100 : Math.round((done / required.length) * 100),
  };
}

export interface SlotActions {
  canUpload: boolean;
  canReview: boolean;
  needsMetadata: boolean;
  busy: boolean;
}

export function slotActions(state: ComplianceState, slotId: string, viewer: Viewer): SlotActions {
  const slot = state.slots[slotId];
  if (!slot) return { canUpload: false, canReview: false, needsMetadata: false, busy: false };
  const busy = state.uploads[slotId]?.status === "working" || state.reviews[slotId]?.status === "working";
  return {
    canUpload: UPLOADABLE.includes(slot.status) && !busy,
    canReview: REVIEWERS.includes(viewer.role) && slot.status === "PENDING_REVIEW" && slot.latestFile !== null && !busy,
    needsMetadata: slot.metadataKind !== "NONE",
    busy,
  };
}

export interface ChecklistView {
  status: DealEntry["status"];
  error: string | null;
  stale: boolean;
  deal: DealDocuments["deal"] | null;
  /** Deal-level documents first, then one group per client */
  groups: { title: string; slots: SlotView[] }[];
  summary: ReturnType<typeof summarize>;
  /** What's stopping the file from being complete, most urgent first */
  blocking: { slotId: string; text: string }[];
}

export function selectChecklist(state: ComplianceState, dealId: string): ChecklistView | null {
  const entry = state.deals[dealId];
  if (!entry) return null;
  const slots = entry.slotIds.map((id) => state.slots[id]).filter((s): s is SlotView => s !== undefined);

  const groups: ChecklistView["groups"] = [];
  const dealDocs = slots.filter((s) => !s.party);
  if (dealDocs.length > 0) groups.push({ title: "Deal documents", slots: dealDocs });
  const byParty = new Map<string, SlotView[]>();
  for (const s of slots) if (s.party) byParty.set(s.party.fullName, [...(byParty.get(s.party.fullName) ?? []), s]);
  for (const [name, partySlots] of byParty) groups.push({ title: `FINTRAC — ${name}`, slots: partySlots });

  const urgency: Partial<Record<DocumentStatus, number>> = { NEEDS_REVISION: 0, MISSING: 1, PENDING_REVIEW: 2 };
  const blocking = slots
    .filter((s) => s.isRequired && urgency[s.status] !== undefined)
    .sort((a, b) => urgency[a.status]! - urgency[b.status]!)
    .map((s) => {
      const who = s.party ? ` (${s.party.fullName})` : "";
      const text =
        s.status === "NEEDS_REVISION" ? `${s.name}${who}: ${s.reviewComment}`
        : s.status === "MISSING" ? `${s.name}${who} hasn't been uploaded`
        : `${s.name}${who} is waiting for review`;
      return { slotId: s.id, text };
    });

  return { status: entry.status, error: entry.error, stale: entry.stale, deal: entry.deal, groups, summary: summarize(slots), blocking };
}

export function selectUnreadCount(state: ComplianceState): number {
  return state.notifications.items.filter((n) => n.readAt === null).length;
}
