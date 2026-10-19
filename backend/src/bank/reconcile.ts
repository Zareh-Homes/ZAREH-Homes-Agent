/**
 * Monthly trust reconciliation (O. Reg. 579/05 s.13). Pure: no database.
 *
 * Three figures must agree at the statement date D:
 *
 *   1. Adjusted bank balance = bank closing balance
 *                              + deposits in the ledger not yet at the bank   (outstanding deposits)
 *                              − payments in the ledger not yet cleared       (outstanding disbursements)
 *   2. Ledger balance        = every trust entry dated ≤ D
 *   3. Client liabilities    = Σ each deal's trust balance (what the brokerage owes, deal by deal)
 *
 * Bank items not in the ledger (fees, returned deposits, unknown withdrawals)
 * are listed as "unrecorded" and explain the difference, but never cancel it:
 * if the bank holds less than clients are owed, that is a shortfall until the
 * ledger records the item and the brokerage makes it good.
 *
 * An item is settled at D only if both sides are dated ≤ D. History attested
 * as pre-cutover counts as settled. A deal with a negative balance is a
 * shortfall: liabilities can't be covered by another deal's money.
 *
 * s.13 also needs the balance owed to each person. Each deal's balance is
 * attributed to whoever deposited it, net of refunds to them. When a deal
 * holds money from more than one depositor the split is shown pro rata and
 * flagged for review: the ledger can't know how the parties agreed to share it.
 */

import { businessDaysBetween } from "../lib/dates.ts";
import type { Cents } from "../lib/money.ts";
import { STATUTORY_CALENDAR, type BusinessCalendar } from "../lib/ontario-calendar.ts";

export const STALE_DEPOSIT_BUSINESS_DAYS = 5;

export interface ReconLedgerEntry {
  id: string;
  dealId: string;
  dealNumber: string;
  entryType: string;
  signedAmount: Cents; // amount × direction
  effectiveDate: string;
  /** Deposits: the day the money came into the brokerage's hands (s.17's five business days run from here) */
  receivedDate?: string | null;
  referenceNo: string | null;
  counterparty: string | null;
  match: { basis: "BANK_STATEMENT" | "PRE_CUTOVER"; postedDate: string | null } | null;
}

export interface ReconBankLine {
  id: string;
  postedDate: string;
  amount: Cents;
  description: string;
  matchedEntryDate: string | null; // effective date of the ledger entry it's matched to
}

export interface ReconInput {
  periodEnd: string;
  bankClosingBalance: Cents;
  entries: ReconLedgerEntry[]; // every entry of the account dated ≤ periodEnd
  bankLines: ReconBankLine[]; // every statement line of the account posted ≤ periodEnd
  calendar?: BusinessCalendar;
}

export interface Beneficiary {
  name: string;
  amount: Cents;
}

export interface DealLiability {
  dealId: string;
  dealNumber: string;
  balance: Cents;
  owedTo: Beneficiary[];
  /** SOLE_DEPOSITOR: one person deposited it; PRO_RATA_REVIEW: several, split needs review; PER_CDA: commission held for the CDA's payees; UNIDENTIFIED: no depositor named */
  basis: "SOLE_DEPOSITOR" | "PRO_RATA_REVIEW" | "PER_CDA" | "UNIDENTIFIED";
}

export interface OutstandingItem {
  entryId: string;
  dealNumber: string;
  entryType: string;
  amount: Cents;
  effectiveDate: string;
  referenceNo: string | null;
  counterparty: string | null;
  businessDaysOutstanding: number;
}

