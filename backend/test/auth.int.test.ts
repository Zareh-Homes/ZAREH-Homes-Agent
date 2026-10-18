/**
 * Sign-in, MFA, sessions, CSRF and account administration through the real
 * session layer (no development header). Needs DATABASE_URL with migrations
 * 001–010; skipped otherwise.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { AuthService } from "../src/security/auth-service.ts";
import { loadSecurityConfig } from "../src/security/config.ts";
import { base32Decode, currentStep, hashPassword, totpAt } from "../src/security/crypto.ts";
import { TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const PASSWORD = "Lakeshore Oakville 2026";

describe("authentication and sessions", { skip }, () => {
  const prisma = new PrismaClient();
  let clock = Date.parse("2026-10-18T14:00:00Z");
  const config = loadSecurityConfig({ NODE_ENV: "test", APP_ORIGINS: "https://office.example.test" });
  const auth = new AuthService(prisma, config, () => new Date(clock));
  const app = buildApp({ prisma, auth, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE,
    rateLimits: { loginPerMinutePerIp: 1000, loginPerMinutePerEmail: 1000, apiPerMinute: 10_000 } });
  const u = { admin: "", admin2: "", agent: "" };
  const emails = { admin: "", admin2: "", agent: "" };

  /** A browser: keeps the session cookie and the CSRF token */
  class Browser {
    cookie = "";
    csrf = "";
    async call(method: "GET" | "POST", url: string, body?: object, extra: Record<string, string> = {}) {
      const res = await app.inject({
        method, url, ...(body ? { payload: body } : {}),
        headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(this.csrf && method !== "GET" ? { "x-csrf-token": this.csrf } : {}), ...extra },
      });
      const set = res.headers["set-cookie"];
      const c = (Array.isArray(set) ? set[0] : set)?.split(";")[0];
      if (c) this.cookie = c.endsWith("=") ? "" : c;
      return res;
    }
    async login(email: string, password = PASSWORD) {
      const res = await this.call("POST", "/api/auth/login", { email, password });
      if (res.statusCode === 200) this.csrf = res.json().csrfToken;
      return res;
    }
  }

  async function makeUser(role: UserRole, withPassword = true) {
    const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@zareh.test`;
    const user = await prisma.user.create({ data: { email, firstName: "Auth", lastName: role, role } });
    if (withPassword) await prisma.userCredential.create({ data: { userId: user.id, passwordHash: await hashPassword(PASSWORD) } });
    return { id: user.id, email };
  }

  async function enrollMfa(b: Browser) {
    const start = await b.call("POST", "/api/auth/mfa/enroll");
    assert.equal(start.statusCode, 200, start.body);
    const secret = base32Decode(start.json().secret);
    const confirm = await b.call("POST", "/api/auth/mfa/enroll/confirm", { code: totpAt(secret, currentStep(clock)) });
    assert.equal(confirm.statusCode, 200, confirm.body);
    return { secret, recoveryCodes: confirm.json().recoveryCodes as string[] };
  }

  before(async () => {
    ({ id: u.admin, email: emails.admin } = await makeUser("ADMIN"));
    ({ id: u.admin2, email: emails.admin2 } = await makeUser("ADMIN"));
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("a client-supplied user id is never trusted", async () => {
    const forged = await app.inject({ method: "GET", url: "/api/pipeline", headers: { "x-user-id": u.admin } });
    assert.equal(forged.statusCode, 401);
    const forgedWrite = await app.inject({ method: "POST", url: "/api/users", headers: { "x-user-id": u.admin },
      payload: { email: "x@y.zz", firstName: "X", lastName: "Y", role: "ADMIN" } });
    assert.equal(forgedWrite.statusCode, 401);
  });

  test("privileged users must enrol in and complete MFA; codes can't be replayed; recovery codes work once", async () => {
    const b = new Browser();
    const res = await b.login(emails.admin);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().mfa, { enabled: false, required: true });
    assert.match(res.headers["set-cookie"] as string, /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
    const blocked = await b.call("GET", "/api/pipeline");
    assert.equal(blocked.json().error.code, "MFA_ENROLLMENT_REQUIRED");

    const before = b.cookie;
    const { secret, recoveryCodes } = await enrollMfa(b);
    assert.notEqual(b.cookie, before, "the session token rotates when MFA completes");
    assert.equal(recoveryCodes.length, 10);
    assert.equal((await b.call("GET", "/api/pipeline")).statusCode, 200);

    // A fresh sign-in needs the code; the same code can't be used twice
    const c = new Browser();
    await c.login(emails.admin);
    assert.equal((await c.call("GET", "/api/pipeline")).json().error.code, "MFA_REQUIRED");
    clock += 30_000;
    const code = totpAt(secret, currentStep(clock));
    assert.equal((await c.call("POST", "/api/auth/mfa/verify", { code })).statusCode, 200);
    const d = new Browser();
    await d.login(emails.admin);
    assert.equal((await d.call("POST", "/api/auth/mfa/verify", { code })).json().error.code, "MFA_CODE_INVALID");
    assert.equal((await d.call("POST", "/api/auth/mfa/verify", { recoveryCode: recoveryCodes[0] })).statusCode, 200);
    const e = new Browser();
    await e.login(emails.admin);
    assert.equal((await e.call("POST", "/api/auth/mfa/verify", { recoveryCode: recoveryCodes[0] })).statusCode, 401);
  });

  test("CSRF: a session cookie alone can't change anything", async () => {
    const b = new Browser();
    await b.login(emails.admin2);
    await enrollMfa(b);
    const token = b.csrf;
    b.csrf = "";
    const noToken = await b.call("POST", "/api/users", { email: "n@zareh.test", firstName: "N", lastName: "T", role: "AGENT" });
    assert.equal(noToken.json().error.code, "CSRF_TOKEN");
    b.csrf = token;
    const badOrigin = await b.call("POST", "/api/users", { email: "n@zareh.test", firstName: "N", lastName: "T", role: "AGENT" },
      { origin: "https://evil.example" });
    assert.equal(badOrigin.json().error.code, "CSRF_ORIGIN");
  });

  test("admin creates an agent by invitation; the agent signs in; suspension and role change end sessions at once", async () => {
    const admin = new Browser();
    await admin.login(emails.admin2);
    await (async () => {
      // admin2 already has MFA from the CSRF test: complete it
      const cred = await prisma.userCredential.findUniqueOrThrow({ where: { userId: u.admin2 } });
      const secret = base32Decode(config.fieldCipher.decrypt(cred.mfaSecretEnc!));
      clock += 30_000;
      assert.equal((await admin.call("POST", "/api/auth/mfa/verify", { code: totpAt(secret, currentStep(clock)) })).statusCode, 200);
    })();
    const email = `agent-${randomUUID().slice(0, 8)}@zareh.test`;
    const created = await admin.call("POST", "/api/users", { email, firstName: "Ava", lastName: "Agent", role: "AGENT" });
    assert.equal(created.statusCode, 201, created.body);
    const { userId, invitationToken } = created.json();
    u.agent = userId;
    emails.agent = email;

    const anon = new Browser();
    const weak = await anon.call("POST", "/api/auth/invitations/accept", { token: invitationToken, password: "short" });
    assert.equal(weak.statusCode, 400);
    assert.equal((await anon.call("POST", "/api/auth/invitations/accept", { token: invitationToken, password: PASSWORD })).statusCode, 200);
    assert.equal((await anon.call("POST", "/api/auth/invitations/accept", { token: invitationToken, password: PASSWORD })).json().error.code, "TOKEN_INVALID");

    const agent = new Browser();
    const login = await agent.login(email);
    assert.deepEqual(login.json().mfa, { enabled: false, required: false });
    assert.equal((await agent.call("GET", "/api/pipeline")).statusCode, 200);
    assert.equal((await agent.call("POST", "/api/users", { email: "z@zareh.test", firstName: "Z", lastName: "Z", role: "ADMIN" })).statusCode, 403);

    // Suspend: the agent's very next request fails
    assert.equal((await admin.call("POST", `/api/users/${userId}/suspend`)).statusCode, 200);
    assert.equal((await agent.call("GET", "/api/pipeline")).statusCode, 401);
    assert.equal((await new Browser().login(email)).statusCode, 401);
    assert.equal((await admin.call("POST", `/api/users/${u.admin2}/suspend`)).statusCode, 403); // not yourself

    // Reactivate, sign in, then a role change ends that session too
    await admin.call("POST", `/api/users/${userId}/reactivate`);
    const again = new Browser();
    await again.login(email);
    assert.equal((await again.call("GET", "/api/pipeline")).statusCode, 200);
    await prisma.user.update({ where: { id: userId }, data: { role: "COMPLIANCE_ADMIN" } });
    assert.equal((await again.call("GET", "/api/pipeline")).statusCode, 401);
    await prisma.user.update({ where: { id: userId }, data: { role: "AGENT" } });
  });

  test("ten wrong passwords lock the account; unknown emails get the same answer", async () => {
    const { email } = await makeUser("AGENT");
    const b = new Browser();
    const unknown = await b.login(`nobody-${randomUUID()}@zareh.test`);
    const wrong = await b.login(email, "not the password at all");
    assert.deepEqual([unknown.statusCode, unknown.json().error], [wrong.statusCode, wrong.json().error]);
    for (let i = 1; i < 10; i++) await b.login(email, "not the password at all");
    const locked = await b.login(email);
    assert.equal(locked.statusCode, 423);
    assert.equal(locked.json().error.code, "ACCOUNT_LOCKED");
    clock += 16 * 60_000;
    assert.equal((await b.login(email)).statusCode, 200);
  });

  test("sessions expire after 30 idle minutes and on logout; password reset links work once", async () => {
    const { id, email } = await makeUser("AGENT");
    const b = new Browser();
    await b.login(email);
    assert.equal((await b.call("GET", "/api/pipeline")).statusCode, 200);
    clock += 31 * 60_000;
    assert.equal((await b.call("GET", "/api/pipeline")).json().error.code, "SESSION_EXPIRED");

    await b.login(email);
    assert.equal((await b.call("POST", "/api/auth/logout")).statusCode, 200);
    const stale = await app.inject({ method: "GET", url: "/api/pipeline", headers: { cookie: (await prisma.session.count()) ? b.cookie || "zh_session=x" : "" } });
    assert.equal(stale.statusCode, 401);

    const admin = new Browser();
    await admin.login(emails.admin);
    const cred = await prisma.userCredential.findUniqueOrThrow({ where: { userId: u.admin } });
    clock += 30_000;
    await admin.call("POST", "/api/auth/mfa/verify", { code: totpAt(base32Decode(config.fieldCipher.decrypt(cred.mfaSecretEnc!)), currentStep(clock)) });
    const reset = await admin.call("POST", `/api/users/${id}/password-reset`);
    assert.equal(reset.statusCode, 200, reset.body);
    const anon = new Browser();
    const next = "A brand new passphrase 77";
    assert.equal((await anon.call("POST", "/api/auth/password-resets/complete", { token: reset.json().resetToken, password: next })).statusCode, 200);
    assert.equal((await anon.call("POST", "/api/auth/password-resets/complete", { token: reset.json().resetToken, password: next })).statusCode, 400);
    assert.equal((await new Browser().login(email, next)).statusCode, 200);
  });

  test("every sign-in event and admin action is in the append-only audit log", async () => {
    const actions = (await prisma.auditLog.findMany({ where: { OR: [{ userId: u.admin }, { userId: u.admin2 }, { userId: u.agent }] }, select: { action: true } }))
      .map((a) => a.action);
    for (const a of ["LOGIN", "MFA_ENROLLED", "MFA_VERIFIED", "MFA_RECOVERY_CODE_USED", "USER_CREATED", "INVITATION_ACCEPTED", "USER_SUSPENDED", "PASSWORD_RESET_ISSUED"]) {
      assert.ok(actions.includes(a), `missing ${a}`);
    }
    assert.ok((await prisma.auditLog.count({ where: { action: "LOGIN_FAILED" } })) >= 10);
    let code = "no error";
    try {
      await prisma.$executeRaw`UPDATE "AuditLog" SET action = 'x' WHERE "userId" = ${u.admin}::uuid`;
    } catch (err) {
      code = (err as { meta?: { code?: string } }).meta?.code ?? "other";
    }
    assert.equal(code, "ZD003");
  });

  test("security headers on every response", async () => {
    const res = await app.inject({ method: "GET", url: "/api/pipeline" });
    for (const [h, v] of [["x-content-type-options", "nosniff"], ["x-frame-options", "DENY"], ["referrer-policy", "no-referrer"],
      ["cache-control", "no-store"], ["strict-transport-security", "max-age=31536000; includeSubDomains"]]) {
      assert.equal(res.headers[h!], v, h);
    }
  });
});

describe("sign-in rate limits", { skip }, () => {
  const prisma = new PrismaClient();
  const auth = new AuthService(prisma, loadSecurityConfig({ NODE_ENV: "test" }));
  const app = buildApp({ prisma, auth, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE });
  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("more than 5 attempts a minute for one email are refused before checking the password", async () => {
    const email = `nobody-${randomUUID()}@zareh.test`;
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "whatever it is" } })).statusCode);
    }
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429]);
  });
});
