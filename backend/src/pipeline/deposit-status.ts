/**
 * Deposit badge for a deal, from the trust ledger. Pure function.
 *
 * O. Reg. 567/05 s.17(1): trust money must be deposited into the trust
 * account within 5 business days after it comes into the brokerage's hands.
 * What counts is the deposit at the bank, not the receipt entered here:
 *   - matched to a bank record: the bank's posting date is the evidence
 *     (a later posting than the date someone typed in is what's measured);
 *   - no bank record yet: once 5 business days have passed since receipt,
 *     it's flagged, not left as "awaiting bank";
 *   - cleared by a pre-cutover attestation (no bank line): the attested date.
 * A deposit that never arrives is caught by the APS due date.
 *
 * "Cleared" means the deposit has been matched to the trust account's bank
 * statement: money the bank actually holds, not just an entry in the ledger.
 *
 * Business days exclude Saturdays, Sundays and Ontario holidays
 * (O. Reg. 567/05 s.17(2)); see lib/ontario-calendar.ts.
 */

import { businessDaysBetween } from "../lib/dates.ts";
import type { Cents } from "../lib/money.ts";
import { STATUTORY_CALENDAR, type BusinessCalendar } from "../lib/ontario-calendar.ts";

export const TRUST_DEPOSIT_BUSINESS_DAYS = 5;

export type DepositState =
  | "CLEARED" // full deposit received, banked on time, matched to the bank statement
  | "AWAITING_BANK" // full deposit recorded on time, not yet matched to the bank statement
  | "LATE_TO_TRUST" // received, but banked after 5 business days
  | "OVERDUE" // due date passed, deposit (or part of it) not received
  | "PARTIAL" // part received, rest not yet due
  | "DUE" // nothing received yet, due date still ahead
  | "NOT_RECORDED" // nothing received and no due date on the deal
  | "HELD_ELSEWHERE"; // co-op brokerage / lawyer / builder holds it

export interface DepositBadge {
  state: DepositState;
  tone: "good" | "critical" | "warning" | "neutral";
  label: string;
  detail: string;
  expectedCents: Cents;
  receivedCents: Cents;
}

export interface DepositFacts {
  holder: "OUR_BROKERAGE" | "COOP_BROKERAGE" | "LAWYER" | "BUILDER";
  expectedCents: Cents;
  dueDate: string | null;
  deposits: {
    amountCents: Cents;
    receivedDate: string;
    /** Date entered when recording it (what staff say) */
    depositedDate: string;
    receiptNumber: number | null;
    bankCleared: boolean;
    /** Earliest bank posting matched to it (what the bank says), if any */
    bankDate?: string | null;
  }[];
  today: string;
  calendar?: BusinessCalendar;
}

const HOLDER_LABEL = { COOP_BROKERAGE: "co-op brokerage", LAWYER: "lawyer", BUILDER: "builder / trustee" } as const;

const dollars = (cents: Cents) =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(cents / 100);

const shortDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });

export function depositStatus(f: DepositFacts): DepositBadge {
  const base = { expectedCents: f.expectedCents, receivedCents: f.deposits.reduce((s, d) => s + d.amountCents, 0) };
  const received = base.receivedCents;
  const cal = f.calendar ?? STATUTORY_CALENDAR;

  if (f.holder !== "OUR_BROKERAGE") {
    return {
      ...base, state: "HELD_ELSEWHERE", tone: "neutral",
      label: `Held by ${HOLDER_LABEL[f.holder]}`,
      detail: `${dollars(f.expectedCents)} deposit is not in our trust account`,
    };
  }

  // More than 5 business days from receipt to the bank, or still not at the bank after 5, is a breach on record
  const late = f.deposits
    .map((d) => {
      const evidence = d.bankDate ?? (d.bankCleared ? d.depositedDate : null);
      const banked = evidence && evidence > d.depositedDate ? evidence : d.depositedDate;
      return evidence || businessDaysBetween(d.receivedDate, f.today, cal) <= TRUST_DEPOSIT_BUSINESS_DAYS
        ? { ...d, atBank: true, on: banked, days: businessDaysBetween(d.receivedDate, banked, cal) }
        : { ...d, atBank: false, on: f.today, days: businessDaysBetween(d.receivedDate, f.today, cal) };
    })
    .filter((d) => d.days > TRUST_DEPOSIT_BUSINESS_DAYS);
  if (late.length > 0) {
    const worst = late.reduce((a, b) => (b.days > a.days ? b : a));
    return {
      ...base, state: "LATE_TO_TRUST", tone: "critical",
      label: worst.atBank ? "Deposited late to trust" : "Not at the bank after 5 business days",
      detail: worst.atBank
        ? `Received ${shortDate(worst.receivedDate)}, at the bank ${shortDate(worst.on)}${worst.bankDate ? " (bank statement)" : ""}: ${worst.days} business days (limit ${TRUST_DEPOSIT_BUSINESS_DAYS})`
        : `Received ${shortDate(worst.receivedDate)}; no bank record of the deposit ${worst.days} business days later (limit ${TRUST_DEPOSIT_BUSINESS_DAYS})`,
    };
  }

  const pastDue = f.dueDate !== null && f.dueDate < f.today;

  if (received >= f.expectedCents && received > 0) {
    const receipts = f.deposits.map((d) => d.receiptNumber).filter((n) => n !== null);
    const uncleared = f.deposits.filter((d) => !d.bankCleared).reduce((s, d) => s + d.amountCents, 0);
    if (uncleared > 0) {
      return {
        ...base, state: "AWAITING_BANK", tone: "warning",
        label: "Received – not yet cleared",
        detail: `${dollars(uncleared)} recorded in trust but not yet matched to the bank statement`,
      };
    }
    return {
      ...base, state: "CLEARED", tone: "good",
      label: "Deposit Received & Cleared",
      detail: `${dollars(received)} in trust${receipts.length ? ` · receipt #${receipts.join(", #")}` : ""}`,
    };
  }

  if (pastDue) {
    const daysLate = businessDaysBetween(f.dueDate!, f.today, cal);
    return {
      ...base, state: "OVERDUE", tone: "critical",
      label: "Deposit Missing / Overdue",
      detail: received > 0
        ? `${dollars(received)} of ${dollars(f.expectedCents)} received; balance was due ${shortDate(f.dueDate!)}`
        : `${dollars(f.expectedCents)} was due ${shortDate(f.dueDate!)} (${daysLate} business day${daysLate === 1 ? "" : "s"} ago)`,
    };
  }

  if (received > 0) {
    return {
      ...base, state: "PARTIAL", tone: "warning",
      label: "Partial deposit",
      detail: `${dollars(received)} of ${dollars(f.expectedCents)} in trust${f.dueDate ? `; balance due ${shortDate(f.dueDate)}` : ""}`,
    };
  }

  if (f.dueDate) {
    return {
      ...base, state: "DUE", tone: "neutral",
      label: `Deposit due ${shortDate(f.dueDate)}`,
      detail: `${dollars(f.expectedCents)} expected`,
    };
  }

  return {
    ...base, state: "NOT_RECORDED", tone: "warning",
    label: "Deposit not recorded",
    detail: "No deposit in trust and no due date on the deal",
  };
}
