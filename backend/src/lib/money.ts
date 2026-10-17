/**
 * Money crosses the API as a decimal string ("40000.00") and is handled as
 * integer cents in code. Floats never touch a trust amount.
 */

export type Cents = number;

const AMOUNT = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$/;

/** Most a single trust entry can be: NUMERIC(12,2). */
export const MAX_ENTRY_CENTS: Cents = 9_999_999_999_99;

/** Parses "1234.5" / "1234.50" / "1234" to cents; null if not a valid amount. */
export function parseAmount(value: unknown): Cents | null {
  if (typeof value !== "string" || !AMOUNT.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function formatCents(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Postgres NUMERIC text ("40000.00", "-150.5", "0") to cents. */
export function numericToCents(text: string): Cents {
  const negative = text.startsWith("-");
  const cents = parseAmount(negative ? text.slice(1) : text);
  if (cents === null) throw new Error(`Unexpected NUMERIC value from database: ${text}`);
  return negative ? -cents : cents;
}