export interface ReconResult {
  bankClosingBalance: Cents;
  outstandingDeposits: Cents;
  outstandingDisbursements: Cents;
  unrecordedBankItems: Cents;
  adjustedBankBalance: Cents;
  ledgerBalance: Cents;
  clientLiabilities: Cents;
  difference: Cents;
  isBalanced: boolean;
  details: {
    deals: DealLiability[];
    outstanding: OutstandingItem[];
    unrecorded: { bankTransactionId: string; postedDate: string; amount: Cents; description: string }[];
    staleDeposits: OutstandingItem[]; // received, still not at the bank 5 business days later
    lateDeposits: { entryId: string; dealNumber: string; amount: Cents; receivedDate: string; postedDate: string; businessDays: number }[];
    shortfalls: { dealId: string; dealNumber: string; balance: Cents }[];
    exceptions: string[];
  };
}

const money = (c: Cents) => `$${(c / 100).toFixed(2)}`;

const COMMISSION_TYPES = new Set(["COMMISSION_RECEIVED", "RECEIPT_RETURNED", "PAYMENT", "PAYMENT_RETURNED"]);

function beneficiaries(balance: Cents, entries: ReconLedgerEntry[]): Pick<DealLiability, "owedTo" | "basis"> {
  if (entries.some((e) => COMMISSION_TYPES.has(e.entryType))) {
    return { owedTo: [{ name: "Payees under the CDA", amount: balance }], basis: "PER_CDA" };
  }
  const contributed = new Map<string, Cents>();
  const key = (n: string | null) => (n ?? "").trim();
  for (const e of entries) {
    const name = key(e.counterparty);
    if (!name) continue;
    if (e.entryType === "DEPOSIT_RECEIVED") contributed.set(name, (contributed.get(name) ?? 0) + e.signedAmount);
  }
  for (const e of entries) {
    const name = key(e.counterparty);
    if (e.entryType === "REFUND_TO_PAYER" && contributed.has(name)) contributed.set(name, contributed.get(name)! + e.signedAmount);
  }
  const people = [...contributed].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  if (people.length === 0) return { owedTo: [{ name: "Unidentified depositor", amount: balance }], basis: "UNIDENTIFIED" };
  if (people.length === 1) return { owedTo: [{ name: people[0]![0], amount: balance }], basis: "SOLE_DEPOSITOR" };
  const total = people.reduce((s, [, c]) => s + c, 0);
  let left = balance;
  const owedTo = people.map(([name, c], i) => {
    const amount = i === people.length - 1 ? left : Math.floor((balance * c) / total);
    left -= amount;
    return { name, amount };
  });
  return { owedTo, basis: "PRO_RATA_REVIEW" };
}

