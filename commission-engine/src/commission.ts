/**
 * Zareh Homes – Brokerage Commission Engine
 *
 * Pure, stateless functions. No dependencies, no I/O, no clock.
 * The caller passes in the agent's year-to-date totals and persists the
 * `ytdAfter` values that come back.
 *
 * Money is integer cents everywhere. Percentages are basis points
 * (1% = 100 bps, 80% = 8000 bps) so nothing touches floating point.
 *
 * Order of operations:
 *   1. Outside referral   – % of GCI, paid off the top to the other brokerage
 *   2. Franchise fee      – % of (GCI − referral), limited by an annual cap
 *   3. Agent / house split on what's left, house share limited by the annual cap
 *   4. Flat fees          – charged against the agent's or the house's side
 *
 * Invariant: referral + franchise + houseGross + agentGross === GCI, to the cent.
 */

export type Cents = number;
export type BasisPoints = number;
export type FeePayer = "AGENT" | "HOUSE";

export interface FlatFee {
  name: string;            // "E&O insurance", "Tech fee"
  amount: Cents;
  paidBy: FeePayer;
}

export interface ReferralRule {
  payee: string;           // outside brokerage name
  rate: BasisPoints;       // 2500 = 25% of GCI
}

export interface FranchiseRule {
  rate: BasisPoints;       // 600 = 6%
  annualCap: Cents | null; // null = uncapped
}

export interface SplitPlan {
  agentRate: BasisPoints;  // 8000 = 80% to agent, 20% to house
  annualCap: Cents | null; // most the house collects from this agent per cap year; null = no cap
}

export interface AgentYtd {
  houseCollected: Cents;   // house share already collected this cap year
  franchisePaid: Cents;    // franchise fees already paid this cap year
}

export interface CommissionInput {
  gci: Cents;
  split: SplitPlan;
  ytd: AgentYtd;
  fees?: FlatFee[];
  referral?: ReferralRule | null;
  franchise?: FranchiseRule | null;
}

export interface FeeLine extends FlatFee {}

export interface CommissionBreakdown {
  gci: Cents;
  referral: { payee: string; amount: Cents } | null;
  franchiseFee: Cents;
  splittable: Cents;                 // GCI after referral + franchise
  houseGross: Cents;                 // house share of the split (counts toward the cap)
  agentGross: Cents;                 // agent share of the split
  agentFees: FeeLine[];
  houseFees: FeeLine[];
  agentNet: Cents;                   // what we actually pay the agent (never below 0)
  agentOwes: Cents;                  // agent fees larger than agent's share, to collect separately
  houseNet: Cents;                   // house share after house-paid fees (can be negative)
  effectiveAgentRate: BasisPoints;   // agentGross / splittable, for the trade record sheet
  capReachedOnThisDeal: boolean;
  capRemainingAfter: Cents | null;
  ytdAfter: AgentYtd;
}

export class CommissionError extends Error {}

const BPS_DENOMINATOR = 10_000;

/** amount × rate, rounded half-up to the cent. Inputs are non-negative integers. */
export function applyRate(amount: Cents, rate: BasisPoints): Cents {
  return Math.floor((amount * rate + BPS_DENOMINATOR / 2) / BPS_DENOMINATOR);
}

export function dollarsToCents(dollars: number): Cents {
  return Math.round(dollars * 100);
}

export function centsToDollars(cents: Cents): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-CA")}.${String(abs % 100).padStart(2, "0")}`;
}

function assertCents(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CommissionError(`${label} must be a non-negative whole number of cents, got ${value}`);
  }
}

function assertRate(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > BPS_DENOMINATOR) {
    throw new CommissionError(`${label} must be 0–10000 basis points, got ${value}`);
  }
}

