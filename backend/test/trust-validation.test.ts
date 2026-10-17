import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidationError } from "../src/errors.ts";
import { businessDaysBetween, isIsoDate, todayInToronto } from "../src/lib/dates.ts";
import { formatCents, numericToCents, parseAmount } from "../src/lib/money.ts";
import { validateDeposit, validateDisbursement, validateHold } from "../src/trust/validation.ts";

const TODAY = "2026-10-17";
const DEAL = "6f1c1f43-7c55-4b8e-9d1a-0d6a1f0b9a01";
const ACCOUNT = "0b7e8c1a-2f3d-4e5f-8a9b-1c2d3e4f5a6b";

const deposit = {
  dealId: DEAL,
  trustAccountId: ACCOUNT,
  amount: "40000.00",
  method: "BANK_DRAFT",
  dateReceived: "2026-10-14",
  dateDeposited: "2026-10-15",
  payorName: "  John Buyer ",
  bankReference: "TD-DRAFT-55821",
};

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    return err.issues.map((i) => i.field);
  }
  assert.fail("expected a ValidationError");
}

test("money: parses and formats without floating point", () => {
  assert.equal(parseAmount("40000.00"), 4_000_000);
  assert.equal(parseAmount("0.1"), 10);
  assert.equal(parseAmount("12"), 1200);
  assert.equal(parseAmount("1.005"), null);
  assert.equal(parseAmount("-5.00"), null);
  assert.equal(parseAmount("01.00"), null);
  assert.equal(parseAmount(40000), null); // numbers rejected: amounts must be strings
  assert.equal(formatCents(4_000_050), "40000.50");
  assert.equal(numericToCents("-150.5"), -15050);
});

test("dates: Toronto 'today' and business days", () => {
  // 03:30 UTC on Oct 18 is still Oct 17 in Toronto
  assert.equal(todayInToronto(new Date("2026-10-18T03:30:00Z")), "2026-10-17");
  assert.equal(isIsoDate("2026-02-30"), false);
  assert.equal(businessDaysBetween("2026-10-16", "2026-10-19"), 1); // Fri → Mon
  assert.equal(businessDaysBetween("2026-10-14", "2026-10-22"), 6);
});

test("deposit: valid input is normalized", () => {
  const input = validateDeposit(deposit, TODAY);
  assert.equal(input.amount, 4_000_000);
  assert.equal(input.payorName, "John Buyer");
  assert.equal(input.memo, null);
});

test("deposit: every problem is reported at once", () => {
  const fields = issuesOf(() =>
    validateDeposit(
      {
        ...deposit,
        amount: "40000.001",
        method: "CHEQUE",              // personal cheques not accepted
        dateReceived: "2026-10-20",    // future, and after dateDeposited
        payorName: "",
        surprise: true,
      },
      TODAY,
    ),
  );
  assert.deepEqual(fields.sort(), ["amount", "dateDeposited", "dateReceived", "method", "payorName", "surprise"]);
});

test("deposit: cannot be deposited before it was received", () => {
  assert.deepEqual(issuesOf(() => validateDeposit({ ...deposit, dateDeposited: "2026-10-13" }, TODAY)), ["dateDeposited"]);
});

test("disbursement: release and court order need a reference; refunds can't use 'closing'", () => {
  const base = {
    dealId: DEAL,
    trustAccountId: ACCOUNT,
    amount: "40000.00",
    method: "EFT",
    dateDisbursed: "2026-10-16",
    payeeName: "John Buyer",
  };
  assert.deepEqual(
    issuesOf(() => validateDisbursement({ ...base, payeeType: "PAYOR_REFUND", authorizationMethod: "MUTUAL_RELEASE" }, TODAY)),
    ["authorizationReference"],
  );
  assert.deepEqual(
    issuesOf(() => validateDisbursement({ ...base, payeeType: "PAYOR_REFUND", authorizationMethod: "CLOSING_COMPLETED" }, TODAY)),
    ["authorizationMethod"],
  );
  const ok = validateDisbursement(
    { ...base, payeeType: "LAWYER", payeeName: "Smith LLP in trust", authorizationMethod: "CLOSING_COMPLETED" },
    TODAY,
  );
  assert.equal(ok.payeeType, "LAWYER");
});

test("hold: reason must be DISPUTED or UNCLAIMED and a note is required", () => {
  assert.deepEqual(issuesOf(() => validateHold({ reason: "ANGRY", note: " " })).sort(), ["note", "reason"]);
});
