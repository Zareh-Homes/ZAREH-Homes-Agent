import { test } from "node:test";
import assert from "node:assert/strict";
import { BusinessCalendar, easterSunday, ontarioHolidays } from "../src/lib/ontario-calendar.ts";
import { compareInterimToMonthly } from "../src/bank/integrity.ts";
import { reconcile, type ReconLedgerEntry } from "../src/bank/reconcile.ts";
import { addMonths } from "../src/bank/unclaimed.ts";

test("calendar: Easter and the holidays that hang off it", () => {
  assert.deepEqual([2024, 2025, 2026, 2027, 2028].map(easterSunday), ["2024-03-31", "2025-04-20", "2026-04-05", "2027-03-28", "2028-04-16"]);
  const h = ontarioHolidays(2026);
  assert.equal(h.get("2026-04-03"), "Good Friday");
  assert.equal(h.get("2026-04-06"), "Easter Monday");
  assert.equal(h.get("2026-02-16"), "Family Day");
  assert.equal(h.get("2026-05-18"), "Victoria Day");
  assert.equal(h.get("2026-09-07"), "Labour Day");
  assert.equal(h.get("2026-10-12"), "Thanksgiving Day");
});

test("calendar: s.88 weekend rules", () => {
  assert.equal(ontarioHolidays(2023).get("2023-01-02"), "New Year's Day (observed, s.88)"); // Jan 1 2023 was a Sunday
  assert.equal(ontarioHolidays(2029).get("2029-07-02"), "Canada Day (July 2, s.88)"); // July 1 2029 is a Sunday
  assert.equal(ontarioHolidays(2029).has("2029-07-01"), false);
  assert.equal(ontarioHolidays(2027).get("2027-12-27"), "Christmas Day (observed, s.88)"); // Christmas on a Saturday: Monday
  assert.equal(ontarioHolidays(2022).get("2022-12-27"), "Christmas Day (observed, s.88)"); // Christmas on a Sunday: Tuesday
  assert.equal(ontarioHolidays(2022).get("2022-12-26"), "Boxing Day");
  // No substitution for Remembrance Day on a weekend (none found; unverified)
  assert.equal(ontarioHolidays(2028).has("2028-11-13"), false);
});

test("calendar: Civic Holiday is a business day unless the broker of record has confirmed otherwise", () => {
  assert.equal(new BusinessCalendar().isBusinessDay("2026-08-03"), true);
  assert.equal(new BusinessCalendar({ civicHoliday: true }).isBusinessDay("2026-08-03"), false);
});

test("calendar: proclaimed days, Saturdays and Sundays aren't business days", () => {
  const cal = new BusinessCalendar({ proclaimed: [{ date: "2026-09-08", name: "Day of mourning" }] });
  assert.equal(cal.holidayName("2026-09-08"), "Day of mourning");
  // Received Fri Sep 4: Labour Day Monday and the proclaimed Tuesday don't count; 5 business days is Tue Sep 15
  assert.equal(cal.add("2026-09-04", 5), "2026-09-15");
  assert.equal(cal.between("2026-09-04", "2026-09-15"), 5);
  assert.equal(new BusinessCalendar().add("2026-09-04", 5), "2026-09-14");
  // Christmas week 2026
  assert.equal(new BusinessCalendar().add("2026-12-23", 5), "2026-12-31");
});

