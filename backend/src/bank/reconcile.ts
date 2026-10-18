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
 */

import { businessDaysBetween } from "../lib/dates.ts";
import type { Cents } from "../lib/money.ts";

export const STALE_DEPOSIT_BUSINESS_DAYS = 5;

export interface ReconLedgerEntry {
  id: string;
  dealId: string;
  dealNumber: string;
  entryType: string;
  signedAmount: Cents; // amount × direction
  effectiveDate: string;
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
    deals: { dealId: string; dealNumber: string; balance: Cents }[];
    outstanding: OutstandingItem[];
    unrecorded: { bankTransactionId: string; postedDate: string; amount: Cents; description: string }[];
    staleDeposits: OutstandingItem[]; // recorded as received, still not at the bank after 5 business days
    shortfalls: { dealId: string; dealNumber: string; balance: Cents }[];
    exceptions: string[];
  };
}

const money = (c: Cents) => `$${(c / 100).toFixed(2)}`;

export function reconcile(input: ReconInput): ReconResult {
  const D = input.periodEnd;
  const entries = input.entries.filter((e) => e.effectiveDate <= D);

  const outstanding: OutstandingItem[] = entries
    .filter((e) => !e.match || (e.match.basis === "BANK_STATEMENT" && e.match.postedDate! > D))
    .map((e) => ({
      entryId: e.id, dealNumber: e.dealNumber, entryType: e.entryType, amount: e.signedAmount,
      effectiveDate: e.effectiveDate, referenceNo: e.referenceNo, counterparty: e.counterparty,
      businessDaysOutstanding: businessDaysBetween(e.effectiveDate, D),
    }));
  const outstandingDeposits = outstanding.filter((o) => o.amount > 0).reduce((s, o) => s + o.amount, 0);
  const outstandingDisbursements = -outstanding.filter((o) => o.amount < 0).reduce((s, o) => s + o.amount, 0);

  const unrecorded = input.bankLines
    .filter((l) => l.postedDate <= D && (l.matchedEntryDate === null || l.matchedEntryDate > D))
    .map((l) => ({ bankTransactionId: l.id, postedDate: l.postedDate, amount: l.amount, description: l.description }));
  const unrecordedBankItems = unrecorded.reduce((s, u) => s + u.amount, 0);

  const adjustedBankBalance = input.bankClosingBalance + outstandingDeposits - outstandingDisbursements;
  const ledgerBalance = entries.reduce((s, e) => s + e.signedAmount, 0);

  const byDeal = new Map<string, { dealId: string; dealNumber: string; balance: Cents }>();
  for (const e of entries) {
    const d = byDeal.get(e.dealId) ?? { dealId: e.dealId, dealNumber: e.dealNumber, balance: 0 };
    d.balance += e.signedAmount;
    byDeal.set(e.dealId, d);
  }
  const deals = [...byDeal.values()].filter((d) => d.balance !== 0).sort((a, b) => a.dealNumber.localeCompare(b.dealNumber));
  const shortfalls = deals.filter((d) => d.balance < 0);
  const clientLiabilities = deals.filter((d) => d.balance > 0).reduce((s, d) => s + d.balance, 0);

  const difference = adjustedBankBalance - ledgerBalance;
  const staleDeposits = outstanding.filter((o) => o.amount > 0 && o.businessDaysOutstanding > STALE_DEPOSIT_BUSINESS_DAYS);

  const exceptions: string[] = [];
  if (difference !== 0) {
    const explained = difference === unrecordedBankItems ? " (explained by the unrecorded bank items below)" : "";
    exceptions.push(difference < 0
      ? `Shortfall: the bank holds ${money(-difference)} less than the trust ledger after outstanding items${explained}`
      : `Overage: the bank holds ${money(difference)} more than the trust ledger after outstanding items${explained}`);
  }
  for (const s of shortfalls) exceptions.push(`Deal ${s.dealNumber} is overdrawn by ${money(-s.balance)}`);
  for (const s of staleDeposits) {
    exceptions.push(`Deposit of ${money(s.amount)} on deal ${s.dealNumber} recorded ${s.effectiveDate} isn't at the bank after ${s.businessDaysOutstanding} business days`);
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
    details: { deals, outstanding, unrecorded, staleDeposits, shortfalls, exceptions },
  };
}
