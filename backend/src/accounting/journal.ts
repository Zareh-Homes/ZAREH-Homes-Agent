/**
 * The back office's money movements as balanced journal entries, for the
 * accountant to import. Pure. Cash basis, only what actually happened:
 *
 *   commission received     Dr bank (operating or commission trust)   Cr commission clearing
 *   commission returned     Dr commission clearing                     Cr bank
 *   trust → general         Dr bank (operating)                        Cr commission clearing
 *   payout sent             Dr agent / co-op / referral payable        Cr bank
 *   payout returned         Dr bank                                    Cr the same payable
 *
 * Accounts are roles; the accountant maps each role to a code in the chart of
 * accounts (ACCOUNTING_ACCOUNT_MAP). An entry with an unmapped role is
 * exported but marked not ready. Revenue recognition, HST and agent expense
 * classification are the accountant's: the clearing account holds them until
 * they're booked.
 */

import { formatCents, type Cents } from "../lib/money.ts";

export const ACCOUNT_ROLES = [
  "BANK_OPERATING", "BANK_COMMISSION_TRUST", "COMMISSION_CLEARING", "AGENT_COMMISSION_PAYABLE", "COOP_PAYABLE", "REFERRAL_PAYABLE",
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export interface Movement {
  id: string;
  date: string;
  kind: "COMMISSION_RECEIVED" | "COMMISSION_RETURNED" | "TRUST_TO_GENERAL" | "PAYOUT_SENT" | "PAYOUT_RETURNED";
  amount: Cents;
  dealNumber: string;
  reference: string | null;
  bank: "BANK_OPERATING" | "BANK_COMMISSION_TRUST";
  payable?: "AGENT_COMMISSION_PAYABLE" | "COOP_PAYABLE" | "REFERRAL_PAYABLE";
  payee?: string | null;
}

export interface JournalLine {
  role: AccountRole;
  accountCode: string | null;
  debit: string;
  credit: string;
}

export interface JournalEntry {
  sourceId: string;
  date: string;
  memo: string;
  reference: string | null;
  lines: JournalLine[];
  ready: boolean;
}

export function buildJournal(movements: Movement[], accountMap: Partial<Record<AccountRole, string>>): JournalEntry[] {
  const line = (role: AccountRole, debit: Cents, credit: Cents): JournalLine =>
    ({ role, accountCode: accountMap[role] ?? null, debit: formatCents(debit), credit: formatCents(credit) });
  return [...movements].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)).map((m) => {
    const [dr, cr]: [AccountRole, AccountRole] =
      m.kind === "COMMISSION_RECEIVED" ? [m.bank, "COMMISSION_CLEARING"]
      : m.kind === "COMMISSION_RETURNED" ? ["COMMISSION_CLEARING", m.bank]
      : m.kind === "TRUST_TO_GENERAL" ? ["BANK_OPERATING", "COMMISSION_CLEARING"]
      : m.kind === "PAYOUT_SENT" ? [m.payable!, m.bank]
      : [m.bank, m.payable!];
    const lines = [line(dr, m.amount, 0), line(cr, 0, m.amount)];
    const label = m.kind.toLowerCase().replaceAll("_", " ");
    return {
      sourceId: m.id, date: m.date, reference: m.reference,
      memo: `${label[0]!.toUpperCase()}${label.slice(1)} · ${m.dealNumber}${m.payee ? ` · ${m.payee}` : ""}`,
      lines, ready: lines.every((l) => l.accountCode !== null),
    };
  });
}

const csvCell = (v: string | null) => {
  const s = v ?? "";
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // never let a spreadsheet run a formula
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function journalCsv(entries: JournalEntry[]): string {
  const rows = [["Date", "Entry", "Memo", "Reference", "Account role", "Account code", "Debit", "Credit"]];
  for (const e of entries) for (const l of e.lines) rows.push([e.date, e.sourceId, e.memo, e.reference ?? "", l.role, l.accountCode ?? "UNMAPPED", l.debit, l.credit]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
