/**
 * Ontario business days for trust deadlines.
 *
 * O. Reg. 567/05 s.17(2): a business day is a day that is not a Saturday or a
 * holiday under s.87 of the Legislation Act, 2006 (Sunday is itself a
 * holiday). The holidays are generated from the s.87 list and the s.88
 * weekend rules; see docs/regulatory-references.md §10.
 *
 * Two deliberate choices:
 *   • The Civic Holiday (first Monday in August) is counted as a business day
 *     unless the calendar is built with civicHoliday: true. Whether s.87 lists
 *     it is unverified, and counting it gives the earlier, safer deadline.
 *   • Days proclaimed as holidays come from the ProclaimedHoliday table
 *     (entered by staff with the proclamation reference), never guessed.
 */

export interface CalendarOptions {
  civicHoliday?: boolean;
  proclaimed?: { date: string; name: string }[];
}

const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const dow = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** nth Monday (1-based) of a month */
const nthMonday = (y: number, m: number, n: number) => {
  const first = ymd(y, m, 1);
  return shift(first, ((8 - dow(first)) % 7) + 7 * (n - 1));
};

/** Easter Sunday, Gregorian calendar (anonymous / Meeus algorithm) */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

/** Weekday holidays of a year (Sundays aren't listed: every Sunday is a holiday). */
export function ontarioHolidays(year: number, opts: CalendarOptions = {}): Map<string, string> {
  const out = new Map<string, string>();
  const add = (date: string, name: string) => out.set(date, out.has(date) ? `${out.get(date)} / ${name}` : name);
  const easter = easterSunday(year);

  const newYear = ymd(year, 1, 1);
  add(newYear, "New Year's Day");
  if (dow(newYear) === 0) add(shift(newYear, 1), "New Year's Day (observed, s.88)");
  add(nthMonday(year, 2, 3), "Family Day");
  add(shift(easter, -2), "Good Friday");
  add(shift(easter, 1), "Easter Monday");
  const may24 = ymd(year, 5, 24);
  add(shift(may24, -((dow(may24) + 6) % 7)), "Victoria Day"); // the Monday on or before May 24
  const july1 = ymd(year, 7, 1);
  add(dow(july1) === 0 ? ymd(year, 7, 2) : july1, dow(july1) === 0 ? "Canada Day (July 2, s.88)" : "Canada Day");
  if (opts.civicHoliday) add(nthMonday(year, 8, 1), "Civic Holiday");
  add(nthMonday(year, 9, 1), "Labour Day");
  add(nthMonday(year, 10, 2), "Thanksgiving Day");
  add(ymd(year, 11, 11), "Remembrance Day");
  const christmas = ymd(year, 12, 25);
  add(christmas, "Christmas Day");
  add(ymd(year, 12, 26), "Boxing Day");
  if (dow(christmas) === 6) add(ymd(year, 12, 27), "Christmas Day (observed, s.88)");
  if (dow(christmas) === 0) add(ymd(year, 12, 27), "Christmas Day (observed, s.88)");
  for (const p of opts.proclaimed ?? []) if (p.date.startsWith(`${year}-`)) add(p.date, p.name);
  return out;
}

export class BusinessCalendar {
  readonly options: CalendarOptions;
  #years = new Map<number, Map<string, string>>();

  constructor(options: CalendarOptions = {}) {
    this.options = options;
  }

  holidayName(iso: string): string | null {
    const year = Number(iso.slice(0, 4));
    let table = this.#years.get(year);
    if (!table) {
      table = ontarioHolidays(year, this.options);
      this.#years.set(year, table);
    }
    return table.get(iso) ?? null;
  }

  isBusinessDay(iso: string): boolean {
    const d = dow(iso);
    return d !== 0 && d !== 6 && this.holidayName(iso) === null;
  }

  /** Business days after `from`, up to and including `to` (0 if `to` ≤ `from`). */
  between(from: string, to: string): number {
    let n = 0;
    for (let d = shift(from, 1); d <= to; d = shift(d, 1)) if (this.isBusinessDay(d)) n++;
    return n;
  }

  /** The date `n` business days after `from` (s.17(1): deposit within five business days of receipt). */
  add(from: string, n: number): string {
    let d = from;
    for (let left = n; left > 0;) {
      d = shift(d, 1);
      if (this.isBusinessDay(d)) left--;
    }
    return d;
  }
}

/** Statutory holidays only (no proclaimed days, Civic Holiday counted as a business day). */
export const STATUTORY_CALENDAR = new BusinessCalendar();
