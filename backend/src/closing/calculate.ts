/**
 * Closing calculator: turns a closed deal into the numbers on a Commission
 * Disbursement Authorization (CDA). Pure: no database, no clock. All money is
 * integer cents. The sales tax rate comes in with the deal (the property's
 * province on the close date, from SalesTaxRate); there is no default. The
 * formulas below show 13% (Ontario HST) as the example.
 *
 * ── The algorithm ──────────────────────────────────────────────────────────
 *
 *  1. Incoming funds
 *       B  = base GCI to our brokerage            H  = round(B × 13%)
 *       C  = co-op commission (listing side)      HC = round(C × 13%)
 *       Our invoice      T = B + H
 *       Total payable    O = T + C + HC          (what the commission payer owes us)
 *
 *  2. Agents  (per agent i, through the commission engine)
 *       Bᵢ  = B × gciShareᵢ  (rounding remainder to the first agent)
 *       Aᵢ  = agent base split of Bᵢ (deal split %, capped by the plan's annual cap)
 *       Fᵢ  = Σ plan fees
 *       Payoutᵢ = (Aᵢ + 13% HST) − (Fᵢ + 13% HST)    HST on Aᵢ only if the agent is HST-registered
 *                 + bonuses (+ HST if taxable and the agent is registered)
 *                 − deductions (+ HST if taxable) − recoveries of earlier overpayments (no HST)
 *       P   = Σ Payoutᵢ
 *
 *  3. Brokerage side of the money
 *       R = O − P    (co-op incl. HST + the brokerage's own earned share incl. HST)
 *       Brokerage's net earned share incl. HST = T − P
 *
 *  4. Deposit held in our trust account (listing / dual deals only), D
 *       Applied in this order: co-op (C + HC) → brokerage's own share (T − P) → agents (P)
 *       D ≥ O : Balance due TO lawyer   = D − O, no wires needed
 *       D < O : Balance due FROM lawyer = O − D
 *
 *  5. Payment from the payer (lawyer, or the listing brokerage on buyer-side deals)
 *       One payment, to the brokerage only = O − min(D, O)
 *       The payer never pays agents or PRECs directly. The brokerage pays each
 *       agent Payoutᵢ itself, as a separate approved payout once the funds are in.
 *
 *  6. Safety audits (throw ClosingAuditError)
 *       • every FINTRAC record on the deal is Approved
 *       • every dollar distributed from trust has cleared the bank (matched to a statement line)
 *       • trust ledger balance − Σ proposed trust distributions = $0.00
 */

import {
  applyRate,
  calculateCommission,
  type CommissionBreakdown,
} from "../../../commission-engine/src/commission.ts";
import { DomainError } from "../errors.ts";
import type { Cents } from "../lib/money.ts";

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface Contact {
  name: string;
  email: string | null;
  phone: string | null;
}

export interface ClosingAgentInput {
  userId: string;
  name: string;
  role: "PRIMARY" | "CO_AGENT" | "REFERRAL";
  isPrec: boolean;
  precLegalName: string | null;
  hstNumber: string | null;
  splitBps: number; // 8000 = 80/20
  gciShareBps: number; // 10000 = all of the deal's GCI
  annualCap: Cents | null;
  fees: { name: string; amount: Cents }[];
  ytdHouseCollected: Cents; // house share already collected this cap year
  hasPlan: boolean;
  /** Approved bonuses, deductions and recoveries for this agent on this deal */
  adjustments?: { id: string; kind: "BONUS" | "DEDUCTION" | "RECOVERY"; description: string; amount: Cents; taxable: boolean }[];
  /** The plan version in force on the close date, and its standard split, for the record */
  planVersionId?: string | null;
  planSplitBps?: number | null;
}

export interface ClosingInput {
  deal: {
    id: string;
    dealNumber: string;
    side: "LISTING" | "BUYER" | "DUAL" | "LANDLORD" | "TENANT";
    status: string;
    closeDate: string;
    streetAddress: string;
    unit: string | null;
    city: string;
    province?: string;
    mlsNumber: string | null;
    salePrice: Cents;
    expectedDeposit: Cents;
    trustDepositHolder: "OUR_BROKERAGE" | "COOP_BROKERAGE" | "LAWYER" | "BUILDER";
    sellers: string[];
    buyers: string[];
  };
  baseGci: Cents;
  coopCommission: Cents;
  coopBrokerage: string | null;
  referral: { payee: string; rateBps: number } | null;
  /** GST/HST for the property's province on the close date. Required: no default rate. */
  hstRate?: number;
  taxName?: "HST" | "GST";
  agents: ClosingAgentInput[];
  closingLawyer: Contact | null;
  trust: {
    accountId: string | null;
    balance: Cents;
    cleared: Cents; // part of the balance whose deposits have been matched to the bank statement
    accountsWithFunds: number;
    activeHold: boolean;
    deposits: { receiptNumber: number | null; amount: Cents; date: string; payor: string }[];
  };
  fintrac: { total: number; outstanding: string[] };
}

