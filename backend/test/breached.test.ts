import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { breachProblem, pwnedPasswords } from "../src/security/breached.ts";
import { InsecureConfigurationError, loadSecurityConfig } from "../src/security/config.ts";

test("Pwned Passwords range API: only the first 5 hash characters are sent; padding rows don't count", async () => {
  const hash = createHash("sha1").update("password123").digest("hex").toUpperCase();
  const asked: string[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    asked.push(url);
    assert.equal((init.headers as Record<string, string>)["Add-Padding"], "true");
    return new Response(`0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n${hash.slice(5)}:2254650\r\nFFFFF00000000000000000000000000000:0`, { status: 200 });
  }) as unknown as typeof fetch;
  const checker = pwnedPasswords({ fetchImpl: fake });
  assert.equal(await checker.timesSeen("password123"), 2254650);
  assert.deepEqual(asked, [`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`]);
  assert.ok(!asked[0]!.includes(hash.slice(5)), "the rest of the hash never leaves the server");
  assert.equal(await checker.timesSeen("an unusual passphrase nobody uses"), 0);
  const down = pwnedPasswords({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
  assert.equal(await down.timesSeen("x"), null);
});

test("breach modes: on refuses breached passwords and lets an outage through; required refuses on an outage; off skips", async () => {
  const seen = { timesSeen: async () => 12 };
  const outage = { timesSeen: async () => null };
  let missed = 0;
  assert.match((await breachProblem(seen, "on", "x"))!, /known data breach/);
  assert.equal(await breachProblem(outage, "on", "x", () => missed++), null);
  assert.equal(missed, 1);
  assert.match((await breachProblem(outage, "required", "x"))!, /try again/);
  assert.equal(await breachProblem(seen, "off", "x"), null);
});

test("production: the breach check is on by default and can't be switched off", () => {
  const prod = { NODE_ENV: "production", FIELD_ENCRYPTION_KEY: randomBytes(32).toString("base64"), APP_ORIGINS: "https://office.zarehhomes.ca" };
  assert.equal(loadSecurityConfig(prod).breachCheck, "on");
  assert.equal(loadSecurityConfig({ ...prod, BREACHED_PASSWORD_CHECK: "required" }).breachCheck, "required");
  assert.throws(() => loadSecurityConfig({ ...prod, BREACHED_PASSWORD_CHECK: "off" }),
    (e: unknown) => e instanceof InsecureConfigurationError && e.problems.some((p) => /can't be off in production/.test(p)));
  assert.equal(loadSecurityConfig({ NODE_ENV: "test" }).breachCheck, "off");
});
