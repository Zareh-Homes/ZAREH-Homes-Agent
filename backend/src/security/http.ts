/**
 * HTTP security layer, registered on every app:
 *
 *   • Security headers on every response (nosniff, no framing, no referrer,
 *     strict CSP for API responses, HSTS when cookies are Secure, no-store).
 *   • Rate limits: sign-in endpoints per IP and per email; the whole API per
 *     caller. In-process; behind more than one server, use a shared store.
 *   • Audit: every state-changing request, and every read of identification,
 *     banking or trust records, is written to the AuditLog with its outcome.
 *
 * In session mode it also resolves the session cookie, enforces CSRF on
 * state-changing requests, and holds privileged users at the MFA step until
 * they complete it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { DomainError } from "../errors.ts";
import { audit, isSensitiveRead } from "./audit.ts";
import { AuthError, type AuthContext, type AuthService } from "./auth-service.ts";
import { constantTimeEqual } from "./crypto.ts";

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export const SESSION_COOKIE = "zh_session";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, opts: { secure: boolean; maxAgeSeconds: number }): string {
  return [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${opts.maxAgeSeconds}`,
    ...(opts.secure ? ["Secure"] : [])].join("; ");
}

export const clearSessionCookie = (secure: boolean) =>
  [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0", ...(secure ? ["Secure"] : [])].join("; ");

export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  /** true if allowed */
  hit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const w = this.hits.get(key);
    if (!w || w.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowMs });
      if (this.hits.size > 50_000) this.sweep(now);
      return true;
    }
    w.count++;
    return w.count <= limit;
  }

  private sweep(now: number) {
    for (const [k, w] of this.hits) if (w.resetAt <= now) this.hits.delete(k);
  }
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Reached before a session exists (or to finish MFA), so no CSRF token or MFA yet */
const PRE_SESSION = ["/api/auth/login", "/api/auth/invitations/accept", "/api/auth/password-resets/complete"];
const MFA_STEP = ["/api/auth/mfa/", "/api/auth/me", "/api/auth/logout"];

const requestInfo = (request: FastifyRequest) => ({ ip: request.ip ?? null, userAgent: (request.headers["user-agent"] as string | undefined) ?? null });

export interface HttpSecurityOptions {
  prisma: PrismaClient;
  auth: AuthService | null; // null = development header mode (tests)
  cookieSecure: boolean;
  allowedOrigins: string[];
  limits?: Partial<{ loginPerMinutePerIp: number; loginPerMinutePerEmail: number; apiPerMinute: number }>;
}

export function registerHttpSecurity(app: FastifyInstance, opts: HttpSecurityOptions) {
  const limiter = new FixedWindowLimiter();
  const limits = { loginPerMinutePerIp: 20, loginPerMinutePerEmail: 5, apiPerMinute: 600, ...opts.limits };
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url.split("?")[0]!;
    if (!limiter.hit(`api:${request.ip}`, limits.apiPerMinute, 60_000)) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests. Slow down and try again shortly." } });
    }
    if (path === "/api/auth/login" && !limiter.hit(`login-ip:${request.ip}`, limits.loginPerMinutePerIp, 60_000)) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many sign-in attempts. Wait a minute and try again." } });
    }
    if (!opts.auth) return;

    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token) {
      try {
        request.auth = await opts.auth.authenticate(token);
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        reply.header("set-cookie", clearSessionCookie(opts.cookieSecure));
        if (!PRE_SESSION.includes(path)) {
          return reply.code(401).send({ error: { code: err.code, message: err.message } });
        }
      }
    }

    if (request.auth && UNSAFE.has(request.method) && !PRE_SESSION.includes(path)) {
      // CSRF: the cookie alone is never enough to change anything
      const origin = request.headers.origin;
      if (origin && opts.allowedOrigins.length > 0 && !opts.allowedOrigins.includes(origin)) {
        return reply.code(403).send({ error: { code: "CSRF_ORIGIN", message: "Request origin not allowed" } });
      }
      const sent = request.headers["x-csrf-token"];
      if (typeof sent !== "string" || !constantTimeEqual(sent, request.auth.csrfToken)) {
        return reply.code(403).send({ error: { code: "CSRF_TOKEN", message: "Missing or invalid CSRF token" } });
      }
    }

    // Signing in and using a link don't act on the current session, so a half-finished sign-in in the same
    // browser (someone else's, or one abandoned before two-factor) mustn't block them
    if (request.auth && !request.auth.mfaSatisfied && opts.auth.mfaRequiredFor(request.auth.role)
        && !MFA_STEP.some((p) => path.startsWith(p)) && !PRE_SESSION.includes(path)) {
      return reply.code(401).send({
        error: {
          code: request.auth.mfaEnabled ? "MFA_REQUIRED" : "MFA_ENROLLMENT_REQUIRED",
          message: request.auth.mfaEnabled ? "Enter your authenticator code to continue" : "Set up two-factor sign-in to continue",
        },
      });
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const h = reply.getHeaders();
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-resource-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (!h["content-security-policy"]) reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    if (!h["cache-control"] && request.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    if (opts.cookieSecure) reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    return payload;
  });

  // Written before the response goes out, so a sensitive read is never served without its audit record
  app.addHook("onSend", async (request, reply, payload) => {
    const url = request.url.split("?")[0]!;
    if (!url.startsWith("/api/") || url.startsWith("/api/auth/")) return payload; // auth routes write their own events
    if (!UNSAFE.has(request.method) && !isSensitiveRead(url)) return payload;
    const status = reply.statusCode;
    const claimed = request.auth?.userId ?? (request.headers["x-user-id"] as string | undefined) ?? null;
    try {
      await audit(opts.prisma, {
        userId: claimed,
        sessionId: request.auth?.sessionId ?? null,
        entity: "API",
        entityId: url.slice(0, 200),
        action: `${request.method} ${request.routeOptions?.url ?? url}`,
        outcome: status < 400 ? "SUCCESS" : status === 401 || status === 403 ? "DENIED" : status >= 500 ? "ERROR" : "FAILED",
        changes: { params: request.params ?? null, status, ...(request.auth ? {} : claimed ? { claimedUserId: claimed } : {}) },
        route: request.routeOptions?.url ?? null,
        ...requestInfo(request),
      });
    } catch (err) {
      request.log.error({ err }, "audit write failed");
    }
    return payload;
  });

  if (opts.auth) registerAuthRoutes(app, opts.auth, opts, limiter, limits);
}

