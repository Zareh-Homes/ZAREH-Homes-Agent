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

test("recorded on time but not yet matched to the bank statement: amber, not yet cleared", () => {
  const b = depositStatus({ ...base, deposits: [dep("2026-10-02", "2026-10-09", 5_000_000, false)] });
  assert.equal(b.state, "AWAITING_BANK");
  assert.equal(b.tone, "warning");
  assert.equal(b.label, "Received – not yet cleared");
  assert.equal(b.detail, "$50,000 recorded in trust but not yet matched to the bank statement");
});

test("banked on the 6th business day: red, late to trust", () => {
  const b = depositStatus({ ...base, deposits: [dep("2026-10-02", "2026-10-12")] });
  assert.equal(b.state, "LATE_TO_TRUST");
  assert.equal(b.tone, "critical");
  assert.match(b.detail, /6 business days \(limit 5\)/);
});

test("nothing received and the APS due date has passed: red, Missing / Overdue", () => {
  const b = depositStatus(base);
  assert.equal(b.state, "OVERDUE");
  assert.equal(b.label, "Deposit Missing / Overdue");
  assert.equal(b.detail, "$50,000 was due Oct 9 (4 business days ago)");
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
