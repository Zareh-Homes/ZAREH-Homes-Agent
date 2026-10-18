/** Display formatting. Money arrives as integer cents. */

const whole = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 });
const exact = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2 });
const compact = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", currencyDisplay: "narrowSymbol", notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 });

/** $57,000 */
export const dollars = (cents: number): string => whole.format(Math.round(cents / 100));
/** $57,000.00 — for tables and titles where the exact figure matters */
export const money = (cents: number): string => exact.format(cents / 100);
/** $12.4M — for headline volume */
export const compactDollars = (cents: number): string => compact.format(cents / 100);

/** "Nov 30" or "Nov 30, 2027" when not the current year */
export function shortDate(iso: string, currentYear?: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  const sameYear = currentYear === undefined || d.getUTCFullYear() === currentYear;
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

/** "today", "in 1 day", "in 5 days", "3 days overdue" */
export function relativeDays(days: number): string {
  if (days === 0) return "today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  return `${-days} day${days === -1 ? "" : "s"} overdue`;
}

export function percent(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

/** Short names for dense tables; the full name stays in the title attribute. */
export function shortDocName(name: string): string {
  if (name === "FINTRAC Individual Identification Record") return "FINTRAC ID record";
  if (name === "FINTRAC Corporate / Beneficial Ownership Record") return "FINTRAC corporate record";
  return name;
}

export const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  MANAGING_BROKER: "Managing Broker",
  COMPLIANCE_ADMIN: "Compliance Admin",
  AGENT: "Agent",
};

export const DOC_STATUS_LABEL: Record<string, string> = {
  MISSING: "Missing",
  PENDING_REVIEW: "Pending review",
  NEEDS_REVISION: "Needs revision",
  WAIVED: "Waived",
  NOT_SET_UP: "Not set up",
};
