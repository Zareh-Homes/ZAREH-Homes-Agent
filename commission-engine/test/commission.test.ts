import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateCommission,
  CommissionError,
  dollarsToCents as $,
  type AgentProfile,
  type CommissionBreakdown,
  type FlatFee,
  type SplitPlan,
} from "../src/commission.ts";

// Standard Zareh Homes plan: 80/20, house capped at $15,000 (base) per cap year
const PLAN_80_20: SplitPlan = { agentRate: 8000, annualCap: $(15_000) };

const STANDARD_FEES: FlatFee[] = [
  { name: "E&O insurance", amount: $(150), paidBy: "AGENT" },
  { name: "Tech fee", amount: $(50), paidBy: "AGENT" },
];

const HST_AGENT: AgentProfile = { name: "Alex Agent", isPrec: false, hstNumber: "987654321RT0001" };

/** Every dollar, base and cash, has to land somewhere, to the cent. */
function assertReconciles(r: CommissionBreakdown): void {
  const referral = r.referral ?? { base: 0, hst: 0, total: 0 };
  assert.equal(
    referral.base + r.franchise.base + r.brokerage.split + r.agent.split.base,
    r.gci.base,
    "base GCI does not reconcile",
  );
  assert.equal(
    referral.total + r.franchise.total + r.agent.payout - r.agent.owes + r.brokerage.retainedBase + r.hst.netRemittance,
    r.gci.total,
    "cash received does not reconcile",
  );
}

test("Toronto resale: $1.1M at 2.5%, PREC agent, full 13% HST breakdown", () => {
  // $1,100,000 sale × 2.5% = $27,500 base GCI
  const r = calculateCommission({
    baseGci: $(27_500),
    agent: {
      name: "Jane Smith",
      isPrec: true,
      precLegalName: "Jane Smith Real Estate Professional Corporation",
      hstNumber: "123456789RT0001",
    },
    split: PLAN_80_20,
    ytd: { houseCollected: 0, franchisePaid: 0 },
    fees: [
      { name: "Deal fee", amount: $(150), paidBy: "AGENT" },
      { name: "Desk fee", amount: $(50), paidBy: "AGENT" },
    ],
  });

  assertReconciles(r);

  // Money in from the lawyer
  assert.deepEqual(r.gci, { base: $(27_500), hst: $(3_575), total: $(31_075) });

  // Split on base, before tax
  assert.equal(r.splittableBase, $(27_500));
  assert.equal(r.brokerage.split, $(5_500));                                         // 20%
  assert.deepEqual(r.agent.split, { base: $(22_000), hst: $(2_860), total: $(24_860) }); // 80% + HST

  // Fees carry HST and come off the agent
  assert.deepEqual(r.agent.fees, [
    { name: "Deal fee", base: $(150), hst: $(19.5), total: $(169.5) },
    { name: "Desk fee", base: $(50), hst: $(6.5), total: $(56.5) },
  ]);
  assert.deepEqual(r.agent.feesTotal, { base: $(200), hst: $(26), total: $(226) });

  // Payout = ($22,000 + $2,860) − ($200 + $26), paid to the PREC
  assert.deepEqual(r.agent.net, { base: $(21_800), hst: $(2_834), total: $(24_634) });
  assert.equal(r.agent.payout, $(24_634));
  assert.equal(r.agent.owes, 0);
  assert.equal(r.agent.payeeName, "Jane Smith Real Estate Professional Corporation");
  assert.equal(r.agent.hstNumber, "123456789RT0001");

  // Brokerage keeps its split + fees; HST owed to CRA is 13% of that
  assert.equal(r.brokerage.retainedBase, $(5_700));
  assert.equal(r.brokerage.netRevenueBase, $(5_700));
  assert.deepEqual(r.hst, {
    collectedOnGci: $(3_575),
    collectedOnAgentFees: $(26),
    paidOnReferral: 0,
    paidOnFranchise: 0,
    paidToAgent: $(2_860),
    netRemittance: $(741),   // 3,575 + 26 − 2,860 = 13% × 5,700
  });

  // Cap is tracked on base only
  assert.equal(r.ytdAfter.houseCollected, $(5_500));
  assert.equal(r.cap.remainingAfter, $(9_500));
});

test("1) standard uncapped 80/20 deal", () => {
  const r = calculateCommission({
    baseGci: $(20_000),
    agent: HST_AGENT,
    split: PLAN_80_20,
    ytd: { houseCollected: $(4_000), franchisePaid: 0 },
    fees: STANDARD_FEES,
  });

  assertReconciles(r);
  assert.deepEqual(r.gci, { base: $(20_000), hst: $(2_600), total: $(22_600) });
  assert.equal(r.referral, null);
  assert.equal(r.franchise.total, 0);
  assert.equal(r.brokerage.split, $(4_000));
  assert.deepEqual(r.agent.split, { base: $(16_000), hst: $(2_080), total: $(18_080) });
  assert.equal(r.agent.payout, $(17_854));         // 18,080 − 226
  assert.equal(r.agent.payeeName, "Alex Agent");
  assert.equal(r.agent.effectiveSplitRate, 8000);
  assert.equal(r.hst.netRemittance, $(546));       // 13% × (4,000 + 200)
  assert.equal(r.cap.reachedOnThisDeal, false);
  assert.equal(r.cap.remainingAfter, $(7_000));
  assert.deepEqual(r.ytdAfter, { houseCollected: $(8_000), franchisePaid: 0 });
});

