/**
 * Request validation for the trust ledger. Pure functions: no database, no
 * clock (today's date is passed in). Every request is checked in full and
 * all problems are reported together.
 */

import { ValidationError, type FieldIssue } from "../errors.ts";
import { isIsoDate } from "../lib/dates.ts";
import { MAX_ENTRY_CENTS, parseAmount, type Cents } from "../lib/money.ts";

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Collects issues while reading an untrusted body. */
class Reader {
  readonly issues: FieldIssue[] = [];
  private readonly body: Record<string, unknown>;

  constructor(body: unknown, allowed: readonly string[]) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      this.body = {};
      this.issues.push({ field: "body", message: "must be a JSON object" });
      return;
    }
    this.body = body as Record<string, unknown>;
    for (const key of Object.keys(this.body)) {
      if (!allowed.includes(key)) this.issues.push({ field: key, message: "is not a recognised field" });
    }
  }

  private fail(field: string, message: string): void {
    this.issues.push({ field, message });
  }

  uuid(field: string): string {
    const v = this.body[field];
    if (!isUuid(v)) this.fail(field, "must be a UUID");
    return v as string;
  }

  optionalUuid(field: string): string | null {
    const v = this.body[field];
    if (v === undefined || v === null) return null;
    return this.uuid(field);
  }

  text(field: string, max: number): string {
    const v = this.body[field];
    if (typeof v !== "string" || v.trim().length === 0) {
      this.fail(field, "is required");
      return "";
    }
    if (v.trim().length > max) this.fail(field, `must be at most ${max} characters`);
    return v.trim();
  }

  optionalText(field: string, max: number): string | null {
    const v = this.body[field];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
    return this.text(field, max);
  }

  oneOf<T extends string>(field: string, options: readonly T[]): T {
    const v = this.body[field];
    if (typeof v !== "string" || !options.includes(v as T)) {
      this.fail(field, `must be one of ${options.join(", ")}`);
    }
    return v as T;
  }

  amount(field: string): Cents {
    const cents = parseAmount(this.body[field]);
    if (cents === null) {
      this.fail(field, 'must be a decimal string with up to 2 decimals, e.g. "40000.00"');
      return 0;
    }
    if (cents <= 0) this.fail(field, "must be greater than zero");
    if (cents > MAX_ENTRY_CENTS) this.fail(field, "is larger than a single trust entry allows");
    return cents;
  }

  /** A calendar date that is not in the future. */
  pastDate(field: string, today: string): string {
    const v = this.body[field];
    if (!isIsoDate(v)) {
      this.fail(field, "must be a date in YYYY-MM-DD format");
      return "";
    }
    if (v > today) this.fail(field, "cannot be in the future");
    return v;
  }

  optionalPastDate(field: string, today: string): string | null {
    const v = this.body[field];
    if (v === undefined || v === null) return null;
    return this.pastDate(field, today);
  }

  check(condition: boolean, field: string, message: string): void {
    if (!condition) this.fail(field, message);
  }

  done(): void {
    if (this.issues.length > 0) throw new ValidationError(this.issues);
  }
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
