/**
 * Reads an untrusted JSON body field by field, collecting every problem
 * instead of stopping at the first one. Field names in issues are full paths
 * ("metadata.thirdParty.name", "agents[0].userId").
 */

import { ValidationError, type FieldIssue } from "../errors.ts";
import { isIsoDate } from "./dates.ts";
import { MAX_ENTRY_CENTS, parseAmount, type Cents } from "./money.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class Reader {
  readonly issues: FieldIssue[];
  private readonly body: Record<string, unknown>;
  private readonly prefix: string;

  /**
   * @param allowed fields this object may contain; anything else is reported
   * @param prefix  path of this object inside the request, for nested readers
   * @param issues  shared list, so nested readers report into their parent
   */
  constructor(body: unknown, allowed: readonly string[], prefix = "", issues: FieldIssue[] = []) {
    this.issues = issues;
    this.prefix = prefix;
    if (!isPlainObject(body)) {
      this.body = {};
      this.issues.push({ field: prefix || "body", message: "must be a JSON object" });
      return;
    }
    this.body = body;
    for (const key of Object.keys(body)) {
      if (!allowed.includes(key)) this.fail(key, "is not a recognised field");
    }
  }

  path(field: string): string {
    return this.prefix ? `${this.prefix}.${field}` : field;
  }

  fail(field: string, message: string): void {
    this.issues.push({ field: this.path(field), message });
  }

  has(field: string): boolean {
    return this.body[field] !== undefined && this.body[field] !== null;
  }

  raw(field: string): unknown {
    return this.body[field];
  }

  /** A reader for a nested object, reporting into this reader's issues. */
  nested(field: string, allowed: readonly string[]): Reader {
    return new Reader(this.body[field], allowed, this.path(field), this.issues);
  }

  /** Readers for each element of an array of objects. */
  objects(field: string, allowed: readonly string[], opts: { min?: number; max?: number } = {}): Reader[] {
    const v = this.body[field];
    if (!Array.isArray(v)) {
      this.fail(field, "must be a list");
      return [];
    }
    if (opts.min !== undefined && v.length < opts.min) this.fail(field, `needs at least ${opts.min}`);
    if (opts.max !== undefined && v.length > opts.max) this.fail(field, `allows at most ${opts.max}`);
    return v.map((item, i) => new Reader(item, allowed, `${this.path(field)}[${i}]`, this.issues));
  }

  uuid(field: string): string {
    const v = this.body[field];
    if (!isUuid(v)) this.fail(field, "must be a UUID");
    return v as string;
  }

  optionalUuid(field: string): string | null {
    return this.has(field) ? this.uuid(field) : null;
  }

  text(field: string, max: number, min = 1): string {
    const v = this.body[field];
    if (typeof v !== "string" || v.trim().length === 0) {
      this.fail(field, "is required");
      return "";
    }
    const t = v.trim();
    if (t.length < min) this.fail(field, `must be at least ${min} characters`);
    if (t.length > max) this.fail(field, `must be at most ${max} characters`);
    return t;
  }

  optionalText(field: string, max: number): string | null {
    const v = this.body[field];
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
    return this.text(field, max);
  }

  /** Non-empty list of non-empty strings. */
  textList(field: string, maxItems: number, maxLength: number): string[] {
    const v = this.body[field];
    if (!Array.isArray(v) || v.length === 0) {
      this.fail(field, "must be a non-empty list");
      return [];
    }
    if (v.length > maxItems) this.fail(field, `allows at most ${maxItems}`);
    return v.map((item, i) => {
      if (typeof item !== "string" || item.trim() === "" || item.trim().length > maxLength) {
        this.issues.push({ field: `${this.path(field)}[${i}]`, message: `must be text up to ${maxLength} characters` });
        return "";
      }
      return item.trim();
    });
  }

  bool(field: string): boolean {
    const v = this.body[field];
    if (typeof v !== "boolean") this.fail(field, "must be true or false");
    return v === true;
  }

  oneOf<T extends string>(field: string, options: readonly T[]): T {
    const v = this.body[field];
    if (typeof v !== "string" || !options.includes(v as T)) {
      this.fail(field, `must be one of ${options.join(", ")}`);
    }
    return v as T;
  }

  /** Decimal string money, > 0. */
  amount(field: string): Cents {
    const cents = parseAmount(this.body[field]);
    if (cents === null) {
      this.fail(field, 'must be a decimal string with up to 2 decimals, e.g. "40000.00"');
      return 0;
    }
    if (cents <= 0) this.fail(field, "must be greater than zero");
    if (cents > MAX_ENTRY_CENTS) this.fail(field, "is too large");
    return cents;
  }

  /** A number within [min, max] with at most 2 decimals (percentages). */
  percent(field: string, min: number, max: number): number {
    const v = this.body[field];
    if (typeof v !== "number" || !Number.isFinite(v) || Math.round(v * 100) !== v * 100) {
      this.fail(field, "must be a number with at most 2 decimals");
      return 0;
    }
    if (v < min || v > max) this.fail(field, `must be between ${min} and ${max}`);
    return v;
  }

  date(field: string): string {
    const v = this.body[field];
    if (!isIsoDate(v)) {
      this.fail(field, "must be a date in YYYY-MM-DD format");
      return "";
    }
    return v;
  }

  /** A calendar date that is not in the future. */
  pastDate(field: string, today: string): string {
    const v = this.date(field);
    if (v && v > today) this.fail(field, "cannot be in the future");
    return v;
  }

  optionalDate(field: string): string | null {
    return this.has(field) ? this.date(field) : null;
  }

  optionalPastDate(field: string, today: string): string | null {
    return this.has(field) ? this.pastDate(field, today) : null;
  }

  check(condition: boolean, field: string, message: string): void {
    if (!condition) this.fail(field, message);
  }

  done(): void {
    if (this.issues.length > 0) throw new ValidationError(this.issues);
  }
}
