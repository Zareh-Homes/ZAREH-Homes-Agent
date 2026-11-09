/**
 * Sign-in rate limits are shared by every app server (migration 024). Needs DATABASE_URL; skipped otherwise.
 */

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { AuthService } from "../src/security/auth-service.ts";
import { loadSecurityConfig } from "../src/security/config.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";

describe("sign-in limits across servers", { skip }, () => {
  const prisma = new PrismaClient();
  const server = () => buildApp({ prisma, auth: new AuthService(prisma, loadSecurityConfig({ NODE_ENV: "test" })), fileStore: new MemoryStore(),
    brokerage: TEST_BROKERAGE, rateLimits: { loginPerMinutePerIp: 1000, loginPerMinutePerEmail: 3, apiPerMinute: 10_000 } });
  const [a, b] = [server(), server()];
  after(async () => {
    await a.close();
    await b.close();
    await prisma.$disconnect();
  });

  test("attempts on two servers count against the same per-account limit", async () => {
    const email = `limit-${randomUUID()}@zareh.test`;
    const attempt = (app: typeof a) => app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "wrong password here" } });
    const codes = [];
    for (const app of [a, b, a, b]) codes.push((await attempt(app)).statusCode);
    assert.deepEqual(codes.slice(0, 3).map((c) => c === 429), [false, false, false]);
    assert.equal(codes[3], 429, "the fourth attempt is refused even though each server saw only two");
    // Nothing identifying is stored: keys are hashes
    const rows = await prisma.rateLimitHit.findMany();
    assert.ok(rows.length > 0 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.keyHash) && !r.keyHash.includes("limit-")));
  });
});
