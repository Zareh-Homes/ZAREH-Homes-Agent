/**
 * Zareh Homes – Brokerage Commission Engine (Ontario / CRA)
 *
 * Pure, stateless functions. No dependencies, no I/O, no clock.
 * The caller passes in the agent's year-to-date totals and persists the
 * `ytdAfter` values that come back.
 *
 * Money is integer cents everywhere. Percentages are basis points
 * (1% = 100 bps, 13% = 1300 bps) so nothing touches floating point.
 *
 * `baseGci` is the commission BEFORE tax. HST is added on top:
 *   total received = baseGci + HST (13% in Ontario)
 *
 * Order of operations (all on base, pre-tax amounts):
 *   1. Outside referral   – % of base GCI, paid off the top (+ HST if the payee charges it)
 *   2. Franchise fee      – % of (base GCI − referral), limited by an annual cap (+ HST)
 *   3. Agent / house split on what's left; house share limited by the annual cap
 *   4. Internal fees      – charged to the agent with HST, or absorbed by the house
 *
 * Agent payout = (agent base split + HST) − (agent fees + HST on fees)
 * HST on the agent's split is only added when the agent (or their PREC) is
 * HST-registered; HST on brokerage fees is always charged.
 *
 * Invariants checked by the tests:
 *   referral + franchise + houseSplit + agentSplit === baseGci            (base)
 *   referral + franchise + agent payout − owed + brokerage retained
 *     + HST remittance === total received                                 (cash)
 */

export type Cents = number;
export type BasisPoints = number;
export type FeePayer = "AGENT" | "HOUSE";

export const ONTARIO_HST: BasisPoints = 1300;

export interface FlatFee {
  name: string;            // "Deal fee", "E&O insurance", "Desk fee"
  amount: Cents;           // base, before HST
  paidBy: FeePayer;        // AGENT = charged to agent with HST; HOUSE = brokerage absorbs it
}

export interface ReferralRule {
  payee: string;           // outside brokerage name
  rate: BasisPoints;       // 2500 = 25% of base GCI
  chargesHst?: boolean;    // default true; false for e.g. a non-resident (US) brokerage
}

export interface FranchiseRule {
  rate: BasisPoints;       // 600 = 6%
  annualCap: Cents | null; // null = uncapped
}

export interface SplitPlan {
  agentRate: BasisPoints;  // 8000 = 80% to agent, 20% to house
  annualCap: Cents | null; // most the house collects (base) from this agent per cap year
}

export interface AgentYtd {
  houseCollected: Cents;   // house base split already collected this cap year
  franchisePaid: Cents;    // franchise base fees already paid this cap year
}

/** Mirrors the User row: isPrec, precLegalName, hstNumber. */
export interface AgentProfile {
  name: string;
  isPrec: boolean;
  precLegalName?: string | null;
  hstNumber?: string | null; // present = HST-registered
}

export interface CommissionInput {
  baseGci: Cents;
  agent: AgentProfile;
  split: SplitPlan;
  ytd: AgentYtd;
  fees?: FlatFee[];
  referral?: ReferralRule | null;
  franchise?: FranchiseRule | null;
  hstRate?: BasisPoints;   // default 13% Ontario
}

export interface TaxedAmount {
  base: Cents;
  hst: Cents;
  total: Cents;
}

export interface FeeLine extends TaxedAmount {
  name: string;
}

export interface CommissionBreakdown {
  hstRate: BasisPoints;
  gci: TaxedAmount;                         // what comes in from the lawyer / co-op
  referral: (TaxedAmount & { payee: string }) | null;
  franchise: TaxedAmount;
  splittableBase: Cents;                    // base GCI after referral + franchise

  agent: {
    payeeName: string;                      // PREC legal name if applicable
    isPrec: boolean;
    hstNumber: string | null;
    split: TaxedAmount;                     // agent's base share + HST on it
    fees: FeeLine[];                        // brokerage fees charged to the agent
    feesTotal: TaxedAmount;
    net: TaxedAmount;                       // split − fees, base and HST separately
    payout: Cents;                          // what we send (never below 0)
    owes: Cents;                            // fees larger than the split, to collect separately
    effectiveSplitRate: BasisPoints;        // agent base split / splittable base
  };

  brokerage: {
    split: Cents;                           // house base share (counts toward the cap)
    feesCharged: TaxedAmount;               // fees billed to the agent
    feesAbsorbed: FeeLine[];                // HOUSE-paid fees, no HST billed to anyone
    retainedBase: Cents;                    // split + fees charged; stays in general account
    netRevenueBase: Cents;                  // retained − absorbed fees
  };

  hst: {
    collectedOnGci: Cents;
    collectedOnAgentFees: Cents;
    paidOnReferral: Cents;                  // input tax credit
    paidOnFranchise: Cents;                 // input tax credit
    paidToAgent: Cents;                     // input tax credit
    netRemittance: Cents;                   // what the brokerage owes CRA for this deal
  };

