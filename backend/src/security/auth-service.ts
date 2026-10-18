/**
 * Sign-in, MFA, sessions and account administration.
 *
 *   • Passwords: scrypt; 10 consecutive failures lock the account for 15 minutes.
 *     Unknown emails take the same time as wrong passwords and get the same answer.
 *   • Sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie;
 *     the database keeps only its SHA-256. 30-minute idle and 12-hour absolute
 *     expiry by default. A CSRF token is issued with each session.
 *   • MFA: TOTP, required for admin, managing broker and compliance roles.
 *     Codes can't be replayed. The session token rotates when MFA completes.
 *     Ten single-use recovery codes, stored hashed.
 *   • Accounts are created by an admin with a single-use invitation; password
 *     resets are issued by an admin and delivered out of band. Suspending a
 *     user (or changing their role) revokes their sessions in the database.
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient, UserRole } from "@prisma/client";
import { requireRole, type Actor } from "../auth.ts";
import { ConflictError, DomainError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "../errors.ts";
import { Reader } from "../lib/reader.ts";
import { audit } from "./audit.ts";
import type { SecurityConfig } from "./config.ts";
import {
  base32Decode, base32Encode, DUMMY_PASSWORD_HASH, hashPassword, newRecoveryCodes, newToken, otpauthUri, passwordProblem,
  sha256, verifyPassword, verifyTotp,
} from "./crypto.ts";

export const MAX_FAILED_ATTEMPTS = 10;
export const LOCKOUT_MINUTES = 15;
const INVITATION_HOURS = 72;
const RESET_MINUTES = 60;

export class AuthError extends DomainError {
  constructor(code: string, message: string, status = 401) {
    super(code, status, message);
  }
}

export interface RequestInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface AuthContext {
  userId: string;
  sessionId: string;
  role: UserRole;
  mfaSatisfied: boolean;
  mfaEnabled: boolean;
  csrfToken: string;
}

export interface SessionGrant {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export class AuthService {
  readonly prisma: PrismaClient;
  readonly config: SecurityConfig;
  private readonly now: () => Date;

  constructor(prisma: PrismaClient, config: SecurityConfig, now: () => Date = () => new Date()) {
    this.prisma = prisma;
    this.config = config;
    this.now = now;
  }

  mfaRequiredFor(role: UserRole) {
    return this.config.mfaRequiredRoles.includes(role);
  }

  // ── Sign in ────────────────────────────────────────────────────────────────

  async login(body: unknown, info: RequestInfo): Promise<SessionGrant & { mfa: { enabled: boolean; required: boolean } }> {
    const r = new Reader(body, ["email", "password"]);
    const email = r.text("email", 320).toLowerCase();
    const password = r.text("password", 256);
    r.done();

    const user = await this.prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, include: { credential: true } });
    const cred = user?.credential ?? null;
    const fail = async (reason: string) => {
      await audit(this.prisma, { userId: user?.id ?? null, entity: "User", entityId: user?.id ?? email, action: "LOGIN_FAILED",
        outcome: "FAILED", changes: { reason }, ...info });
      return new AuthError("INVALID_CREDENTIALS", "Email or password is incorrect");
    };
    if (!user || !cred) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      throw await fail(user ? "NO_PASSWORD_SET" : "UNKNOWN_EMAIL");
    }
    if (cred.lockedUntil && cred.lockedUntil > this.now()) {
      await audit(this.prisma, { userId: user.id, entity: "User", entityId: user.id, action: "LOGIN_LOCKED", outcome: "DENIED", ...info });
      throw new AuthError("ACCOUNT_LOCKED", `Too many failed attempts. Try again after ${cred.lockedUntil.toISOString()}, or ask an admin to reset your password.`, 423);
    }
    const ok = await verifyPassword(password, cred.passwordHash);
    if (!ok) {
      await this.recordFailure(user.id, cred.failedAttempts);
      throw await fail("WRONG_PASSWORD");
    }
    if (!user.isActive) throw await fail("ACCOUNT_SUSPENDED");

    await this.prisma.userCredential.update({ where: { userId: user.id }, data: { failedAttempts: 0, lockedUntil: null } });
    const grant = await this.createSession(user.id, info);
    await audit(this.prisma, { userId: user.id, sessionId: grant.sessionId, entity: "Session", entityId: grant.sessionId, action: "LOGIN",
      outcome: "SUCCESS", ...info });
    return { token: grant.token, csrfToken: grant.csrfToken, expiresAt: grant.expiresAt,
      mfa: { enabled: cred.mfaEnabledAt !== null, required: this.mfaRequiredFor(user.role) } };
  }

  private async recordFailure(userId: string, previous: number) {
    const attempts = previous + 1;
    await this.prisma.userCredential.update({
      where: { userId },
      data: {
        failedAttempts: attempts,
        lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? new Date(this.now().getTime() + LOCKOUT_MINUTES * 60_000) : undefined,
      },
    });
  }

  private async createSession(userId: string, info: RequestInfo) {
    const token = newToken();
    const csrfToken = newToken(24);
    const sessionId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + this.config.sessionAbsoluteHours * 3_600_000);
    await this.prisma.session.create({
      data: { id: sessionId, tokenHash: sha256(token), csrfToken, userId, expiresAt, createdAt: this.now(), lastSeenAt: this.now(),
        ip: info.ip, userAgent: info.userAgent?.slice(0, 300) },
    });
    return { token, csrfToken, expiresAt, sessionId };
  }

  /** Resolves a session cookie to who is calling. Throws on anything expired, revoked or suspended. */
  async authenticate(token: string): Promise<AuthContext> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { select: { role: true, isActive: true, credential: { select: { mfaEnabledAt: true } } } } },
    });
    const now = this.now();
    if (!session || session.revokedAt) throw new AuthError("SESSION_INVALID", "Please sign in again");
    if (session.expiresAt <= now || session.lastSeenAt.getTime() + this.config.sessionIdleMinutes * 60_000 <= now.getTime()) {
      await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: now, revokedReason: "EXPIRED" } });
      throw new AuthError("SESSION_EXPIRED", "Your session expired. Please sign in again.");
    }
    if (!session.user.isActive) throw new AuthError("SESSION_INVALID", "Please sign in again");
    if (now.getTime() - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }
    return {
      userId: session.userId,
      sessionId: session.id,
      role: session.user.role,
      mfaSatisfied: session.mfaVerifiedAt !== null,
      mfaEnabled: session.user.credential?.mfaEnabledAt != null,
      csrfToken: session.csrfToken,
    };
  }

  async logout(ctx: AuthContext, info: RequestInfo) {
    await this.prisma.session.update({ where: { id: ctx.sessionId }, data: { revokedAt: this.now(), revokedReason: "LOGOUT" } });
    await audit(this.prisma, { userId: ctx.userId, sessionId: ctx.sessionId, entity: "Session", entityId: ctx.sessionId, action: "LOGOUT",
      outcome: "SUCCESS", ...info });
  }

  /** New token for the same session (after MFA), so a token seen before sign-in completed is useless. */
  private async rotate(sessionId: string, data: { mfaVerifiedAt?: Date }) {
    const token = newToken();
    await this.prisma.session.update({ where: { id: sessionId }, data: { tokenHash: sha256(token), ...data } });
    return token;
  }

  // ── MFA ────────────────────────────────────────────────────────────────────

  async startEnrollment(ctx: AuthContext) {
    const cred = await this.prisma.userCredential.findUnique({ where: { userId: ctx.userId }, include: { user: { select: { email: true } } } });
    if (!cred) throw new NotFoundError("Credential", ctx.userId);
    if (cred.mfaEnabledAt) throw new ConflictError("MFA_ALREADY_ENABLED", "Two-factor sign-in is already set up");
    const secret = base32Encode(Buffer.from(newToken(20), "base64url").subarray(0, 20));
    await this.prisma.userCredential.update({ where: { userId: ctx.userId }, data: { mfaSecretEnc: this.config.fieldCipher.encrypt(secret) } });
    return { secret, otpauthUri: otpauthUri(secret, cred.user.email, this.config.issuer) };
  }

  async confirmEnrollment(ctx: AuthContext, body: unknown, info: RequestInfo) {
    const code = this.readCode(body);
    const cred = await this.prisma.userCredential.findUniqueOrThrow({ where: { userId: ctx.userId } });
    if (cred.mfaEnabledAt) throw new ConflictError("MFA_ALREADY_ENABLED", "Two-factor sign-in is already set up");
    if (!cred.mfaSecretEnc) throw new AuthError("MFA_NOT_STARTED", "Start two-factor setup first", 422);
    const step = verifyTotp(base32Decode(this.config.fieldCipher.decrypt(cred.mfaSecretEnc)), code, this.now().getTime());
    if (step === null) {
      await this.recordFailure(ctx.userId, cred.failedAttempts);
      throw new AuthError("MFA_CODE_INVALID", "That code didn't match. Check your authenticator app's time and try again.");
    }
    const codes = newRecoveryCodes();
    await this.prisma.userCredential.update({
      where: { userId: ctx.userId },
      data: { mfaEnabledAt: this.now(), mfaLastStep: BigInt(step), failedAttempts: 0, recoveryCodeHashes: codes.map((c) => sha256(c)) },
    });
    const token = await this.rotate(ctx.sessionId, { mfaVerifiedAt: this.now() });
    await audit(this.prisma, { userId: ctx.userId, sessionId: ctx.sessionId, entity: "UserCredential", entityId: ctx.userId,
      action: "MFA_ENROLLED", outcome: "SUCCESS", ...info });
    return { token, recoveryCodes: codes };
  }

  async verifyMfa(ctx: AuthContext, body: unknown, info: RequestInfo) {
    const r = new Reader(body, ["code", "recoveryCode"]);
    const code = r.optionalText("code", 10);
    const recovery = r.optionalText("recoveryCode", 20);
    r.check((code === null) !== (recovery === null), "code", "give either code or recoveryCode");
    r.done();
    const cred = await this.prisma.userCredential.findUniqueOrThrow({ where: { userId: ctx.userId } });
    if (!cred.mfaEnabledAt || !cred.mfaSecretEnc) throw new AuthError("MFA_NOT_ENABLED", "Set up two-factor sign-in first", 422);
    if (cred.lockedUntil && cred.lockedUntil > this.now()) throw new AuthError("ACCOUNT_LOCKED", "Too many failed attempts", 423);

    let ok = false;
    let lastStep = cred.mfaLastStep;
    let recoveryHashes = cred.recoveryCodeHashes;
    if (code) {
      const step = verifyTotp(base32Decode(this.config.fieldCipher.decrypt(cred.mfaSecretEnc)), code, this.now().getTime());
      // Same or earlier step than the last accepted one = a replayed code
      ok = step !== null && (cred.mfaLastStep === null || BigInt(step) > cred.mfaLastStep);
      if (ok) lastStep = BigInt(step!);
    } else {
      const h = sha256(recovery!.toUpperCase());
      ok = recoveryHashes.includes(h);
      if (ok) recoveryHashes = recoveryHashes.filter((x) => x !== h);
    }
    if (!ok) {
      await this.recordFailure(ctx.userId, cred.failedAttempts);
      await audit(this.prisma, { userId: ctx.userId, sessionId: ctx.sessionId, entity: "Session", entityId: ctx.sessionId,
        action: "MFA_FAILED", outcome: "FAILED", ...info });
      throw new AuthError("MFA_CODE_INVALID", "That code didn't match");
    }
    await this.prisma.userCredential.update({
      where: { userId: ctx.userId }, data: { mfaLastStep: lastStep, recoveryCodeHashes: recoveryHashes, failedAttempts: 0 },
    });
    const token = await this.rotate(ctx.sessionId, { mfaVerifiedAt: this.now() });
    await audit(this.prisma, { userId: ctx.userId, sessionId: ctx.sessionId, entity: "Session", entityId: ctx.sessionId,
      action: recovery ? "MFA_RECOVERY_CODE_USED" : "MFA_VERIFIED", outcome: "SUCCESS", ...info });
    return { token, recoveryCodesLeft: recoveryHashes.length };
  }

  private readCode(body: unknown) {
    const r = new Reader(body, ["code"]);
    const code = r.text("code", 10);
    r.done();
    return code;
  }

  // ── Self-service ───────────────────────────────────────────────────────────

  async me(ctx: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    return {
      id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, role: user.role,
      mfa: { enabled: ctx.mfaEnabled, satisfied: ctx.mfaSatisfied, required: this.mfaRequiredFor(user.role) },
      csrfToken: ctx.csrfToken,
    };
  }

  async listSessions(ctx: AuthContext) {
    const rows = await this.prisma.session.findMany({
      where: { userId: ctx.userId, revokedAt: null, expiresAt: { gt: this.now() } }, orderBy: { lastSeenAt: "desc" },
    });
    return rows.map((s) => ({ id: s.id, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, ip: s.ip, userAgent: s.userAgent, current: s.id === ctx.sessionId }));
  }

  async revokeSession(ctx: AuthContext, sessionId: string, info: RequestInfo) {
    const n = await this.prisma.session.updateMany({
      where: { id: sessionId, userId: ctx.userId, revokedAt: null }, data: { revokedAt: this.now(), revokedReason: "REVOKED_BY_USER" },
    });
    if (n.count === 0) throw new NotFoundError("Session", sessionId);
    await audit(this.prisma, { userId: ctx.userId, sessionId: ctx.sessionId, entity: "Session", entityId: sessionId, action: "SESSION_REVOKED",
      outcome: "SUCCESS", ...info });
  }

  async changePassword(ctx: AuthContext, body: unknown, info: RequestInfo) {
    const r = new Reader(body, ["currentPassword", "newPassword"]);
    const current = r.text("currentPassword", 256);
    const next = r.text("newPassword", 256);
    r.done();
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId }, include: { credential: true } });
    if (!user.credential || !(await verifyPassword(current, user.credential.passwordHash))) {
      await this.recordFailure(ctx.userId, user.credential?.failedAttempts ?? 0);
      throw new AuthError("INVALID_CREDENTIALS", "Current password is incorrect");
    }
    const problem = passwordProblem(next, user.email);
    if (problem) throw new ValidationError([{ field: "newPassword", message: problem }]);
    await this.prisma.$transaction([
      this.prisma.userCredential.update({ where: { userId: ctx.userId }, data: { passwordHash: await hashPassword(next), passwordChangedAt: this.now() } }),
      this.prisma.session.updateMany({ where: { userId: ctx.userId, revokedAt: null, id: { not: ctx.sessionId } },
        data: { revokedAt: this.now(), revokedReason: "PASSWORD_CHANGED" } }),
    ]);
    await audit(this.prisma, { userId: ctx.userId, sessionId: ctx.sessionId, entity: "UserCredential", entityId: ctx.userId,
      action: "PASSWORD_CHANGED", outcome: "SUCCESS", ...info });
  }

  // ── Account administration (admin only) ────────────────────────────────────

  private async issueToken(userId: string, purpose: "INVITATION" | "PASSWORD_RESET", actorId: string) {
    const token = newToken();
    const minutes = purpose === "INVITATION" ? INVITATION_HOURS * 60 : RESET_MINUTES;
    await this.prisma.$transaction([
      this.prisma.authToken.updateMany({ where: { userId, purpose, usedAt: null }, data: { usedAt: this.now() } }), // older links stop working
      this.prisma.authToken.create({
        data: { id: randomUUID(), userId, purpose, tokenHash: sha256(token), expiresAt: new Date(this.now().getTime() + minutes * 60_000), createdById: actorId },
      }),
    ]);
    return { token, expiresInMinutes: minutes };
  }

  async createUser(actor: Actor, body: unknown, info: RequestInfo) {
    requireRole(actor, ["ADMIN"], "Creating a user");
    const r = new Reader(body, ["email", "firstName", "lastName", "role", "phone"]);
    const input = {
      email: r.text("email", 320).toLowerCase(),
      firstName: r.text("firstName", 100),
      lastName: r.text("lastName", 100),
      role: r.oneOf("role", ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN", "AGENT"] as const),
      phone: r.optionalText("phone", 40),
    };
    r.check(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email), "email", "must be an email address");
    r.done();
    const exists = await this.prisma.user.findFirst({ where: { email: { equals: input.email, mode: "insensitive" } } });
    if (exists) throw new ConflictError("EMAIL_IN_USE", "A user with that email already exists");
    const user = await this.prisma.user.create({ data: input });
    const invite = await this.issueToken(user.id, "INVITATION", actor.id);
    await audit(this.prisma, { userId: actor.id, entity: "User", entityId: user.id, action: "USER_CREATED", outcome: "SUCCESS",
      changes: { role: input.role }, ...info });
    return { userId: user.id, invitationToken: invite.token, expiresInMinutes: invite.expiresInMinutes };
  }

  /** Sets the password from an invitation or reset link. Revokes existing sessions. */
  async redeemToken(purpose: "INVITATION" | "PASSWORD_RESET", body: unknown, info: RequestInfo) {
    const r = new Reader(body, ["token", "password"]);
    const token = r.text("token", 200);
    const password = r.text("password", 256);
    r.done();
    const row = await this.prisma.authToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt <= this.now() || !row.user.isActive) {
      throw new AuthError("TOKEN_INVALID", "This link is invalid or has expired. Ask an admin for a new one.", 400);
    }
    const problem = passwordProblem(password, row.user.email);
    if (problem) throw new ValidationError([{ field: "password", message: problem }]);
    const passwordHash = await hashPassword(password);
    await this.prisma.$transaction([
      this.prisma.authToken.update({ where: { id: row.id }, data: { usedAt: this.now() } }),
      this.prisma.userCredential.upsert({
        where: { userId: row.userId },
        create: { userId: row.userId, passwordHash },
        update: { passwordHash, passwordChangedAt: this.now(), failedAttempts: 0, lockedUntil: null },
      }),
      this.prisma.session.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: this.now(), revokedReason: "PASSWORD_SET" } }),
    ]);
    await audit(this.prisma, { userId: row.userId, entity: "UserCredential", entityId: row.userId,
      action: purpose === "INVITATION" ? "INVITATION_ACCEPTED" : "PASSWORD_RESET", outcome: "SUCCESS", ...info });
  }

  async issuePasswordReset(actor: Actor, userId: string, info: RequestInfo) {
    requireRole(actor, ["ADMIN"], "Issuing a password reset");
    if (actor.id === userId) throw new ForbiddenError("Use change password for your own account");
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("User", userId);
    const reset = await this.issueToken(userId, "PASSWORD_RESET", actor.id);
    await audit(this.prisma, { userId: actor.id, entity: "User", entityId: userId, action: "PASSWORD_RESET_ISSUED", outcome: "SUCCESS", ...info });
    return { resetToken: reset.token, expiresInMinutes: reset.expiresInMinutes };
  }

  async resetMfa(actor: Actor, userId: string, info: RequestInfo) {
    requireRole(actor, ["ADMIN"], "Resetting two-factor sign-in");
    if (actor.id === userId) throw new ForbiddenError("Another admin must reset your two-factor sign-in");
    await this.prisma.$transaction([
      this.prisma.userCredential.update({ where: { userId }, data: { mfaSecretEnc: null, mfaEnabledAt: null, mfaLastStep: null, recoveryCodeHashes: [] } }),
      this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: this.now(), revokedReason: "MFA_RESET" } }),
    ]);
    await audit(this.prisma, { userId: actor.id, entity: "User", entityId: userId, action: "MFA_RESET", outcome: "SUCCESS", ...info });
  }

  async setActive(actor: Actor, userId: string, active: boolean, info: RequestInfo) {
    requireRole(actor, ["ADMIN"], active ? "Reactivating a user" : "Suspending a user");
    if (actor.id === userId) throw new ForbiddenError("You can't suspend your own account");
    const n = await this.prisma.user.updateMany({ where: { id: userId }, data: { isActive: active } });
    if (n.count === 0) throw new NotFoundError("User", userId);
    await audit(this.prisma, { userId: actor.id, entity: "User", entityId: userId, action: active ? "USER_REACTIVATED" : "USER_SUSPENDED",
      outcome: "SUCCESS", ...info });
  }
}

export { UnauthenticatedError };
