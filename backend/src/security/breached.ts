/**
 * Breached-password screening, at invitation, reset and password change (NIST SP 800-63B 5.1.1.2).
 *
 * Uses the Pwned Passwords range API with k-anonymity: only the first 5 characters of the password's SHA-1 hash leave
 * the server, and the response is padded so its size reveals nothing. The password itself is never sent.
 *
 *   BREACHED_PASSWORD_CHECK=on        (production default) a password seen in a breach is refused; if the service
 *                                     can't be reached, the password is accepted and the miss is logged
 *   BREACHED_PASSWORD_CHECK=required  same, but an unreachable service refuses the password ("try again shortly")
 *   BREACHED_PASSWORD_CHECK=off       no check (development and tests only; production refuses to start with it)
 *
 * Production's network must allow api.pwnedpasswords.com.
 */

import { createHash } from "node:crypto";

export type BreachCheckMode = "on" | "required" | "off";

export interface BreachChecker {
  /** How many times the password appears in known breaches; null when the service couldn't be reached */
  timesSeen(password: string): Promise<number | null>;
}

export const NO_BREACH_CHECK: BreachChecker = { timesSeen: async () => 0 };

export function pwnedPasswords(opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): BreachChecker {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async timesSeen(password) {
      const hash = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
      const prefix = hash.slice(0, 5);
      const suffix = hash.slice(5);
      try {
        const res = await doFetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
          headers: { "Add-Padding": "true", "User-Agent": "zareh-back-office" },
          signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
        });
        if (!res.ok) return null;
        for (const line of (await res.text()).split("\n")) {
          const [s, count] = line.trim().split(":");
          if (s === suffix) return Number(count) || 0; // padding entries have a count of 0
        }
        return 0;
      } catch {
        return null;
      }
    },
  };
}

/** The message to show, or null when the password may be used */
export async function breachProblem(checker: BreachChecker, mode: BreachCheckMode, password: string,
  onUnavailable: () => void = () => {}): Promise<string | null> {
  if (mode === "off") return null;
  const seen = await checker.timesSeen(password);
  if (seen === null) {
    onUnavailable();
    return mode === "required" ? "can't be checked against known data breaches right now; try again in a minute" : null;
  }
  return seen > 0 ? "has appeared in a known data breach, so it's easy for attackers to guess. Choose a different one" : null;
}