function registerAuthRoutes(
  app: FastifyInstance, auth: AuthService, opts: HttpSecurityOptions, limiter: FixedWindowLimiter,
  limits: Required<NonNullable<HttpSecurityOptions["limits"]>>,
) {
  const maxAge = auth.config.sessionAbsoluteHours * 3600;
  const ctx = (request: FastifyRequest): AuthContext => {
    if (!request.auth) throw new AuthError("UNAUTHENTICATED", "Please sign in");
    return request.auth;
  };
  const actor = (request: FastifyRequest) => ({ id: ctx(request).userId, role: ctx(request).role });
  const setCookie = (reply: FastifyReply, token: string) => reply.header("set-cookie", sessionCookie(token, { secure: opts.cookieSecure, maxAgeSeconds: maxAge }));

  app.post("/api/auth/login", async (request, reply) => {
    const email = String((request.body as { email?: unknown } | null)?.email ?? "").toLowerCase();
    if (email && !limiter.hit(`login-email:${email}`, limits.loginPerMinutePerEmail, 60_000)) {
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many sign-in attempts for this account. Wait a minute." } });
    }
    const result = await auth.login(request.body, requestInfo(request));
    setCookie(reply, result.token);
    return { csrfToken: result.csrfToken, expiresAt: result.expiresAt, mfa: result.mfa };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    await auth.logout(ctx(request), requestInfo(request));
    reply.header("set-cookie", clearSessionCookie(opts.cookieSecure));
    return { signedOut: true };
  });

  app.get("/api/auth/me", async (request) => auth.me(ctx(request)));

  app.post("/api/auth/mfa/enroll", async (request) => auth.startEnrollment(ctx(request)));

  app.post("/api/auth/mfa/enroll/confirm", async (request, reply) => {
    const { token, recoveryCodes } = await auth.confirmEnrollment(ctx(request), request.body, requestInfo(request));
    setCookie(reply, token);
    return { enabled: true, recoveryCodes, note: "Store these recovery codes somewhere safe. Each works once, and they won't be shown again." };
  });

  app.post("/api/auth/mfa/verify", async (request, reply) => {
    const { token, recoveryCodesLeft } = await auth.verifyMfa(ctx(request), request.body, requestInfo(request));
    setCookie(reply, token);
    return { verified: true, recoveryCodesLeft };
  });

  app.get("/api/auth/sessions", async (request) => ({ sessions: await auth.listSessions(ctx(request)) }));

  app.post<{ Params: { id: string } }>("/api/auth/sessions/:id/revoke", async (request) => {
    await auth.revokeSession(ctx(request), request.params.id, requestInfo(request));
    return { revoked: request.params.id };
  });

  app.post("/api/auth/password", async (request) => {
    await auth.changePassword(ctx(request), request.body, requestInfo(request));
    return { changed: true };
  });

  app.post("/api/auth/invitations/accept", async (request) => {
    await auth.redeemToken("INVITATION", request.body, requestInfo(request));
    return { passwordSet: true };
  });

  app.post("/api/auth/password-resets/complete", async (request) => {
    await auth.redeemToken("PASSWORD_RESET", request.body, requestInfo(request));
    return { passwordSet: true };
  });

  // Account administration: admin only, never for yourself where it matters
  app.post("/api/users", async (request, reply) => reply.code(201).send(await auth.createUser(actor(request), request.body, requestInfo(request))));
  app.post<{ Params: { id: string } }>("/api/users/:id/password-reset", async (request) =>
    auth.issuePasswordReset(actor(request), request.params.id, requestInfo(request)));
  app.post<{ Params: { id: string } }>("/api/users/:id/mfa-reset", async (request) => {
    await auth.resetMfa(actor(request), request.params.id, requestInfo(request));
    return { reset: true };
  });
  app.post<{ Params: { id: string } }>("/api/users/:id/suspend", async (request) => {
    await auth.setActive(actor(request), request.params.id, false, requestInfo(request));
    return { suspended: true };
  });
  app.post<{ Params: { id: string } }>("/api/users/:id/reactivate", async (request) => {
    await auth.setActive(actor(request), request.params.id, true, requestInfo(request));
    return { reactivated: true };
  });
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}
