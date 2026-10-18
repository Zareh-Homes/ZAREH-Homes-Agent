/** Calendar dates are "YYYY-MM-DD" strings in the brokerage's time zone. */

import { BusinessCalendar, STATUTORY_CALENDAR } from "./ontario-calendar.ts";

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
 * Ontario business days after `from`, up to and including `to`: no
 * Saturdays, Sundays or Legislation Act holidays (O. Reg. 567/05 s.17(2)).
 * Pass the brokerage calendar to include proclaimed holidays.
 */
export function businessDaysBetween(from: string, to: string, calendar: BusinessCalendar = STATUTORY_CALENDAR): number {
  return calendar.between(from, to);
}