test("integrity: an interim line missing from the monthly statement, or a balance that doesn't agree, is flagged", () => {
  const monthly = {
    periodStart: "2026-09-01", periodEnd: "2026-09-30", openingBalance: 0,
    lines: [{ postedDate: "2026-09-03", amount: 1_000_000, description: "DEPOSIT" }, { postedDate: "2026-09-20", amount: -1_250, description: "FEE" }],
  };
  const consistent = { label: "interim", periodStart: "2026-09-01", periodEnd: "2026-09-10", closingBalance: 1_000_000,
    lines: [{ postedDate: "2026-09-02", amount: 1_000_000, description: "DEPOSIT (pending)" }] }; // posted a day later: fine
  assert.deepEqual(compareInterimToMonthly(monthly, consistent), []);
  const altered = { ...consistent, closingBalance: 950_000, lines: [...consistent.lines, { postedDate: "2026-09-05", amount: -50_000, description: "WITHDRAWAL" }] };
  const issues = compareInterimToMonthly(monthly, altered);
  assert.equal(issues.length, 2);
  assert.match(issues[0]!, /\$-500\.00 on 2026-09-05 \(WITHDRAWAL\) isn't on the monthly statement/);
  assert.match(issues[1]!, /balance \$9500\.00 at 2026-09-10, but the monthly statement implies \$10000\.00/);
});

test("reconcile: balance owed to each person (s.13), and a split between depositors is flagged for review", () => {
  const e = (id: string, deal: string, type: string, signed: number, who: string | null): ReconLedgerEntry => ({
    id, dealId: deal, dealNumber: deal, entryType: type, signedAmount: signed, effectiveDate: "2026-09-02", referenceNo: null,
    counterparty: who, match: { basis: "PRE_CUTOVER", postedDate: null },
  });
  const r = reconcile({
    periodEnd: "2026-09-30", bankClosingBalance: 6_000_000, bankLines: [],
    entries: [
      e("1", "D1", "DEPOSIT_RECEIVED", 3_000_000, "Bo Kim"),
      e("2", "D2", "DEPOSIT_RECEIVED", 2_000_000, "Ann Lee"),
      e("3", "D2", "DEPOSIT_RECEIVED", 1_000_000, "Raj Patel"),
      e("4", "D2", "REFUND_TO_PAYER", -500_000, "Raj Patel"),
      e("5", "D3", "DEPOSIT_RECEIVED", 500_000, null),
    ],
  });
  assert.equal(r.isBalanced, true);
  assert.deepEqual(r.details.deals.map((d) => [d.dealNumber, d.basis, d.owedTo]), [
    ["D1", "SOLE_DEPOSITOR", [{ name: "Bo Kim", amount: 3_000_000 }]],
    ["D2", "PRO_RATA_REVIEW", [{ name: "Ann Lee", amount: 2_000_000 }, { name: "Raj Patel", amount: 500_000 }]],
    ["D3", "UNIDENTIFIED", [{ name: "Unidentified depositor", amount: 500_000 }]],
  ]);
});

test("unclaimed money: two years from the later of receipt or entitlement, month-end safe", () => {
  assert.equal(addMonths("2024-10-18", 24), "2026-10-18");
  assert.equal(addMonths("2024-02-29", 24), "2026-02-28");
  assert.equal(addMonths("2025-01-31", 1), "2025-02-28");
});

test("time zones: 'today' is Toronto's date across UTC midnight and both daylight-saving changes", async () => {
  const { todayInToronto } = await import("../src/lib/dates.ts");
  assert.equal(todayInToronto(new Date("2026-10-19T03:59:59Z")), "2026-10-18"); // 23:59 EDT
  assert.equal(todayInToronto(new Date("2026-10-19T04:00:00Z")), "2026-10-19");
  assert.equal(todayInToronto(new Date("2026-03-08T06:59:59Z")), "2026-03-08"); // DST starts 02:00 EST → 03:00 EDT
  assert.equal(todayInToronto(new Date("2026-03-09T03:59:59Z")), "2026-03-08"); // 23:59 EDT the same day
  assert.equal(todayInToronto(new Date("2026-11-01T04:30:00Z")), "2026-11-01"); // 00:30 EDT
  assert.equal(todayInToronto(new Date("2026-11-02T04:59:59Z")), "2026-11-01"); // 23:59 EST after DST ends
  assert.equal(todayInToronto(new Date("2028-02-29T12:00:00Z")), "2028-02-29"); // leap day
});

test("business days across a leap day and the year end", () => {
  const cal = new BusinessCalendar();
  assert.equal(cal.add("2028-02-25", 5), "2028-03-03"); // Fri Feb 25 → Feb 28, 29, Mar 1, 2, 3
  // Christmas 2027 is a Saturday: Monday Dec 27 is the s.88 substitute. Boxing Day (Sunday) and New Year's Day 2028
  // (Saturday) get no substitute under the rules found (unverified; see regulatory-references §10)
  assert.equal(cal.add("2027-12-24", 5), "2028-01-03");
  assert.equal(cal.isBusinessDay("2027-12-27"), false);
  assert.equal(cal.isBusinessDay("2027-12-28"), true);
});
