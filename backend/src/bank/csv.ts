/**
 * Bank statement CSV parsing. Pure.
 *
 * Canadian bank exports differ, so columns are found by header name:
 * a date, a description, and either one signed amount column or separate
 * debit / credit (withdrawal / deposit) columns. TD's headerless export
 * (date, description, debit, credit, balance) is recognised too.
 * Money is parsed to integer cents; a running balance column, when present,
 * is checked line by line.
 */

import type { Cents } from "../lib/money.ts";
import { isIsoDate } from "../lib/dates.ts";

export type DateOrder = "MDY" | "DMY" | "YMD";

export interface BankLine {
  lineNumber: number; // 1-based row in the file, header included
  postedDate: string;
  amount: Cents; // + money in, − money out
  description: string;
  reference: string | null;
  balance: Cents | null;
}

export class BankCsvError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join("; "));
    this.issues = issues;
  }
}

/** RFC 4180: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

const ALIASES = {
  date: ["date", "transaction date", "posted date", "posting date", "trans date", "value date"],
  description: ["description", "transaction description", "details", "description 1", "memo", "narrative", "payee"],
  description2: ["description 2"],
  amount: ["amount", "cad$", "amount (cad)", "cad amount", "transaction amount"],
  debit: ["debit", "debits", "withdrawal", "withdrawals", "withdrawals ($)", "debit amount", "money out"],
  credit: ["credit", "credits", "deposit", "deposits", "deposits ($)", "credit amount", "money in"],
  reference: ["reference", "ref", "reference number", "cheque number", "cheque #", "cheque no", "transaction id", "confirmation"],
  balance: ["balance", "running balance", "balance ($)"],
} as const;

type Field = keyof typeof ALIASES;
const norm = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");

const MONEY = /^\(?-?\$?\s*-?[0-9]{1,3}(,?[0-9]{3})*(\.[0-9]{1,2})?\)?-?$/;

/** "$1,234.56", "-1234.56", "(1,234.56)", "1234.56-" to cents; null for blank. */
export function parseBankMoney(raw: string): Cents | null {
  const s = raw.trim().replace(/\s?CAD$/i, "");
  if (s === "") return null;
  if (!MONEY.test(s)) throw new Error(`'${raw}' is not an amount`);
  const negative = s.includes("-") || (s.startsWith("(") && s.endsWith(")"));
  const digits = s.replace(/[^0-9.]/g, "");
  const [whole, fraction = ""] = digits.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
}

export function parseBankDate(raw: string, order: DateOrder): string {
  if (isIsoDate(raw.trim())) return raw.trim();
  const s = raw.trim();
  const parts = s.split(/[/.\-\s]+/);
  if (parts.length !== 3 || parts.some((p) => !/^[0-9]+$/.test(p))) throw new Error(`'${raw}' is not a date`);
  let [y, m, d] = order === "YMD" ? parts : order === "MDY" ? [parts[2]!, parts[0]!, parts[1]!] : [parts[2]!, parts[1]!, parts[0]!];
  if (y!.length === 2) y = `20${y}`;
  const iso = `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  if (!isIsoDate(iso)) throw new Error(`'${raw}' is not a valid ${order} date`);
  return iso;
}

function findColumns(header: string[]): Partial<Record<Field, number>> | null {
  const cols: Partial<Record<Field, number>> = {};
  header.forEach((h, i) => {
    for (const [field, names] of Object.entries(ALIASES) as [Field, readonly string[]][]) {
      if (cols[field] === undefined && names.includes(norm(h))) cols[field] = i;
    }
  });
  const hasMoney = cols.amount !== undefined || cols.debit !== undefined || cols.credit !== undefined;
  return cols.date !== undefined && hasMoney ? cols : null;
}

export function parseBankCsv(text: string, order: DateOrder = "MDY"): BankLine[] {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new BankCsvError(["the file is empty"]);

  let cols = findColumns(rows[0]!);
  let firstData = 1;
  if (!cols) {
    // TD: no header, date, description, debit, credit, balance
    if (rows[0]!.length === 5) {
      cols = { date: 0, description: 1, debit: 2, credit: 3, balance: 4 };
      firstData = 0;
    } else {
      throw new BankCsvError([
        "couldn't find the date and amount columns; expected headers like Date, Description, Amount (or Debit / Credit)",
      ]);
    }
  }

  const issues: string[] = [];
  const lines: BankLine[] = [];
  for (let r = firstData; r < rows.length; r++) {
    const row = rows[r]!;
    const at = (i: number | undefined) => (i === undefined ? "" : (row[i] ?? "").trim());
    const lineNumber = r + 1;
    try {
      const postedDate = parseBankDate(at(cols.date), order);
      let amount: Cents | null;
      if (cols.amount !== undefined) {
        amount = parseBankMoney(at(cols.amount));
      } else {
        const debit = parseBankMoney(at(cols.debit));
        const credit = parseBankMoney(at(cols.credit));
        if (debit && credit) throw new Error("has both a debit and a credit");
        amount = credit ? Math.abs(credit) : debit ? -Math.abs(debit) : null;
      }
      if (!amount) throw new Error("has no amount");
      const description = [at(cols.description), at(cols.description2)].filter(Boolean).join(" ").slice(0, 500);
      lines.push({
        lineNumber, postedDate, amount, description: description || "(no description)",
        reference: at(cols.reference).slice(0, 100) || null,
        balance: cols.balance === undefined ? null : parseBankMoney(at(cols.balance)),
      });
    } catch (err) {
      issues.push(`line ${lineNumber}: ${(err as Error).message}`);
    }
  }
  if (issues.length) throw new BankCsvError(issues.slice(0, 20));
  if (lines.length === 0) throw new BankCsvError(["the file has no transactions"]);

  // Some banks export newest first; statements are kept oldest first
  const ordered = lines[0]!.postedDate > lines[lines.length - 1]!.postedDate ? [...lines].reverse() : lines;
  return ordered;
}

/** Checks a running-balance column against the opening balance, line by line. */
export function checkRunningBalance(lines: BankLine[], opening: Cents): string | null {
  if (lines.every((l) => l.balance === null)) return null;
  let running = opening;
  for (const l of lines) {
    running += l.amount;
    if (l.balance !== null && l.balance !== running) {
      return `line ${l.lineNumber}: the bank's running balance is ${(l.balance / 100).toFixed(2)}, but the opening balance plus transactions give ${(running / 100).toFixed(2)}`;
    }
  }
  return null;
}
