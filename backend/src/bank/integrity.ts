/**
 * Cross-checks a bank file against the other bank records already imported
 * for the same account. Pure.
 *
 * The monthly statement is the record that's reconciled; interim downloads
 * are what the brokerage relied on in between (to verify a commission, or to
 * show funds were available). If an interim line is missing from the monthly
 * statement, or the balances disagree, one of the files is wrong or was
 * altered, and the difference has to be checked with the bank before either
 * is relied on.
 */

import type { Cents } from "../lib/money.ts";

export interface IntegrityLine {
  postedDate: string;
  amount: Cents;
  description: string;
}

export interface MonthlyRecord {
  periodStart: string;
  periodEnd: string;
  openingBalance: Cents;
  lines: IntegrityLine[];
}

export interface InterimRecord {
  label: string; // e.g. the file name
  periodStart: string;
  periodEnd: string;
  closingBalance: Cents;
  lines: IntegrityLine[];
}

const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
const money = (c: Cents) => `$${(c / 100).toFixed(2)}`;

/** Lines the bank may post a day or two after the interim download showed them */
const POSTING_DRIFT_DAYS = 3;

export function compareInterimToMonthly(monthly: MonthlyRecord, interim: InterimRecord): string[] {
  const out: string[] = [];
  const pool = monthly.lines.map((l) => ({ ...l, used: false }));
  const inPeriod = interim.lines.filter((l) => l.postedDate >= monthly.periodStart && l.postedDate <= monthly.periodEnd);
  // Exact date first, then within the drift window, so one line can't be claimed twice
  const unmatched: IntegrityLine[] = [];
  for (const l of inPeriod) {
    const exact = pool.find((m) => !m.used && m.amount === l.amount && m.postedDate === l.postedDate);
    if (exact) exact.used = true;
    else unmatched.push(l);
  }
  for (const l of unmatched) {
    const near = pool.find((m) => !m.used && m.amount === l.amount && Math.abs(day(m.postedDate) - day(l.postedDate)) <= POSTING_DRIFT_DAYS);
    if (near) near.used = true;
    else out.push(`${interim.label}: ${money(l.amount)} on ${l.postedDate} (${l.description}) isn't on the monthly statement for ${monthly.periodStart} to ${monthly.periodEnd}`);
  }
  if (interim.periodEnd >= monthly.periodStart && interim.periodEnd <= monthly.periodEnd) {
    const implied = monthly.openingBalance + monthly.lines.filter((l) => l.postedDate <= interim.periodEnd).reduce((s, l) => s + l.amount, 0);
    if (implied !== interim.closingBalance) {
      out.push(`${interim.label}: balance ${money(interim.closingBalance)} at ${interim.periodEnd}, but the monthly statement implies ${money(implied)} at that date`);
    }
  }
  return out;
}
