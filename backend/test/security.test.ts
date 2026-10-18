import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base32Decode, base32Encode, FieldCipher, hashPassword, passwordProblem, totpAt, verifyPassword, verifyTotp,
} from "../src/security/crypto.ts";
import { InsecureConfigurationError, loadSecurityConfig } from "../src/security/config.ts";
import { FixedWindowLimiter, parseCookies, sessionCookie } from "../src/security/http.ts";
import { EncryptedStore, MemoryStore } from "../src/compliance/storage.ts";
import { randomBytes } from "node:crypto";

test("TOTP matches the RFC 6238 test vectors (SHA-1, 8 digits)", () => {
  const secret = Buffer.from("12345678901234567890");
  const vectors: [number, string][] = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"]];
  for (const [t, code] of vectors) assert.equal(totpAt(secret, Math.floor(t / 30), 8), code, `t=${t}`);
});

test("TOTP verification accepts ±1 step and nothing else", () => {
  const secret = randomBytes(20);
  const now = 1_800_000_000_000;
  const step = Math.floor(now / 30_000);
  assert.equal(verifyTotp(secret, totpAt(secret, step), now), step);
  assert.equal(verifyTotp(secret, totpAt(secret, step - 1), now), step - 1);
  assert.equal(verifyTotp(secret, totpAt(secret, step + 2), now), null);
  assert.equal(verifyTotp(secret, "12345", now), null);
  assert.deepEqual(base32Decode(base32Encode(secret)), secret);
});

test("passwords: scrypt round trip, wrong password fails, weak ones refused", async () => {
  const h = await hashPassword("correct horse battery staple");
  assert.match(h, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse battery staple", h), true);
  assert.equal(await verifyPassword("correct horse battery stapl", h), false);
  assert.match(passwordProblem("short", "a@b.c")!, /at least 12/);
  assert.match(passwordProblem("danielzareh-2026!", "danielzareh@x.ca")!, /email/);
  assert.equal(passwordProblem("long enough passphrase", "a@b.c"), null);
});

test("field and file encryption: authenticated, and tampering is detected", async () => {
  const cipher = new FieldCipher(randomBytes(32));
  const sealed = cipher.encrypt("AB123456");
  assert.notEqual(sealed, cipher.encrypt("AB123456")); // random IV
  assert.equal(cipher.decrypt(sealed), "AB123456");
  const parts = sealed.split(".");
  parts[2] = Buffer.from("XX123456").toString("base64url");
  assert.throws(() => cipher.decrypt(parts.join(".")));

  const inner = new MemoryStore();
  const store = new EncryptedStore(inner, randomBytes(32));
  await store.put("k", Buffer.from("passport scan"), "image/jpeg");
  assert.ok(!(await inner.get("k")).includes(Buffer.from("passport")));
  assert.equal((await store.get("k")).toString(), "passport scan");
});

test("production refuses to start with any unsafe setting", () => {
  const prod = { NODE_ENV: "production", FIELD_ENCRYPTION_KEY: randomBytes(32).toString("base64"), APP_ORIGINS: "https://office.zarehhomes.ca" };
  assert.equal(loadSecurityConfig(prod).mode, "session");
  const problems = (env: NodeJS.ProcessEnv) => {
    try {
      loadSecurityConfig(env);
      return [];
    } catch (err) {
      assert.ok(err instanceof InsecureConfigurationError);
      return err.problems;
    }
  };
  assert.match(problems({ ...prod, ALLOW_DEV_AUTH_HEADER: "true" }).join(), /never be set in production/);
  assert.match(problems({ ...prod, FIELD_ENCRYPTION_KEY: undefined }).join(), /FIELD_ENCRYPTION_KEY is required/);
  assert.match(problems({ ...prod, APP_ORIGINS: "http://office.zarehhomes.ca" }).join(), /must be https/);
  assert.match(problems({ ...prod, COOKIE_SECURE: "false" }).join(), /COOKIE_SECURE/);
  assert.match(problems({ ...prod, MFA_REQUIRED_ROLES: "ADMIN" }).join(), /MFA can't be optional for MANAGING_BROKER/);
});

test("cookies and rate limiting", () => {
  assert.deepEqual(parseCookies("a=1; zh_session=abc%3D; b=2"), { a: "1", zh_session: "abc=", b: "2" });
  assert.equal(sessionCookie("t", { secure: true, maxAgeSeconds: 60 }), "zh_session=t; Path=/; HttpOnly; SameSite=Strict; Max-Age=60; Secure");
  const l = new FixedWindowLimiter();
  assert.deepEqual([1, 2, 3, 4].map(() => l.hit("k", 3, 1000, 0)), [true, true, true, false]);
  assert.equal(l.hit("k", 3, 1000, 1000), true); // new window
});