// ── Outputs ──────────────────────────────────────────────────────────────────

export interface Taxed {
  base: Cents;
  hst: Cents;
  total: Cents;
}

export interface AgentClosingLine {
  userId: string;
  name: string;
  payeeName: string; // PREC legal name when the agent is a PREC
  isPrec: boolean;
  hstNumber: string | null;
  allocatedBaseGci: Cents;
  split: Taxed; // agent base split + HST
  fees: (Taxed & { name: string })[];
  feesTotal: Taxed;
  net: Taxed;
  payout: Cents; // (split + HST) − (fees + HST) ± adjustments
  owes: Cents;
  adjustments: (Taxed & { id: string; kind: "BONUS" | "DEDUCTION" | "RECOVERY"; description: string; signedTotal: Cents })[];
  planVersionId: string | null;
  houseSplitBase: Cents;
  effectiveSplitBps: number;
  capReachedOnThisDeal: boolean;
  capRemainingAfter: Cents | null;
}

export interface TrustDistribution {
  entryType: "DISBURSEMENT_TO_COOP" | "DISBURSEMENT_TO_GENERAL" | "DISBURSEMENT_TO_LAWYER";
  payee: string;
  amount: Cents;
  purpose: string;
}

export interface Wire {
  to: "BROKERAGE";
  payeeName: string;
  /** The full commission payable, before anything applied from trust */
  owed: Taxed;
  lessFromTrust: Cents;
  amount: Cents;
}

export interface ClosingComputation {
  cdaNumber: string;
  hstRate: number;
  taxName: "HST" | "GST";
  deal: ClosingInput["deal"];
  payer: { kind: "SELLER_LAWYER" | "COOPERATING_BROKERAGE"; name: string };
  closingLawyer: Contact | null;
  incoming: {
    commission: Taxed; // T = B + H
    coop: Taxed; // C + HC
    totalPayable: Cents; // O
  };
  agents: AgentClosingLine[];
  brokerage: {
    netEarnedShare: Taxed; // T − P, split into base / HST
    houseSplitBase: Cents;
    feesChargedBase: Cents;
    referral: (Taxed & { payee: string }) | null;
    /** HST charged on GCI and fees, less HST paid to agents and the referral. An estimate for this
     *  deal only: the brokerage's actual net tax also depends on its other input tax credits. */
    netHstEstimate: Cents;
    agentPayablesTotal: Cents; // P, paid by the brokerage after the funds are received
  };
  trust: {
    held: Cents;
    deposits: ClosingInput["trust"]["deposits"];
    appliedToCommission: Cents;
    balanceDueToLawyer: Cents;
    balanceDueFromLawyer: Cents;
    distributions: TrustDistribution[];
    balanceAfter: Cents; // always 0, or the audit throws
  };
  wires: Wire[];
  wiresTotal: Cents;
  warnings: string[];
}

export class ClosingAuditError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, 422, message, details);
  }
}

// ── Calculation ──────────────────────────────────────────────────────────────

const taxed = (base: Cents, rate: number): Taxed => {
  const hst = applyRate(base, rate);
  return { base, hst, total: base + hst };
};

const BROKERAGE_SIDES = new Set(["LISTING", "DUAL"]);

/** Splits the deal's base GCI across agents by share; any rounding cent goes to the first agent. */
function allocate(total: Cents, agents: ClosingAgentInput[]): Cents[] {
  // Round each share down, so the leftover is never negative and always lands on the primary agent
  const parts = agents.map((a) => Math.floor((total * a.gciShareBps) / 10_000));
  parts[0]! += total - parts.reduce((s, p) => s + p, 0);
  return parts;
}

