/**
 * Request validation for the trust ledger. Pure functions: no database, no
 * clock (today's date is passed in). Every request is checked in full and
 * all problems are reported together.
 */

import { ValidationError } from "../errors.ts";
import { type Cents } from "../lib/money.ts";
import { isUuid, Reader } from "../lib/reader.ts";

export { isUuid };

export const DEPOSIT_METHODS = ["BANK_DRAFT", "WIRE", "CERTIFIED_CHEQUE"] as const;
export const DISBURSEMENT_METHODS = ["CHEQUE", "EFT", "WIRE", "BANK_DRAFT"] as const;
export const PAYEE_TYPES = ["OUR_BROKERAGE", "COOP_BROKERAGE", "LAWYER", "PAYOR_REFUND"] as const;
export const AUTHORIZATION_METHODS = ["CLOSING_COMPLETED", "MUTUAL_RELEASE", "COURT_ORDER"] as const;
export const HOLD_REASONS = ["DISPUTED", "UNCLAIMED"] as const;

export type DepositMethod = (typeof DEPOSIT_METHODS)[number];
export type DisbursementMethod = (typeof DISBURSEMENT_METHODS)[number];
export type PayeeType = (typeof PAYEE_TYPES)[number];
export type AuthorizationMethod = (typeof AUTHORIZATION_METHODS)[number];
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Payee type → ledger entry type */
export const PAYEE_ENTRY_TYPE = {
  OUR_BROKERAGE: "DISBURSEMENT_TO_GENERAL",
  COOP_BROKERAGE: "DISBURSEMENT_TO_COOP",
  LAWYER: "DISBURSEMENT_TO_LAWYER",
  PAYOR_REFUND: "REFUND_TO_PAYER",
} as const satisfies Record<PayeeType, string>;

export interface DepositInput {
  dealId: string;
  trustAccountId: string;
  amount: Cents;
  method: DepositMethod;
  dateReceived: string;
  dateDeposited: string;
  payorName: string;
  bankReference: string;
  memo: string | null;
}

export interface DisbursementInput {
  dealId: string;
  trustAccountId: string;
  amount: Cents;
  method: DisbursementMethod;
  dateDisbursed: string;
  payeeType: PayeeType;
  payeeName: string;
  authorizationMethod: AuthorizationMethod;
  authorizationReference: string | null;
  referenceNo: string | null;
  memo: string | null;
}

export interface ReversalInput {
  reason: string;
  effectiveDate: string;
}

export interface HoldInput {
  reason: HoldReason;
  note: string;
  depositEntryId: string | null;
}

export interface ReleaseInput {
  releaseNote: string;
}

export function validateIdempotencyKey(header: unknown): string {
  if (!isUuid(header)) {
    throw new ValidationError([{ field: "Idempotency-Key", message: "header is required and must be a UUID" }]);
  }
  return header.toLowerCase();
}

export function validateDeposit(body: unknown, today: string): DepositInput {
  const r = new Reader(body, [
    "dealId", "trustAccountId", "amount", "method", "dateReceived", "dateDeposited",
    "payorName", "bankReference", "memo",
  ]);
  const input: DepositInput = {
    dealId: r.uuid("dealId"),
    trustAccountId: r.uuid("trustAccountId"),
    amount: r.amount("amount"),
    method: r.oneOf("method", DEPOSIT_METHODS),
    dateReceived: r.pastDate("dateReceived", today),
    dateDeposited: r.pastDate("dateDeposited", today),
    payorName: r.text("payorName", 200),
    bankReference: r.text("bankReference", 100),
    memo: r.optionalText("memo", 1000),
  };
  if (input.dateReceived && input.dateDeposited) {
    r.check(input.dateDeposited >= input.dateReceived, "dateDeposited", "cannot be before dateReceived");
  }
  r.done();
  return input;
}

export function validateDisbursement(body: unknown, today: string): DisbursementInput {
  const r = new Reader(body, [
    "dealId", "trustAccountId", "amount", "method", "dateDisbursed", "payeeType", "payeeName",
    "authorizationMethod", "authorizationReference", "referenceNo", "memo",
  ]);
  const input: DisbursementInput = {
    dealId: r.uuid("dealId"),
    trustAccountId: r.uuid("trustAccountId"),
    amount: r.amount("amount"),
    method: r.oneOf("method", DISBURSEMENT_METHODS),
    dateDisbursed: r.pastDate("dateDisbursed", today),
    payeeType: r.oneOf("payeeType", PAYEE_TYPES),
    payeeName: r.text("payeeName", 200),
    authorizationMethod: r.oneOf("authorizationMethod", AUTHORIZATION_METHODS),
    authorizationReference: r.optionalText("authorizationReference", 200),
    referenceNo: r.optionalText("referenceNo", 100),
    memo: r.optionalText("memo", 1000),
  };
  if (input.authorizationMethod === "MUTUAL_RELEASE" || input.authorizationMethod === "COURT_ORDER") {
    r.check(
      input.authorizationReference !== null,
      "authorizationReference",
      `is required for ${input.authorizationMethod} (e.g. the signed release or order reference)`,
    );
  }
  if (input.payeeType === "PAYOR_REFUND") {
    r.check(
      input.authorizationMethod !== "CLOSING_COMPLETED",
      "authorizationMethod",
      "a refund to the payor needs a MUTUAL_RELEASE or COURT_ORDER",
    );
  }
  r.done();
  return input;
}

export function validateReversal(body: unknown, today: string): ReversalInput {
  const r = new Reader(body, ["reason", "effectiveDate"]);
  const reason = r.text("reason", 1000);
  const effectiveDate = r.optionalPastDate("effectiveDate", today) ?? today;
  r.done();
  return { reason, effectiveDate };
}

export function validateHold(body: unknown): HoldInput {
  const r = new Reader(body, ["reason", "note", "depositEntryId"]);
  const input: HoldInput = {
    reason: r.oneOf("reason", HOLD_REASONS),
    note: r.text("note", 2000),
    depositEntryId: r.optionalUuid("depositEntryId"),
  };
  r.done();
  return input;
}

export function validateRelease(body: unknown): ReleaseInput {
  const r = new Reader(body, ["releaseNote"]);
  const releaseNote = r.text("releaseNote", 2000);
  r.done();
  return { releaseNote };
}

export function validatePathUuid(value: unknown, name: string): string {
  if (!isUuid(value)) throw new ValidationError([{ field: name, message: "must be a UUID" }]);
  return value;
}