test("2) agent hits the $15,000 cap mid-transaction, next deal is 100%", () => {
  const r = calculateCommission({
    baseGci: $(20_000),
    agent: HST_AGENT,
    split: PLAN_80_20,
    ytd: { houseCollected: $(13_000), franchisePaid: 0 },
    fees: STANDARD_FEES,
  });

  assertReconciles(r);
  assert.equal(r.brokerage.split, $(2_000));       // capped, not the normal $4,000
  assert.deepEqual(r.agent.split, { base: $(18_000), hst: $(2_340), total: $(20_340) });
  assert.equal(r.agent.payout, $(20_114));
  assert.equal(r.agent.effectiveSplitRate, 9000);
  assert.equal(r.cap.reachedOnThisDeal, true);
  assert.equal(r.cap.remainingAfter, 0);
  assert.equal(r.ytdAfter.houseCollected, $(15_000));

  const next = calculateCommission({
    baseGci: $(12_500),
    agent: HST_AGENT,
    split: PLAN_80_20,
    ytd: r.ytdAfter,
    fees: STANDARD_FEES,
  });

  assertReconciles(next);
  assert.equal(next.brokerage.split, 0);
  assert.deepEqual(next.agent.split, { base: $(12_500), hst: $(1_625), total: $(14_125) });
  assert.equal(next.agent.payout, $(13_899));      // fees + HST still apply after cap
  assert.equal(next.agent.effectiveSplitRate, 10_000);
  assert.equal(next.cap.reachedOnThisDeal, false);
});

test("3) 25% outside referral off the top, then franchise fee, then split", () => {
  const r = calculateCommission({
    baseGci: $(20_000),
    agent: HST_AGENT,
    split: PLAN_80_20,
    ytd: { houseCollected: 0, franchisePaid: 0 },
    referral: { payee: "Out-of-town Realty Brokerage", rate: 2500 },
    franchise: { rate: 600, annualCap: $(3_000) },
    fees: [
      { name: "E&O insurance", amount: $(150), paidBy: "AGENT" },
      { name: "Tech fee", amount: $(50), paidBy: "HOUSE" }, // house absorbs, no HST billed
    ],
  });

  assertReconciles(r);
  assert.deepEqual(r.referral, {
    payee: "Out-of-town Realty Brokerage", base: $(5_000), hst: $(650), total: $(5_650),
  });
  assert.deepEqual(r.franchise, { base: $(900), hst: $(117), total: $(1_017) });
  assert.equal(r.splittableBase, $(14_100));
  assert.equal(r.brokerage.split, $(2_820));
  assert.deepEqual(r.agent.split, { base: $(11_280), hst: $(1_466.4), total: $(12_746.4) });
  assert.equal(r.agent.payout, $(12_576.9));       // 12,746.40 − 169.50
  assert.equal(r.brokerage.retainedBase, $(2_970)); // 2,820 split + 150 E&O
  assert.equal(r.brokerage.netRevenueBase, $(2_920)); // less $50 tech fee absorbed
  assert.equal(r.hst.netRemittance, $(386.1));     // 13% × 2,970
  assert.deepEqual(r.ytdAfter, { houseCollected: $(2_820), franchisePaid: $(900) });

  // US brokerage referral: no HST charged to us
  const usReferral = calculateCommission({
    baseGci: $(20_000),
    agent: HST_AGENT,
    split: PLAN_80_20,
    ytd: { houseCollected: 0, franchisePaid: 0 },
    referral: { payee: "Buffalo NY Realty", rate: 2500, chargesHst: false },
  });
  assertReconciles(usReferral);
  assert.deepEqual(usReferral.referral, { payee: "Buffalo NY Realty", base: $(5_000), hst: 0, total: $(5_000) });
});

test("agent not HST-registered: no HST on their split, fees still carry HST", () => {
  const r = calculateCommission({
    baseGci: $(10_000),
    agent: { name: "New Agent", isPrec: false, hstNumber: null },
    split: PLAN_80_20,
    ytd: { houseCollected: 0, franchisePaid: 0 },
    fees: STANDARD_FEES,
  });

  assertReconciles(r);
  assert.deepEqual(r.agent.split, { base: $(8_000), hst: 0, total: $(8_000) });
  assert.equal(r.agent.payout, $(7_774));          // 8,000 − 226
  assert.equal(r.hst.netRemittance, $(1_326));     // brokerage remits all HST on GCI + fees
});

test("rejects a PREC with no legal name and a malformed HST number", () => {
  const base = { baseGci: $(10_000), split: PLAN_80_20, ytd: { houseCollected: 0, franchisePaid: 0 } };
  assert.throws(
    () => calculateCommission({ ...base, agent: { name: "Jane", isPrec: true, precLegalName: " " } }),
    CommissionError,
  );
  assert.throws(
    () => calculateCommission({ ...base, agent: { name: "Jane", isPrec: false, hstNumber: "12345RT1" } }),
    CommissionError,
  );
});