function validate(input: CommissionInput): void {
  assertCents("gci", input.gci);
  assertRate("split.agentRate", input.split.agentRate);
  if (input.split.annualCap !== null) assertCents("split.annualCap", input.split.annualCap);
  assertCents("ytd.houseCollected", input.ytd.houseCollected);
  assertCents("ytd.franchisePaid", input.ytd.franchisePaid);
  for (const fee of input.fees ?? []) {
    assertCents(`fee "${fee.name}"`, fee.amount);
    if (fee.paidBy !== "AGENT" && fee.paidBy !== "HOUSE") {
      throw new CommissionError(`fee "${fee.name}" paidBy must be AGENT or HOUSE`);
    }
  }
  if (input.referral) assertRate("referral.rate", input.referral.rate);
  if (input.franchise) {
    assertRate("franchise.rate", input.franchise.rate);
    if (input.franchise.annualCap !== null) assertCents("franchise.annualCap", input.franchise.annualCap);
  }
}

/** Remaining room under a cap; null cap means unlimited. */
function capRoom(cap: Cents | null, used: Cents): Cents {
  return cap === null ? Number.MAX_SAFE_INTEGER : Math.max(0, cap - used);
}

export function calculateCommission(input: CommissionInput): CommissionBreakdown {
  validate(input);
  const { gci, split, ytd } = input;
  const fees = input.fees ?? [];

  // 1. Outside referral, off the top
  const referralAmount = input.referral ? applyRate(gci, input.referral.rate) : 0;
  const afterReferral = gci - referralAmount;

  // 2. Franchise fee on what's left, limited by the annual franchise cap
  let franchiseFee = 0;
  if (input.franchise) {
    const uncapped = applyRate(afterReferral, input.franchise.rate);
    franchiseFee = Math.min(uncapped, capRoom(input.franchise.annualCap, ytd.franchisePaid));
  }
  const splittable = afterReferral - franchiseFee;

  // 3. Agent / house split. The house takes its normal share until the cap is
  //    hit; anything past the cap goes to the agent (100% split from there on).
  const houseRate = BPS_DENOMINATOR - split.agentRate;
  const houseUncapped = applyRate(splittable, houseRate);
  const houseRoom = capRoom(split.annualCap, ytd.houseCollected);
  const houseGross = Math.min(houseUncapped, houseRoom);
  const agentGross = splittable - houseGross;   // remainder, so totals always reconcile

  // 4. Flat fees
  const agentFees = fees.filter((f) => f.paidBy === "AGENT");
  const houseFees = fees.filter((f) => f.paidBy === "HOUSE");
  const agentFeeTotal = agentFees.reduce((sum, f) => sum + f.amount, 0);
  const houseFeeTotal = houseFees.reduce((sum, f) => sum + f.amount, 0);

  const agentAfterFees = agentGross - agentFeeTotal;
  const agentNet = Math.max(0, agentAfterFees);
  const agentOwes = Math.max(0, -agentAfterFees);
  const houseNet = houseGross - houseFeeTotal;

  const houseCollectedAfter = ytd.houseCollected + houseGross;
  const capReachedOnThisDeal =
    split.annualCap !== null &&
    ytd.houseCollected < split.annualCap &&
    houseCollectedAfter >= split.annualCap;

  return {
    gci,
    referral: input.referral ? { payee: input.referral.payee, amount: referralAmount } : null,
    franchiseFee,
    splittable,
    houseGross,
    agentGross,
    agentFees: agentFees.map((f) => ({ ...f })),
    houseFees: houseFees.map((f) => ({ ...f })),
    agentNet,
    agentOwes,
    houseNet,
    effectiveAgentRate: splittable === 0 ? split.agentRate : Math.round((agentGross * BPS_DENOMINATOR) / splittable),
    capReachedOnThisDeal,
    capRemainingAfter: split.annualCap === null ? null : Math.max(0, split.annualCap - houseCollectedAfter),
    ytdAfter: {
      houseCollected: houseCollectedAfter,
      franchisePaid: ytd.franchisePaid + franchiseFee,
    },
  };
}