  cap: {
    reachedOnThisDeal: boolean;
    remainingAfter: Cents | null;
  };
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

function taxed(base: Cents, rate: BasisPoints): TaxedAmount {
  const hst = applyRate(base, rate);
  return { base, hst, total: base + hst };
}

function sumTaxed(items: TaxedAmount[]): TaxedAmount {
  return items.reduce(
    (acc, i) => ({ base: acc.base + i.base, hst: acc.hst + i.hst, total: acc.total + i.total }),
    { base: 0, hst: 0, total: 0 },
  );
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

const HST_NUMBER = /^[0-9]{9}RT[0-9]{4}$/;

function validate(input: CommissionInput): void {
  assertCents("baseGci", input.baseGci);
  assertRate("split.agentRate", input.split.agentRate);
  if (input.split.annualCap !== null) assertCents("split.annualCap", input.split.annualCap);
  assertCents("ytd.houseCollected", input.ytd.houseCollected);
  assertCents("ytd.franchisePaid", input.ytd.franchisePaid);
  if (input.hstRate !== undefined) assertRate("hstRate", input.hstRate);
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
  const { agent } = input;
  if (agent.isPrec && !agent.precLegalName?.trim()) {
    throw new CommissionError(`agent "${agent.name}" is a PREC but has no PREC legal name`);
  }
  if (agent.hstNumber && !HST_NUMBER.test(agent.hstNumber)) {
    throw new CommissionError(`agent "${agent.name}" HST number "${agent.hstNumber}" is not in CRA format`);
  }
}

/** Remaining room under a cap; null cap means unlimited. */
function capRoom(cap: Cents | null, used: Cents): Cents {
  return cap === null ? Number.MAX_SAFE_INTEGER : Math.max(0, cap - used);
}

export function calculateCommission(input: CommissionInput): CommissionBreakdown {
  validate(input);
  const { baseGci, split, ytd, agent } = input;
  const hstRate = input.hstRate ?? ONTARIO_HST;
  const fees = input.fees ?? [];

  const gci = taxed(baseGci, hstRate);

  // 1. Outside referral, off the top of base GCI
  let referral: CommissionBreakdown["referral"] = null;
  if (input.referral) {
    const base = applyRate(baseGci, input.referral.rate);
    const rate = input.referral.chargesHst === false ? 0 : hstRate;
    referral = { payee: input.referral.payee, ...taxed(base, rate) };
  }
  const afterReferral = baseGci - (referral?.base ?? 0);

  // 2. Franchise fee on what's left, limited by the annual franchise cap
  let franchiseBase = 0;
  if (input.franchise) {
    const uncapped = applyRate(afterReferral, input.franchise.rate);
    franchiseBase = Math.min(uncapped, capRoom(input.franchise.annualCap, ytd.franchisePaid));
  }
  const franchise = taxed(franchiseBase, hstRate);
  const splittableBase = afterReferral - franchiseBase;

  // 3. Split on base. House takes its share until the cap; past it the agent gets 100%.
  const houseUncapped = applyRate(splittableBase, BPS_DENOMINATOR - split.agentRate);
  const houseSplit = Math.min(houseUncapped, capRoom(split.annualCap, ytd.houseCollected));
  const agentSplitBase = splittableBase - houseSplit; // remainder, so base always reconciles
  const agentHstRegistered = Boolean(agent.hstNumber);
  const agentSplit = taxed(agentSplitBase, agentHstRegistered ? hstRate : 0);

  // 4. Fees: charged to the agent carry HST; house-absorbed fees are just a cost
  const agentFees: FeeLine[] = fees
    .filter((f) => f.paidBy === "AGENT")
    .map((f) => ({ name: f.name, ...taxed(f.amount, hstRate) }));
  const houseFees: FeeLine[] = fees
    .filter((f) => f.paidBy === "HOUSE")
    .map((f) => ({ name: f.name, base: f.amount, hst: 0, total: f.amount }));
  const agentFeesTotal = sumTaxed(agentFees);
  const houseFeesBase = houseFees.reduce((s, f) => s + f.base, 0);

  const agentNet: TaxedAmount = {
    base: agentSplit.base - agentFeesTotal.base,
    hst: agentSplit.hst - agentFeesTotal.hst,
    total: agentSplit.total - agentFeesTotal.total,
  };

  const hstCollectedOnGci = gci.hst;
  const netRemittance =
    hstCollectedOnGci + agentFeesTotal.hst - (referral?.hst ?? 0) - franchise.hst - agentSplit.hst;

  const houseCollectedAfter = ytd.houseCollected + houseSplit;

  return {
    hstRate,
    gci,
    referral,
    franchise,
    splittableBase,

    agent: {
      payeeName: agent.isPrec ? agent.precLegalName!.trim() : agent.name,
      isPrec: agent.isPrec,
      hstNumber: agent.hstNumber ?? null,
      split: agentSplit,
      fees: agentFees,
      feesTotal: agentFeesTotal,
      net: agentNet,
      payout: Math.max(0, agentNet.total),
      owes: Math.max(0, -agentNet.total),
      effectiveSplitRate:
        splittableBase === 0 ? split.agentRate : Math.round((agentSplitBase * BPS_DENOMINATOR) / splittableBase),
    },

    brokerage: {
      split: houseSplit,
      feesCharged: agentFeesTotal,
      feesAbsorbed: houseFees,
      retainedBase: houseSplit + agentFeesTotal.base,
      netRevenueBase: houseSplit + agentFeesTotal.base - houseFeesBase,
    },

    hst: {
      collectedOnGci: hstCollectedOnGci,
      collectedOnAgentFees: agentFeesTotal.hst,
      paidOnReferral: referral?.hst ?? 0,
      paidOnFranchise: franchise.hst,
      paidToAgent: agentSplit.hst,
      netRemittance,
    },

    cap: {
      reachedOnThisDeal:
        split.annualCap !== null &&
        ytd.houseCollected < split.annualCap &&
        houseCollectedAfter >= split.annualCap,
      remainingAfter: split.annualCap === null ? null : Math.max(0, split.annualCap - houseCollectedAfter),
    },
    ytdAfter: {
      houseCollected: houseCollectedAfter,
      franchisePaid: ytd.franchisePaid + franchiseBase,
    },
  };
}