export function reconcile(input: ReconInput): ReconResult {
  const D = input.periodEnd;
  const entries = input.entries.filter((e) => e.effectiveDate <= D);

  const outstanding: OutstandingItem[] = entries
    .filter((e) => !e.match || (e.match.basis === "BANK_STATEMENT" && e.match.postedDate! > D))
    .map((e) => ({
      entryId: e.id, dealNumber: e.dealNumber, entryType: e.entryType, amount: e.signedAmount,
      effectiveDate: e.effectiveDate, referenceNo: e.referenceNo, counterparty: e.counterparty,
      businessDaysOutstanding: businessDaysBetween(e.receivedDate ?? e.effectiveDate, D, input.calendar ?? STATUTORY_CALENDAR),
    }));
  const outstandingDeposits = outstanding.filter((o) => o.amount > 0).reduce((s, o) => s + o.amount, 0);
  const outstandingDisbursements = -outstanding.filter((o) => o.amount < 0).reduce((s, o) => s + o.amount, 0);

  const unrecorded = input.bankLines
    .filter((l) => l.postedDate <= D && (l.matchedEntryDate === null || l.matchedEntryDate > D))
    .map((l) => ({ bankTransactionId: l.id, postedDate: l.postedDate, amount: l.amount, description: l.description }));
  const unrecordedBankItems = unrecorded.reduce((s, u) => s + u.amount, 0);

  const adjustedBankBalance = input.bankClosingBalance + outstandingDeposits - outstandingDisbursements;
  const ledgerBalance = entries.reduce((s, e) => s + e.signedAmount, 0);

  const byDeal = new Map<string, { dealId: string; dealNumber: string; balance: Cents; entries: ReconLedgerEntry[] }>();
  for (const e of entries) {
    const d = byDeal.get(e.dealId) ?? { dealId: e.dealId, dealNumber: e.dealNumber, balance: 0, entries: [] };
    d.balance += e.signedAmount;
    d.entries.push(e);
    byDeal.set(e.dealId, d);
  }
  const deals: DealLiability[] = [...byDeal.values()].filter((d) => d.balance !== 0)
    .sort((a, b) => a.dealNumber.localeCompare(b.dealNumber))
    .map((d) => ({
      dealId: d.dealId, dealNumber: d.dealNumber, balance: d.balance,
      ...(d.balance > 0 ? beneficiaries(d.balance, d.entries) : { owedTo: [], basis: "UNIDENTIFIED" as const }),
    }));
  const shortfalls = deals.filter((d) => d.balance < 0).map(({ dealId, dealNumber, balance }) => ({ dealId, dealNumber, balance }));
  const clientLiabilities = deals.filter((d) => d.balance > 0).reduce((s, d) => s + d.balance, 0);

  const difference = adjustedBankBalance - ledgerBalance;
  const staleDeposits = outstanding.filter((o) => o.amount > 0 && o.businessDaysOutstanding > STALE_DEPOSIT_BUSINESS_DAYS);
  // Deposits the bank posted this month more than 5 business days after receipt (O. Reg. 567/05 s.17)
  const lateDeposits = entries
    .filter((e) => e.entryType === "DEPOSIT_RECEIVED" && e.receivedDate && e.match?.basis === "BANK_STATEMENT"
      && e.match.postedDate! <= D && e.match.postedDate!.slice(0, 7) === D.slice(0, 7))
    .map((e) => ({
      entryId: e.id, dealNumber: e.dealNumber, amount: e.signedAmount, receivedDate: e.receivedDate!, postedDate: e.match!.postedDate!,
      businessDays: businessDaysBetween(e.receivedDate!, e.match!.postedDate!, input.calendar ?? STATUTORY_CALENDAR),
    }))
    .filter((l) => l.businessDays > STALE_DEPOSIT_BUSINESS_DAYS);

  const exceptions: string[] = [];
  if (difference !== 0) {
    const explained = difference === unrecordedBankItems ? " (explained by the unrecorded bank items below)" : "";
    exceptions.push(difference < 0
      ? `Shortfall: the bank holds ${money(-difference)} less than the trust ledger after outstanding items${explained}`
      : `Overage: the bank holds ${money(difference)} more than the trust ledger after outstanding items${explained}`);
  }
  for (const s of shortfalls) exceptions.push(`Deal ${s.dealNumber} is overdrawn by ${money(-s.balance)}`);
  for (const s of staleDeposits) {
    exceptions.push(`Deposit of ${money(s.amount)} on deal ${s.dealNumber} isn't at the bank ${s.businessDaysOutstanding} business days after it was received (limit 5)`);
  }
  for (const l of lateDeposits) {
    exceptions.push(`Deposit of ${money(l.amount)} on deal ${l.dealNumber} received ${l.receivedDate} reached the bank ${l.postedDate}: ${l.businessDays} business days (limit 5)`);
  }
  for (const u of unrecorded) {
    exceptions.push(`${money(u.amount)} on ${u.postedDate} at the bank isn't in the trust ledger (${u.description})`);
  }

  return {
    bankClosingBalance: input.bankClosingBalance,
    outstandingDeposits,
    outstandingDisbursements,
    unrecordedBankItems,
    adjustedBankBalance,
    ledgerBalance,
    clientLiabilities,
    difference,
    isBalanced: difference === 0 && ledgerBalance === clientLiabilities,
    details: { deals, outstanding, unrecorded, staleDeposits, lateDeposits, shortfalls, exceptions },
  };
}
