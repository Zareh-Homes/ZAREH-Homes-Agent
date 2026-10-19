/**
 * Display only. Every amount shown comes from the server as computed there;
 * these functions format it and never do arithmetic on money.
 */

/** "24860.00" or "-12.5" → "$24,860.00" / "−$12.50". Works on the decimal string, no floating point. */
export function moneyText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return value;
  const [, minus, whole, frac = ""] = m;
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${minus ? "−" : ""}$${grouped}.${frac.padEnd(2, "0")}`;
}

/** Integer cents from the server (computation objects) → "$1,695.00" */
export function centsText(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "−" : ""}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

/** "2026-11-30" → "Nov 30, 2026" */
export function dateText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** ISO timestamp → "Nov 30, 2026, 2:05 p.m." in Toronto time */
export function dateTimeText(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Toronto" });
}

/** "NEEDS_REVISION" → "Needs revision" */
export function labelOf(code: string | null | undefined): string {
  if (!code) return "—";
  const s = code.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const SIDE_LABEL: Record<string, string> = {
  LISTING: "Listing (sale)",
  BUYER: "Buyer (sale)",
  DUAL: "Both sides (sale)",
  LANDLORD: "Landlord (lease)",
  TENANT: "Tenant (lease)",
};

export const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  MANAGING_BROKER: "Managing broker",
  COMPLIANCE_ADMIN: "Compliance admin",
  AGENT: "Agent",
};

export const isLease = (side: string) => side === "LANDLORD" || side === "TENANT";