export function computeClosing(input: ClosingInput, brokerageName: string): ClosingComputation {
  const { deal } = input;
  if (input.hstRate === undefined) {
    throw new ClosingAuditError("TAX_RATE_UNKNOWN", `No GST/HST rate on file for the property's province on ${deal.closeDate}`);
  }
  const rate = input.hstRate;
  const taxName = input.taxName ?? "HST";
  const warnings: string[] = [];

  // ── Safety audit 1: FINTRAC ─────────────────────────────────────────────
  if (input.fintrac.total === 0) {
    throw new ClosingAuditError("FINTRAC_NOT_APPROVED", `Deal ${deal.dealNumber} has no FINTRAC records on file`);
  }
  if (input.fintrac.outstanding.length > 0) {
    throw new ClosingAuditError(
      "FINTRAC_NOT_APPROVED",
      `Deal ${deal.dealNumber} is not FINTRAC approved. Outstanding: ${input.fintrac.outstanding.join("; ")}`,
      { outstanding: input.fintrac.outstanding },
    );
  }

  // ── Structural checks ───────────────────────────────────────────────────
  if (deal.side === "LANDLORD" || deal.side === "TENANT") {
    throw new ClosingAuditError("UNSUPPORTED_DEAL_SIDE", "CDAs are for purchase and sale deals");
  }
  if (input.agents.length === 0) throw new ClosingAuditError("NO_AGENTS", "The deal has no agents");
  const shareTotal = input.agents.reduce((s, a) => s + a.gciShareBps, 0);
  if (shareTotal !== 10_000) {
    throw new ClosingAuditError("GCI_SHARES_INVALID", `Agents' GCI shares add up to ${shareTotal / 100}%, not 100%`);
  }
  if (input.trust.activeHold) {
    throw new ClosingAuditError("TRUST_HOLD_ACTIVE", "The deal's trust funds are on hold (disputed / unclaimed)");
  }
  if (input.trust.accountsWithFunds > 1) {
    throw new ClosingAuditError("TRUST_SPLIT_ACROSS_ACCOUNTS", "The deposit sits in more than one trust account");
  }

  const payer = BROKERAGE_SIDES.has(deal.side)
    ? { kind: "SELLER_LAWYER" as const, name: input.closingLawyer?.name ?? "" }
    : { kind: "COOPERATING_BROKERAGE" as const, name: input.coopBrokerage ?? "" };
  if (!payer.name) {
    throw new ClosingAuditError(
      payer.kind === "SELLER_LAWYER" ? "CLOSING_LAWYER_MISSING" : "COOP_BROKERAGE_MISSING",
      payer.kind === "SELLER_LAWYER"
        ? "Add the seller's lawyer to the deal before generating the CDA"
        : "Add the listing (co-operating) brokerage to the deal before generating the CDA",
    );
  }
  if (input.closingLawyer && !input.closingLawyer.email && !input.closingLawyer.phone) {
    warnings.push("CLOSING_LAWYER_HAS_NO_CONTACT_DETAILS");
  }

  // ── 1. Incoming funds ────────────────────────────────────────────────────
  const commission = taxed(input.baseGci, rate);
  const coop = taxed(input.coopCommission, rate);
  const totalPayable = commission.total + coop.total;

  // ── 2. Agents, through the commission engine ─────────────────────────────
  const allocations = allocate(input.baseGci, input.agents);
  const runs = input.agents.map((agent, i) => {
    if (!agent.hasPlan) warnings.push(`NO_COMMISSION_PLAN:${agent.name}`);
    const r = calculateCommission({
      baseGci: allocations[i]!,
      hstRate: rate,
      agent: { name: agent.name, isPrec: agent.isPrec, precLegalName: agent.precLegalName, hstNumber: agent.hstNumber },
      split: { agentRate: agent.splitBps, annualCap: agent.annualCap },
      ytd: { houseCollected: agent.ytdHouseCollected, franchisePaid: 0 },
      fees: agent.fees.map((f) => ({ name: f.name, amount: f.amount, paidBy: "AGENT" as const })),
      referral: input.referral ? { payee: input.referral.payee, rate: input.referral.rateBps } : null,
    });
    if (!agent.hstNumber) warnings.push(`AGENT_NOT_HST_REGISTERED:${agent.name}`);
    if (agent.planSplitBps != null && agent.planSplitBps !== agent.splitBps) {
      warnings.push(`SPLIT_DIFFERS_FROM_PLAN:${agent.name}:${agent.splitBps / 100}% on the deal, ${agent.planSplitBps / 100}% in the plan`);
    }
    // Bonuses and deductions on top of the engine's split and fees
    const adjustments = (agent.adjustments ?? []).map((a) => {
      const hst = a.kind === "RECOVERY" || !a.taxable ? 0
        : a.kind === "BONUS" ? (agent.hstNumber ? applyRate(a.amount, rate) : 0)
        : applyRate(a.amount, rate);
      const total = a.amount + hst;
      return { id: a.id, kind: a.kind, description: a.description, base: a.amount, hst, total, signedTotal: a.kind === "BONUS" ? total : -total };
    });
    const net = r.agent.payout - r.agent.owes + adjustments.reduce((s, a) => s + a.signedTotal, 0);
    const adjHst = adjustments.reduce((s, a) => s + (a.kind === "BONUS" ? a.hst : -a.hst), 0);
    const adjBase = adjustments.reduce((s, a) => s + (a.kind === "BONUS" ? a.base : -a.base), 0);
    const payout = Math.max(0, net);
    const owes = Math.max(0, -net);
    if (owes > 0) warnings.push(`AGENT_OWES_FEES:${agent.name}`);
    return {
      agent, base: allocations[i]!, r, adjustments, payout, owes,
      net: { base: r.agent.net.base + adjBase, hst: r.agent.net.hst + adjHst, total: r.agent.net.total + adjBase + adjHst },
    };
  });
  const agentPayouts = runs.reduce((s, x) => s + x.payout, 0); // P

  // ── 3. Brokerage side ────────────────────────────────────────────────────
  const agentNetHst = runs.reduce((s, x) => s + x.net.hst, 0);
  const earnedTotal = commission.total - agentPayouts; // T − P
  const earnedHst = commission.hst - agentNetHst;
  const netEarnedShare: Taxed = { base: earnedTotal - earnedHst, hst: earnedHst, total: earnedTotal };
  const referralRuns = runs.filter((x) => x.r.referral);
  const referral = input.referral && referralRuns.length > 0
    ? {
        payee: input.referral.payee,
        base: referralRuns.reduce((s, x) => s + x.r.referral!.base, 0),
        hst: referralRuns.reduce((s, x) => s + x.r.referral!.hst, 0),
        total: referralRuns.reduce((s, x) => s + x.r.referral!.total, 0),
      }
    : null;
  const netHstEstimate =
    commission.hst
    + runs.reduce((s, x) => s + x.r.agent.feesTotal.hst, 0)
    - runs.reduce((s, x) => s + x.r.agent.split.hst, 0)
    - runs.reduce((s, x) => s + x.adjustments.reduce((t, a) => t + (a.kind === "BONUS" ? a.hst : -a.hst), 0), 0) // HST paid on bonuses, less HST charged on deductions
    - (referral?.hst ?? 0);

  // ── 4. Deposit held in trust ─────────────────────────────────────────────
  const held = input.trust.balance;
  const appliesDeposit = BROKERAGE_SIDES.has(deal.side) && deal.trustDepositHolder === "OUR_BROKERAGE";

  if (deal.trustDepositHolder === "OUR_BROKERAGE" && held === 0) {
    throw new ClosingAuditError(
      "DEPOSIT_NOT_IN_TRUST",
      `Deal ${deal.dealNumber} says our brokerage holds the deposit, but its trust ledger is at $0.00`,
    );
  }
  if (appliesDeposit && held !== deal.expectedDeposit) warnings.push("TRUST_BALANCE_DIFFERS_FROM_DEPOSIT_AMOUNT");
  if (held > 0 && input.trust.cleared < held) {
    throw new ClosingAuditError(
      "FUNDS_NOT_CLEARED",
      `Deal ${deal.dealNumber} holds $${(held / 100).toFixed(2)} in trust, but only $${(input.trust.cleared / 100).toFixed(2)} ` +
        "has been matched to the bank statement. Import the latest trust statement and match the deposit before closing.",
      { held, cleared: input.trust.cleared },
    );
  }

  const distributions: TrustDistribution[] = [];
  let fromTrustToCoop = 0;
  let fromTrustToBrokerage = 0;
  let fromTrustForAgents = 0;
  let toLawyer = 0;
  if (appliesDeposit) {
    let remaining = held;
    fromTrustToCoop = Math.min(remaining, coop.total);
    remaining -= fromTrustToCoop;
    fromTrustToBrokerage = Math.min(remaining, earnedTotal);
    remaining -= fromTrustToBrokerage;
    fromTrustForAgents = Math.min(remaining, agentPayouts);
    remaining -= fromTrustForAgents;
    toLawyer = remaining;

    if (fromTrustToCoop > 0) {
      distributions.push({
        entryType: "DISBURSEMENT_TO_COOP",
        payee: input.coopBrokerage ?? "Co-operating brokerage",
        amount: fromTrustToCoop,
        purpose: "Co-operating brokerage commission incl. HST",
      });
    }
    if (fromTrustToBrokerage + fromTrustForAgents > 0) {
      distributions.push({
        entryType: "DISBURSEMENT_TO_GENERAL",
        payee: `${brokerageName} (general account)`,
        amount: fromTrustToBrokerage + fromTrustForAgents,
        purpose: fromTrustForAgents > 0
          ? "Commission earned incl. HST (includes agent commission the brokerage pays out)"
          : "Commission earned incl. HST",
      });
    }
    if (toLawyer > 0) {
      distributions.push({
        entryType: "DISBURSEMENT_TO_LAWYER",
        payee: input.closingLawyer!.name,
        amount: toLawyer,
        purpose: "Balance of deposit, in trust",
      });
    }
  }

  // ── Safety audit 2: the deal's trust ledger must end at exactly $0.00 ────
  const distributed = distributions.reduce((s, d) => s + d.amount, 0);
  const balanceAfter = held - distributed;
  if (balanceAfter !== 0) {
    throw new ClosingAuditError(
      "TRUST_WILL_NOT_BALANCE",
      `After the closing distributions the trust ledger for deal ${deal.dealNumber} would hold $${(balanceAfter / 100).toFixed(2)}, not $0.00. ` +
        (appliesDeposit ? "" : "This deal doesn't apply a deposit to commission; release or refund the trust funds first."),
      { held, distributed, balanceAfter },
    );
  }

  // ── 5. One payment from the payer, to the brokerage ─────────────────────
  const agents: AgentClosingLine[] = runs.map(({ agent, base, r, adjustments, payout, owes, net }) => {
    return {
      userId: agent.userId,
      name: agent.name,
      payeeName: r.agent.payeeName,
      isPrec: agent.isPrec,
      hstNumber: agent.hstNumber,
      allocatedBaseGci: base,
      split: r.agent.split,
      fees: r.agent.fees,
      feesTotal: r.agent.feesTotal,
      net,
      payout,
      owes,
      adjustments,
      planVersionId: agent.planVersionId ?? null,
      houseSplitBase: r.brokerage.split,
      effectiveSplitBps: r.agent.effectiveSplitRate,
      capReachedOnThisDeal: r.cap.reachedOnThisDeal,
      capRemainingAfter: r.cap.remainingAfter,
    };
  });

  const applied = held - toLawyer;
  const wires: Wire[] = [];
  if (totalPayable > applied) {
    wires.push({
      to: "BROKERAGE",
      payeeName: brokerageName,
      owed: { base: commission.base + coop.base, hst: commission.hst + coop.hst, total: totalPayable },
      lessFromTrust: applied,
      amount: totalPayable - applied,
    });
  }
  const wiresTotal = wires.reduce((s, w) => s + w.amount, 0);

  // Every cent of the payable is either applied from trust or wired
  if (applied + wiresTotal !== totalPayable) {
    throw new ClosingAuditError("CLOSING_DOES_NOT_RECONCILE", "Internal check failed: trust + wires ≠ commission payable", {
      applied, wiresTotal, totalPayable,
    });
  }

  return {
    cdaNumber: `CDA-${deal.dealNumber}`,
    hstRate: rate,
    taxName,
    deal,
    payer,
    closingLawyer: input.closingLawyer,
    incoming: { commission, coop, totalPayable },
    agents,
    brokerage: {
      netEarnedShare,
      houseSplitBase: runs.reduce((s, x) => s + x.r.brokerage.split, 0),
      feesChargedBase: runs.reduce((s, x) => s + x.r.brokerage.feesCharged.base, 0),
      referral,
      netHstEstimate,
      agentPayablesTotal: agentPayouts,
    },
    trust: {
      held,
      deposits: input.trust.deposits,
      appliedToCommission: applied,
      balanceDueToLawyer: toLawyer,
      balanceDueFromLawyer: payer.kind === "SELLER_LAWYER" ? totalPayable - applied : 0,
      distributions,
      balanceAfter,
    },
    wires,
    wiresTotal,
    warnings,
  };
}
