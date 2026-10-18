/**
 * Domain errors. Each carries a stable `code` for the API client and the HTTP
 * status it maps to. Route handlers never build error responses by hand.
 */

export interface FieldIssue {
  field: string;
  message: string;
}

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends DomainError {
  readonly issues: FieldIssue[];

  constructor(issues: FieldIssue[]) {
    super("VALIDATION_FAILED", 400, issues.map((i) => `${i.field}: ${i.message}`).join("; "), { issues });
    this.issues = issues;
  }
}

export class UnauthenticatedError extends DomainError {
  constructor() {
    super("UNAUTHENTICATED", 401, "Sign in required");
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string) {
    super("FORBIDDEN", 403, message);
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string, id: string) {
    super("NOT_FOUND", 404, `${what} ${id} not found`, { id });
  }
}

/** Business rule refused the request (deal state, deposit holder, etc.). */
export class RuleViolationError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, 422, message, details);
  }
}

/** TRESA segregation: a deal can never pay out more than it holds. */
export class InsufficientTrustFundsError extends DomainError {
  constructor(dealId: string, available: string, requested: string) {
    super(
      "INSUFFICIENT_TRUST_FUNDS",
      409,
      `Deal ${dealId} holds $${available} in trust; $${requested} was requested`,
      { dealId, available, requested },
    );
  }
}

export class TrustHoldActiveError extends DomainError {
  constructor(dealId: string, holdId?: string, reason?: string) {
    super("TRUST_HOLD_ACTIVE", 423, `Deal ${dealId} has an active trust hold; no funds can be disbursed`, {
      dealId,
      holdId,
      reason,
    });
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, 409, message, details);
  }
}

/**
 * Turns database errors raised by the trust triggers (migration 003) into
 * domain errors. These are the backstop: the service checks first, so they
 * only fire if something bypasses it.
 */
export function fromDatabaseError(err: unknown): DomainError | null {
  const meta = (err as { meta?: { code?: string; message?: string } })?.meta;
  const sqlState = meta?.code;
  const message = meta?.message ?? (err as Error)?.message ?? "";
  switch (sqlState) {
    case "ZT001":
      return new DomainError("INSUFFICIENT_TRUST_FUNDS", 409, message);
    case "ZT002":
      return new DomainError("TRUST_HOLD_ACTIVE", 423, message);
    case "ZT003":
      return new ForbiddenError(message);
    case "ZT004":
      return new RuleViolationError("INVALID_REVERSAL", message);
    case "ZT005":
      return new DomainError("TRUST_LEDGER_IMMUTABLE", 405, message);
    case "ZT006":
      return new RuleViolationError("TRUST_HOLD_RULE", message);
    case "ZD001":
      return new ConflictError("ILLEGAL_STATUS_CHANGE", message);
    case "ZD002":
      return new ForbiddenError(message);
    case "ZD003":
      return new DomainError("APPEND_ONLY", 405, message);
    case "ZD004":
      return new RuleViolationError("PAYOUT_RULE", message);
    case "ZT007":
      return new DomainError("FUNDS_NOT_CLEARED", 409, message);
    case "ZT008":
      return new DomainError("FUNDS_NOT_AVAILABLE", 409, message);
    case "ZB001":
      return new RuleViolationError("BANK_RULE", message);
    case "ZP001":
      return new DomainError("POLICY_NOT_APPROVED", 409, message);
    default:
      return null;
  }
}

/** Postgres unique violation, with the constraint/index name when available. */
export function uniqueViolation(err: unknown): string | null {
  const e = err as { code?: string; meta?: { code?: string; message?: string; target?: unknown } };
  if (e?.meta?.code === "23505") return e.meta.message ?? "unique";
  if (e?.code === "P2002") return String(e.meta?.target ?? "unique");
  return null;
}
