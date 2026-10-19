import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decode(secret: string): Buffer {
  const clean = secret.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", decode(secret)).update(counter).digest();
  const o = mac[mac.length - 1]! & 0x0f;
  const n = ((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
}

// Kept on disk: test files can run in fresh worker processes, and the server remembers every code used
const STEPS = new URL("../.state/totp-steps.json", import.meta.url);
const readSteps = (): Record<string, number> => (existsSync(STEPS) ? JSON.parse(readFileSync(STEPS, "utf8")) : {});

/**
 * An authenticator code the server will accept: it refuses a code from the
 * same or an earlier 30-second step than the last one used, so a second
 * sign-in within the same window waits for the next step.
 */
export async function totp(secret: string): Promise<string> {
  for (;;) {
    const now = Math.floor(Date.now() / 30_000);
    const steps = readSteps();
    const step = Math.max(now, (steps[secret] ?? -Infinity) + 1);
    if (step <= now + 1 && step >= now) {
      writeFileSync(STEPS, JSON.stringify({ ...steps, [secret]: step }));
      return codeAt(secret, step);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
