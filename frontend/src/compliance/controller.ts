/**
 * Wires the reducer to the API: a tiny observable store plus the async
 * actions screens call. Framework-agnostic; in React:
 *
 *   const state = useSyncExternalStore(store.subscribe, store.getState);
 *   const checklist = selectChecklist(state, dealId);
 */

import type { ComplianceApi } from "./api.ts";
import { complianceReducer, initialState, type Action, type ComplianceState, type OperationError } from "./state.ts";
import { ApiError, type ReviewResult, type UploadResult, type Viewer } from "./types.ts";

export interface Store {
  getState(): ComplianceState;
  dispatch(action: Action): void;
  subscribe(listener: () => void): () => void;
}

export function createStore(initial: ComplianceState = initialState): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = complianceReducer(state, action);
      if (next === state) return;
      state = next;
      for (const l of listeners) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function toOperationError(err: unknown): OperationError {
  if (err instanceof ApiError) return { message: err.message, code: err.code, fieldErrors: err.fieldErrors };
  return { message: "Couldn't reach the server. Check your connection and try again.", code: "NETWORK", fieldErrors: {} };
}

const MIN_REVISION_COMMENT = 10;

export function createComplianceController(deps: { api: ComplianceApi; store: Store; viewer: Viewer }) {
  const { api, store } = deps;
  const inFlight = new Map<string, Promise<void>>();

  async function loadDeal(dealId: string): Promise<void> {
    const pending = inFlight.get(dealId);
    if (pending) return pending; // one request per deal at a time
    const run = (async () => {
      store.dispatch({ type: "deal/loadStarted", dealId });
      try {
        store.dispatch({ type: "deal/loaded", docs: await api.getDealDocuments(dealId) });
      } catch (err) {
        store.dispatch({ type: "deal/loadFailed", dealId, error: toOperationError(err).message });
      } finally {
        inFlight.delete(dealId);
      }
    })();
    inFlight.set(dealId, run);
    return run;
  }

  async function upload(slotId: string, file: Blob, fileName: string, metadata?: unknown): Promise<UploadResult | null> {
    store.dispatch({ type: "slot/uploadStarted", slotId });
    try {
      const result = await api.uploadDocument(slotId, file, fileName, metadata);
      store.dispatch({ type: "slot/uploadSucceeded", result });
      return result;
    } catch (err) {
      store.dispatch({ type: "slot/uploadFailed", slotId, error: toOperationError(err) });
      return null;
    }
  }

  async function review(
    slotId: string,
    decision: "APPROVED" | "NEEDS_REVISION",
    comment?: string,
  ): Promise<ReviewResult | null> {
    const slot = store.getState().slots[slotId];
    // Same rules the server enforces, checked first so the reviewer gets instant feedback
    const trimmed = comment?.trim() ?? "";
    if (decision === "NEEDS_REVISION" && trimmed.length < MIN_REVISION_COMMENT) {
      store.dispatch({
        type: "slot/reviewFailed",
        slotId,
        error: {
          message: "Say what needs fixing so the agent can act on it",
          code: "VALIDATION_FAILED",
          fieldErrors: { comment: `At least ${MIN_REVISION_COMMENT} characters, e.g. "FINTRAC ID expired"` },
        },
      });
      return null;
    }
    if (!slot?.latestFile) return null;

    store.dispatch({ type: "slot/reviewStarted", slotId });
    try {
      const result = await api.reviewDocument(slotId, {
        decision,
        fileId: slot.latestFile.id, // reviews exactly the version on screen
        ...(trimmed ? { comment: trimmed } : {}),
      });
      store.dispatch({ type: "slot/reviewSucceeded", result });
      return result;
    } catch (err) {
      const error = toOperationError(err);
      store.dispatch({ type: "slot/reviewFailed", slotId, error });
      // Someone uploaded a newer version: refresh so the reviewer sees it
      if (error.code === "STALE_REVIEW" || error.code === "NOT_PENDING_REVIEW") void loadDeal(slot.dealId);
      return null;
    }
  }

  /** Loads unread notifications and listens for new ones. Returns a stop function. */
  async function startNotifications(): Promise<() => void> {
    try {
      store.dispatch({ type: "notifications/loaded", items: await api.listNotifications(true) });
    } catch {
      // the live stream below still works; the list fills in as events arrive
    }
    return api.subscribeNotifications({
      onConnectionChange: (connected) => store.dispatch({ type: "notifications/connection", connected }),
      onNotification: (notification) => {
        store.dispatch({ type: "notifications/received", notification });
        // Refresh the checklist if it's on screen
        if (notification.dealId && store.getState().deals[notification.dealId]) void loadDeal(notification.dealId);
      },
    });
  }

  async function markRead(id: string): Promise<void> {
    try {
      store.dispatch({ type: "notifications/markedRead", notification: await api.markNotificationRead(id) });
    } catch {
      // harmless: it stays unread
    }
  }

  return { loadDeal, upload, review, startNotifications, markRead };
}
