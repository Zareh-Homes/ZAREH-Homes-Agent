/**
 * The one way the app talks to the back office API.
 *   - The session cookie identifies the user; the browser sends it.
 *   - Every change carries the session's CSRF token and a fresh idempotency key.
 *   - Errors come back as ApiError with the server's code, message and field issues.
 *   - A 401 for an ended session (or MFA still needed) is announced so the app can return to sign-in.
 */

export interface FieldIssue { field: string; message: string }

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  /**
   * Field problems from a 400, keyed by the server's field path ("parties[0].fullName").
   * A nested object's problem is also filed under its parent ("payerDetails.address" → "payerDetails");
   * a list item's stays on the item, so the form shows it next to that row.
   */
  get fieldErrors(): Record<string, string> {
    const issues = (this.details?.issues ?? []) as FieldIssue[];
    const out: Record<string, string> = {};
    for (const i of issues) {
      out[i.field] ??= i.message;
      if (!i.field.includes("[")) out[i.field.split(".")[0]!] ??= i.message;
    }
    return out;
  }
}

let csrfToken: string | null = null;
export const setCsrfToken = (token: string | null) => { csrfToken = token; };

export const SESSION_ENDED = "app:session-ended";
const SESSION_GONE = new Set(["UNAUTHENTICATED", "SESSION_EXPIRED", "SESSION_INVALID", "MFA_REQUIRED", "MFA_ENROLLMENT_REQUIRED", "HTTP_401"]);

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A random UUID (v4) for idempotency keys. crypto.randomUUID only exists on https or localhost; this also works
 * when the app is opened over plain http by name or address (a local trial reached from another computer).
 */
export function newKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export async function api<T = unknown>(method: Method, path: string, body?: unknown, init: { signal?: AbortSignal; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !isForm) headers["content-type"] = "application/json";
  if (method !== "GET") {
    if (csrfToken) headers["x-csrf-token"] = csrfToken;
    headers["idempotency-key"] = init.idempotencyKey ?? newKey();
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method, headers, credentials: "same-origin", signal: init.signal,
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "NETWORK", "Can't reach the server. Check your connection and try again.");
  }
  const text = await res.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const e = (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
    const error = new ApiError(res.status, e?.code ?? `HTTP_${res.status}`, e?.message ?? `The request failed (${res.status})`, e?.details);
    // Only a missing or ended session returns to sign-in; a mistyped password or code stays on the form
    if (res.status === 401 && SESSION_GONE.has(error.code)) window.dispatchEvent(new CustomEvent(SESSION_ENDED, { detail: error }));
    throw error;
  }
  return parsed as T;
}

/** For screens that show HTML the server renders (CDA, printable records) */
export async function apiText(path: string): Promise<string> {
  const res = await fetch(path, { credentials: "same-origin" });
  const text = await res.text();
  if (!res.ok) {
    let msg = `The request failed (${res.status})`;
    try { msg = JSON.parse(text).error.message ?? msg; } catch { /* not JSON */ }
    throw new ApiError(res.status, `HTTP_${res.status}`, msg);
  }
  return text;
}

export const errorMessage = (err: unknown): string =>
  err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Something went wrong";
