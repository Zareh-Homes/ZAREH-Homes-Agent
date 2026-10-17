/** Calendar dates are "YYYY-MM-DD" strings in the brokerage's time zone. */

export const BROKERAGE_TIME_ZONE = "America/Toronto";

const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Today's date in Toronto, regardless of the server's own time zone. */
export function todayInToronto(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BROKERAGE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Weekdays after `from`, up to and including `to`. Statutory holidays are
 * not excluded, so this can undercount near a holiday (never overcount).
 */
export function businessDaysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  let days = 0;
  for (let t = start + 86_400_000; t <= end; t += 86_400_000) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) days++;
  }
  return days;
}
