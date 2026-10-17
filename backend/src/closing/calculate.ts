/**
 * Closing calculator: turns a closed deal into the numbers on a Commission
 * Disbursement Authorization (CDA). Pure: no database, no clock. All money is
 * integer cents; HST is 13% (Ontario) unless told otherwise.
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
 *  5. Wires from the payer (lawyer, or the listing brokerage on buyer-side deals)
 *       To each agent / PREC  = Payoutᵢ − part of Payoutᵢ already covered by D
 *       To the brokerage      = R − part of R already covered by D
 *       Σ wires = O − min(D, O)
 *
 *  6. Safety audits (throw ClosingAuditError)
 *       • every FINTRAC record on the deal is Approved
 *       • trust ledger balance − Σ proposed trust distributions = $0.00
 */

import {
  applyRate,
  calculateCommission,
  ONTARIO_HST,
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
  hstRate?: number;
  agents: ClosingAgentInput[];
  closingLawyer: Contact | null;
  trust: {
    accountId: string | null;
    balance: Cents;
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
  payout: Cents; // (split + HST) − (fees + HST)
  owes: Cents;
  houseSplitBase: Cents;
  effectiveSplitBps: number;
  capReachedOnThisDeal: boolean;
  capRemainingAfter: Cents | null;
  coveredByTrust: Cents; // paid by the brokerage out of the deposit it holds
  wiredByPayer: Cents; // wired directly by the lawyer / listing brokerage
}

export interface TrustDistribution {
  entryType: "DISBURSEMENT_TO_COOP" | "DISBURSEMENT_TO_GENERAL" | "DISBURSEMENT_TO_LAWYER";
  payee: string;
  amount: Cents;
  purpose: string;
}

export interface Wire {
  to: "BROKERAGE" | "AGENT";
  userId: string | null;
  payeeName: string;
  hstNumber: string | null;
  /** The full amount owed to this payee, before anything paid from trust */
  owed: Taxed;
  lessFromTrust: Cents;
  amount: Cents;
}

export interface ClosingComputation {
  cdaNumber: string;
  hstRate: number;
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
    hstRemittance: Cents; // HST on GCI + on fees − HST paid to agents and referral
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
  const rate = input.hstRate ?? ONTARIO_HST;
  const { deal } = input;
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
  const runs: { agent: ClosingAgentInput; base: Cents; r: CommissionBreakdown }[] = input.agents.map((agent, i) => {
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
    if (r.agent.owes > 0) warnings.push(`AGENT_OWES_FEES:${agent.name}`);
    if (!agent.hstNumber) warnings.push(`AGENT_NOT_HST_REGISTERED:${agent.name}`);
    return { agent, base: allocations[i]!, r };
  });
  const agentPayouts = runs.reduce((s, x) => s + x.r.agent.payout, 0); // P

  // ── 3. Brokerage side ────────────────────────────────────────────────────
  const agentNetHst = runs.reduce((s, x) => s + x.r.agent.net.hst, 0);
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
  const hstRemittance =
    commission.hst
    + runs.reduce((s, x) => s + x.r.agent.feesTotal.hst, 0)
    - runs.reduce((s, x) => s + x.r.agent.split.hst, 0)
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

  // ── 5. Wires from the payer ──────────────────────────────────────────────
  const brokerageOwed: Taxed = {
    base: coop.base + netEarnedShare.base,
    hst: coop.hst + netEarnedShare.hst,
    total: coop.total + netEarnedShare.total,
  };
  const brokerageFromTrust = fromTrustToCoop + fromTrustToBrokerage;

  let trustLeftForAgents = fromTrustForAgents;
  const agents: AgentClosingLine[] = runs.map(({ agent, base, r }) => {
    const coveredByTrust = Math.min(trustLeftForAgents, r.agent.payout);
    trustLeftForAgents -= coveredByTrust;
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
      net: r.agent.net,
      payout: r.agent.payout,
      owes: r.agent.owes,
      houseSplitBase: r.brokerage.split,
      effectiveSplitBps: r.agent.effectiveSplitRate,
      capReachedOnThisDeal: r.cap.reachedOnThisDeal,
      capRemainingAfter: r.cap.remainingAfter,
      coveredByTrust,
      wiredByPayer: r.agent.payout - coveredByTrust,
    };
  });

  const wires: Wire[] = [];
  const brokerageWire = brokerageOwed.total - brokerageFromTrust;
  if (brokerageWire > 0) {
    wires.push({
      to: "BROKERAGE",
      userId: null,
      payeeName: brokerageName,
      hstNumber: null,
      owed: brokerageOwed,
      lessFromTrust: brokerageFromTrust,
      amount: brokerageWire,
    });
  }
  for (const a of agents) {
    if (a.wiredByPayer > 0) {
      wires.push({
        to: "AGENT",
        userId: a.userId,
        payeeName: a.payeeName,
        hstNumber: a.hstNumber,
        owed: a.net,
        lessFromTrust: a.coveredByTrust,
        amount: a.wiredByPayer,
      });
    }
  }
  const wiresTotal = wires.reduce((s, w) => s + w.amount, 0);
  const applied = held - toLawyer;

  // Every cent of the payable is either applied from trust or wired
  if (applied + wiresTotal !== totalPayable) {
    throw new ClosingAuditError("CLOSING_DOES_NOT_RECONCILE", "Internal check failed: trust + wires ≠ commission payable", {
      applied, wiresTotal, totalPayable,
    });
  }

  return {
    cdaNumber: `CDA-${deal.dealNumber}`,
    hstRate: rate,
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
      hstRemittance,
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
