import { test } from "node:test";
import assert from "node:assert/strict";
import { depositStatus, type DepositFacts } from "../src/pipeline/deposit-status.ts";

// Thursday, Oct 15 2026
const base: DepositFacts = { holder: "OUR_BROKERAGE", expectedCents: 5_000_000, dueDate: "2026-10-09", deposits: [], today: "2026-10-15" };
const dep = (receivedDate: string, depositedDate: string, amountCents = 5_000_000, bankCleared = true) =>
  ({ amountCents, receivedDate, depositedDate, receiptNumber: 1042, bankCleared });

test("full deposit banked within 5 business days: green, Received & Cleared", () => {
  // Received Fri Oct 2, banked Fri Oct 9: Mon–Fri in between = 5 business days, on the limit
  const b = depositStatus({ ...base, deposits: [dep("2026-10-02", "2026-10-09")] });
  assert.equal(b.state, "CLEARED");
  assert.equal(b.tone, "good");
  assert.equal(b.label, "Deposit Received & Cleared");
  assert.equal(b.detail, "$50,000 in trust · receipt #1042");
});

test("recorded, not yet matched to the bank, still within 5 business days of receipt: amber, not yet cleared", () => {
  // Received Fri Oct 9; today Thu Oct 15 is 3 business days later (Thanksgiving Oct 12 doesn't count)
  const b = depositStatus({ ...base, deposits: [dep("2026-10-09", "2026-10-09", 5_000_000, false)] });
  assert.equal(b.state, "AWAITING_BANK");
  assert.equal(b.tone, "warning");
  assert.equal(b.label, "Received – not yet cleared");
  assert.equal(b.detail, "$50,000 recorded in trust but not yet matched to the bank statement");
});

test("no bank record 5 business days after receipt: red, whatever date was typed in", () => {
  // Received Fri Oct 2 and entered as deposited the same day, but no bank line matches it by Thu Oct 15
  const b = depositStatus({ ...base, deposits: [dep("2026-10-02", "2026-10-02", 5_000_000, false)] });
  assert.equal(b.state, "LATE_TO_TRUST");
  assert.equal(b.label, "Not at the bank after 5 business days");
  assert.equal(b.detail, "Received Oct 2; no bank record of the deposit 8 business days later (limit 5)");
});

test("the bank's posting date is the evidence: entered as deposited on time, posted by the bank late", () => {
  // Received Fri Oct 2, entered as deposited Mon Oct 5, but the bank statement shows it on Wed Oct 14
  const b = depositStatus({ ...base, deposits: [{ ...dep("2026-10-02", "2026-10-05"), bankDate: "2026-10-14" }] });
  assert.equal(b.state, "LATE_TO_TRUST");
  assert.equal(b.detail, "Received Oct 2, at the bank Oct 14 (bank statement): 7 business days (limit 5)");
  // ...and posted on time, it's green
  const ok = depositStatus({ ...base, deposits: [{ ...dep("2026-10-02", "2026-10-05"), bankDate: "2026-10-06" }] });
  assert.equal(ok.state, "CLEARED");
});

test("banked on the 6th business day: red, late to trust", () => {
  // Received Fri Oct 2, banked Tue Oct 13: Oct 5–9 and 13 are business days; Thanksgiving (Oct 12) isn't
  const b = depositStatus({ ...base, deposits: [dep("2026-10-02", "2026-10-13")] });
  assert.equal(b.state, "LATE_TO_TRUST");
  assert.equal(b.tone, "critical");
  assert.match(b.detail, /6 business days \(limit 5\)/);
});

test("statutory holidays don't count: banked the Monday after Thanksgiving weekend is on time", () => {
  // Received Fri Oct 2, banked Mon Oct 12 (Thanksgiving): still 5 business days
  assert.equal(depositStatus({ ...base, deposits: [dep("2026-10-02", "2026-10-12")] }).state, "CLEARED");
  // Good Friday and Easter Monday 2026 (Apr 3 and 6): received Wed Apr 1, banked Fri Apr 10 = 5 business days
  assert.equal(depositStatus({ ...base, deposits: [dep("2026-04-01", "2026-04-10")] }).state, "CLEARED");
  assert.equal(depositStatus({ ...base, deposits: [dep("2026-04-01", "2026-04-13")] }).state, "LATE_TO_TRUST");
});

test("nothing received and the APS due date has passed: red, Missing / Overdue", () => {
  const b = depositStatus(base);
  assert.equal(b.state, "OVERDUE");
  assert.equal(b.label, "Deposit Missing / Overdue");
  assert.equal(b.detail, "$50,000 was due Oct 9 (3 business days ago)"); // Oct 13–15; Thanksgiving doesn't count
});

test("part received after the due date is still overdue; before it, partial", () => {
  const short = [dep("2026-10-05", "2026-10-06", 2_500_000)];
  assert.equal(depositStatus({ ...base, deposits: short }).state, "OVERDUE");
  const early = depositStatus({ ...base, dueDate: "2026-10-20", deposits: short });
  assert.equal(early.state, "PARTIAL");
  assert.equal(early.detail, "$25,000 of $50,000 in trust; balance due Oct 20");
});

test("not due yet, no due date, or not our deposit to hold", () => {
  assert.equal(depositStatus({ ...base, dueDate: "2026-10-16" }).label, "Deposit due Oct 16");
  assert.equal(depositStatus({ ...base, dueDate: null }).state, "NOT_RECORDED");
  const coop = depositStatus({ ...base, holder: "COOP_BROKERAGE" });
  assert.equal(coop.state, "HELD_ELSEWHERE");
  assert.equal(coop.label, "Held by co-op brokerage");
});
