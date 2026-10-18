import { test } from "node:test";
import assert from "node:assert/strict";
import { BankCsvError, checkRunningBalance, parseBankCsv, parseBankDate, parseBankMoney, parseCsv } from "../src/bank/csv.ts";
import { reconcile, type ReconLedgerEntry } from "../src/bank/reconcile.ts";
import { proposeMatches } from "../src/bank/service.ts";

const $ = (dollars: number) => Math.round(dollars * 100);

// ── CSV ──────────────────────────────────────────────────────────────────────

test("csv: quoted fields, doubled quotes, CRLF and blank lines", () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n\r\n1,2,3\n'), [["a", "b, c", 'say "hi"'], ["1", "2", "3"]]);
});

test("csv: bank money and dates", () => {
  assert.equal(parseBankMoney("$1,234.56"), 123_456);
  assert.equal(parseBankMoney("(1,234.56)"), -123_456);
  assert.equal(parseBankMoney("1234.5-"), -123_450);
  assert.equal(parseBankMoney("-$12.50"), -1_250);
  assert.equal(parseBankMoney(" "), null);
  assert.throws(() => parseBankMoney("12abc"));
  assert.equal(parseBankDate("10/15/2026", "MDY"), "2026-10-15");
  assert.equal(parseBankDate("15/10/2026", "DMY"), "2026-10-15");
  assert.equal(parseBankDate("2026-10-15", "MDY"), "2026-10-15");
  assert.throws(() => parseBankDate("15/10/2026", "MDY"), /not a valid MDY date/);
});

test("csv: headed export with signed amounts, newest first, is returned oldest first", () => {
  const lines = parseBankCsv([
    "Date,Description,Reference,Amount,Balance",
    "10/31/2026,SERVICE CHARGE,,-12.50,\"69,987.50\"",
    "10/21/2026,WIRE IN,WIRE-B,\"20,000.00\",\"70,000.00\"",
    "10/15/2026,DEPOSIT,DRAFT-881,50000.00,50000.00",
  ].join("\n"));
  assert.deepEqual(lines.map((l) => [l.postedDate, l.amount, l.reference]), [
    ["2026-10-15", $(50_000), "DRAFT-881"], ["2026-10-21", $(20_000), "WIRE-B"], ["2026-10-31", $(-12.5), null],
  ]);
  assert.equal(checkRunningBalance(lines, 0), null);
  assert.match(checkRunningBalance(lines, $(1))!, /running balance is 50000.00/);
});

test("csv: debit / credit columns, and TD's headerless layout", () => {
  const headed = parseBankCsv("Transaction Date,Description 1,Description 2,Withdrawals,Deposits\n2026-11-20,EFT,To general,30000.00,\n");
  assert.deepEqual(headed.map((l) => [l.amount, l.description]), [[$(-30_000), "EFT To general"]]);
  const td = parseBankCsv("11/20/2026,EFT TO GENERAL,30000.00,,20000.00\n11/21/2026,WIRE IN,,500.00,20500.00\n");
  assert.deepEqual(td.map((l) => [l.amount, l.balance]), [[$(-30_000), $(20_000)], [$(500), $(20_500)]]);
});

