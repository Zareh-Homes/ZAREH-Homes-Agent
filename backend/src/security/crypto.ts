/**
 * Cryptographic building blocks, all on Node's built-in crypto:
 *
 *   Passwords   scrypt (N=2^15, r=8, p=1), 16-byte random salt, constant-time compare
 *   MFA         TOTP per RFC 6238 (HMAC-SHA1, 30 s, 6 digits), verified against the RFC test vectors
 *   Tokens      32 random bytes, base64url; only a SHA-256 is ever stored
 *   Fields      AES-256-GCM with a 96-bit random IV, for secrets kept at rest (MFA seeds, ID numbers)
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// ── Passwords ────────────────────────────────────────────────────────────────

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, SCRYPT.keylen, { ...params, maxmem: SCRYPT.maxmem }, (err, key) =>
      err ? reject(err) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A hash to verify against when the account doesn't exist, so timing doesn't reveal which emails are registered. */
export const DUMMY_PASSWORD_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");

export const PASSWORD_MIN_LENGTH = 12;

/** Length over composition rules (NIST SP 800-63B); refuse the obvious. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > 256) return "is too long";
  const lower = password.toLowerCase();
  const name = email.split("@")[0]!.toLowerCase();
  if (name.length >= 4 && lower.includes(name)) return "can't contain your email name";
  if (/^(.)\1+$/.test(password) || ["password1234", "123456789012", "qwertyuiopas"].some((w) => lower.includes(w))) {
    return "is too easy to guess";
  }
  return null;
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export const newToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP_SECONDS = 30;

export function totpAt(secret: Buffer, step: number, digits = 6, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac(algorithm, secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, "0");
}

export const currentStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

/**
 * Accepts the current step or one either side (clock drift). Returns the step
 * that matched, so the caller can refuse a replay of the same or an earlier step.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = currentStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (constantTimeEqual(totpAt(secret, step), code)) return step;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const raw = randomBytes(5).toString("hex").toUpperCase(); // 10 hex chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

// ── Field encryption (AES-256-GCM) ───────────────────────────────────────────

export class FieldCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("FIELD_ENCRYPTION_KEY must be 32 bytes (base64-encoded)");
    this.key = key;
  }

  static fromBase64(value: string): FieldCipher {
    return new FieldCipher(Buffer.from(value, "base64"));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `v1.${iv.toString("base64url")}.${body.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
  }

  decrypt(sealed: string): string {
    const [version, iv, body, tag] = sealed.split(".");
    if (version !== "v1" || !iv || body === undefined || !tag) throw new Error("not an encrypted field");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }

  isSealed(value: unknown): value is string {
    return typeof value === "string" && /^v1\.[\w-]+\.[\w-]*\.[\w-]+$/.test(value);
  }
}
