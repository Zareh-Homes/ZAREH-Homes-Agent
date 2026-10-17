/** Thin client for the compliance endpoints. `fetch` and `EventSource` are injectable for tests. */

import {
  ApiError,
  type DealDocuments,
  type NotificationView,
  type ReviewResult,
  type UploadResult,
} from "./types.ts";

export interface ComplianceApi {
  getDealDocuments(dealId: string): Promise<DealDocuments>;
  uploadDocument(slotId: string, file: Blob, fileName: string, metadata?: unknown): Promise<UploadResult>;
  reviewDocument(
    slotId: string,
    body: { decision: "APPROVED" | "NEEDS_REVISION"; comment?: string; fileId: string },
  ): Promise<ReviewResult>;
  listNotifications(unreadOnly: boolean): Promise<NotificationView[]>;
  markNotificationRead(id: string): Promise<NotificationView>;
  /** Opens the live stream; returns a function that closes it. */
  subscribeNotifications(handlers: {
    onNotification: (n: NotificationView) => void;
    onConnectionChange: (connected: boolean) => void;
  }): () => void;
}

interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface HttpApiOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Browsers send the session cookie automatically; EventSource can't set headers. */
  createEventSource?: (url: string) => EventSourceLike;
}

async function parse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new ApiError(res.status, e.code ?? "HTTP_ERROR", e.message ?? res.statusText, e.details);
  }
  return body as T;
}

export function createHttpApi(opts: HttpApiOptions = {}): ComplianceApi {
  const base = opts.baseUrl ?? "";
  const http = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const json = (method: string, path: string, body?: unknown) =>
    http(`${base}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  return {
    async getDealDocuments(dealId) {
      return parse(await json("GET", `/api/deals/${dealId}/documents`));
    },

    async uploadDocument(slotId, file, fileName, metadata) {
      const form = new FormData();
      // Metadata first, so the server sees it before the (possibly large) file
      if (metadata !== undefined) form.append("metadata", JSON.stringify(metadata));
      form.append("file", file, fileName);
      return parse(await http(`${base}/api/documents/slots/${slotId}/files`, {
        method: "POST",
        credentials: "include",
        body: form,
      }));
    },

    async reviewDocument(slotId, body) {
      return parse(await json("POST", `/api/documents/slots/${slotId}/review`, body));
    },

    async listNotifications(unreadOnly) {
      return parse(await json("GET", `/api/notifications${unreadOnly ? "?unread=true" : ""}`));
    },

    async markNotificationRead(id) {
      return parse(await json("POST", `/api/notifications/${id}/read`));
    },

    subscribeNotifications({ onNotification, onConnectionChange }) {
      const create = opts.createEventSource
        ?? ((url: string) => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike);
      const source = create(`${base}/api/notifications/stream`);
      source.addEventListener("ready", () => onConnectionChange(true));
      source.addEventListener("notification", (e) => onNotification(JSON.parse(e.data)));
      source.onerror = () => onConnectionChange(false); // EventSource reconnects by itself
      return () => {
        source.close();
        onConnectionChange(false);
      };
    },
  };
}