test("csv: unusable files say exactly what's wrong", () => {
  assert.throws(() => parseBankCsv("Foo,Bar\n1,2\n"), (e: unknown) => e instanceof BankCsvError && /couldn't find the date/.test(e.message));
  assert.throws(() => parseBankCsv("Date,Amount\n13/45/2026,5.00\n"), /line 2: '13\/45\/2026' is not a valid MDY date/);
  assert.throws(() => parseBankCsv("Date,Debit,Credit\n10/01/2026,5.00,5.00\n"), /both a debit and a credit/);
});

// ── Auto-matching ────────────────────────────────────────────────────────────

test("auto-match: one sensible candidate, or a unique reference; never a guess", () => {
  const line = (id: string, amount: number, postedDate: string, text = "") => ({ id, amount: $(amount), postedDate, text });
  const entry = (id: string, amount: number, date: string, reference: string | null = null) => ({ id, signed: $(amount), date, reference });

  const m = proposeMatches(
    [line("L1", 50_000, "2026-10-15", "DEPOSIT DRAFT-881"), line("L2", 20_000, "2026-10-21"), line("L3", -30_000, "2026-11-20")],
    [entry("E1", 50_000, "2026-10-15", "DRAFT-881"), entry("E2", 20_000, "2026-10-20"), entry("E3", -30_000, "2026-11-02")],
  );
  assert.deepEqual([...m.entries()].sort(), [["L1", "E1"], ["L2", "E2"], ["L3", "E3"]]);

  // Two identical $10,000 deposits the same week: the reference decides, or nothing is matched
  const twins = [entry("A", 10_000, "2026-10-05", "W-1"), entry("B", 10_000, "2026-10-06", "W-2")];
  assert.deepEqual([...proposeMatches([line("L", 10_000, "2026-10-06", "WIRE W-2")], twins)], [["L", "B"]]);
  assert.equal(proposeMatches([line("L", 10_000, "2026-10-06", "WIRE")], twins).size, 0);

  // A deposit 6+ days off isn't the same deposit; a cheque can clear weeks later
  assert.equal(proposeMatches([line("L", 5_000, "2026-10-20")], [entry("E", 5_000, "2026-10-12")]).size, 0);
  assert.equal(proposeMatches([line("L", -5_000, "2026-11-20")], [entry("E", -5_000, "2026-10-12")]).size, 1);
  // A returned deposit on the 25th is not the cheque written on the 28th
  assert.equal(proposeMatches([line("L", -20_000, "2026-11-25")], [entry("E", -20_000, "2026-11-28")]).size, 0);
});

// ── Reconciliation ───────────────────────────────────────────────────────────

const e = (id: string, deal: string, amount: number, date: string, match: ReconLedgerEntry["match"]): ReconLedgerEntry => ({
  id, dealId: deal, dealNumber: deal, entryType: amount > 0 ? "DEPOSIT_RECEIVED" : "DISBURSEMENT_TO_LAWYER",
  signedAmount: $(amount), effectiveDate: date, referenceNo: null, counterparty: null, match,
});
const atBank = (postedDate: string) => ({ basis: "BANK_STATEMENT" as const, postedDate });

test("reconcile: outstanding cheque, deposit in transit and pre-cutover history; three figures agree", () => {
  const r = reconcile({
    periodEnd: "2026-11-30",
    bankClosingBalance: $(55_000),
    entries: [
      e("1", "A", 50_000, "2026-10-15", atBank("2026-10-15")),
      e("2", "A", -20_000, "2026-11-28", null), // cheque to the lawyer, not cleared yet
      e("3", "B", 10_000, "2026-11-30", atBank("2026-12-01")), // deposit in transit
      e("4", "C", 5_000, "2026-09-10", { basis: "PRE_CUTOVER", postedDate: null }), // migrated history
    ],
    bankLines: [{ id: "b1", postedDate: "2026-10-15", amount: $(50_000), description: "DEPOSIT", matchedEntryDate: "2026-10-15" }],
  });
  // Bank 55,000 + transit 10,000 − cheque 20,000 = 45,000 = ledger = A 30,000 + B 10,000 + C 5,000
  assert.equal(r.outstandingDeposits, $(10_000));
  assert.equal(r.outstandingDisbursements, $(20_000));
  assert.equal(r.adjustedBankBalance, $(45_000));
  assert.equal(r.ledgerBalance, $(45_000));
  assert.equal(r.clientLiabilities, $(45_000));
  assert.equal(r.difference, 0);
  assert.equal(r.isBalanced, true);
  assert.deepEqual(r.details.deals.map((d) => [d.dealNumber, d.balance]), [["A", $(30_000)], ["B", $(10_000)], ["C", $(5_000)]]);
  assert.deepEqual(r.details.outstanding.map((o) => o.entryId), ["2", "3"]);
  assert.deepEqual(r.details.exceptions, []);
});

test("reconcile: a bank fee or returned deposit is a shortfall until it's dealt with, never netted away", () => {
  const r = reconcile({
    periodEnd: "2026-10-31",
    bankClosingBalance: $(69_987.5),
    entries: [e("1", "A", 50_000, "2026-10-15", atBank("2026-10-15")), e("2", "B", 20_000, "2026-10-20", atBank("2026-10-21"))],
    bankLines: [
      { id: "b1", postedDate: "2026-10-15", amount: $(50_000), description: "DEPOSIT", matchedEntryDate: "2026-10-15" },
      { id: "b2", postedDate: "2026-10-21", amount: $(20_000), description: "WIRE", matchedEntryDate: "2026-10-20" },
      { id: "b3", postedDate: "2026-10-31", amount: $(-12.5), description: "SERVICE CHARGE", matchedEntryDate: null },
    ],
  });
  assert.equal(r.unrecordedBankItems, $(-12.5));
  assert.equal(r.difference, $(-12.5));
  assert.equal(r.isBalanced, false);
  assert.match(r.details.exceptions[0]!, /^Shortfall: the bank holds \$12\.50 less .* \(explained by the unrecorded bank items below\)$/);
  assert.match(r.details.exceptions[1]!, /SERVICE CHARGE/);
});

test("reconcile: stale deposits and overdrawn deals are flagged", () => {
  const r = reconcile({
    periodEnd: "2026-10-30",
    bankClosingBalance: $(0),
    entries: [e("1", "A", 25_000, "2026-10-15", null), e("2", "B", -100, "2026-10-29", null)],
    bankLines: [],
  });
  assert.deepEqual(r.details.staleDeposits.map((s) => [s.dealNumber, s.businessDaysOutstanding]), [["A", 11]]);
  assert.deepEqual(r.details.shortfalls.map((s) => s.dealNumber), ["B"]);
  assert.equal(r.clientLiabilities, $(25_000));
  assert.equal(r.isBalanced, false);
  assert.ok(r.details.exceptions.some((x) => /Deal B is overdrawn by \$100\.00/.test(x)));
  assert.ok(r.details.exceptions.some((x) => /isn't at the bank after 11 business days/.test(x)));
});
