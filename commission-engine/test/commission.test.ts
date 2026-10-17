import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateCommission,
  dollarsToCents as $,
  type CommissionBreakdown,
  type FlatFee,
  type SplitPlan,
} from "../src/commission.ts";

// Standard Zareh Homes plan: 80/20, house capped at $15,000 per cap year
const PLAN_80_20: SplitPlan = { agentRate: 8000, annualCap: $(15_000) };

const STANDARD_FEES: FlatFee[] = [
  { name: "E&O insurance", amount: $(150), paidBy: "AGENT" },
  { name: "Tech fee", amount: $(50), paidBy: "AGENT" },
];

/** Every dollar of GCI has to land somewhere, to the cent. */
function assertReconciles(r: CommissionBreakdown): void {
  const referral = r.referral?.amount ?? 0;
  assert.equal(referral + r.franchiseFee + r.houseGross + r.agentGross, r.gci, "GCI does not reconcile");
  assert.equal(r.splittable, r.houseGross + r.agentGross);
}

test("1) standard uncapped 80/20 deal", () => {
  const r = calculateCommission({
    gci: $(20_000),
    split: PLAN_80_20,
    ytd: { houseCollected: $(4_000), franchisePaid: 0 },
    fees: STANDARD_FEES,
  });

  assertReconciles(r);
  assert.equal(r.referral, null);
  assert.equal(r.franchiseFee, 0);
  assert.equal(r.splittable, $(20_000));
  assert.equal(r.houseGross, $(4_000));      // 20%
  assert.equal(r.agentGross, $(16_000));     // 80%
  assert.equal(r.agentNet, $(15_800));       // less $150 E&O and $50 tech
  assert.equal(r.agentOwes, 0);
  assert.equal(r.houseNet, $(4_000));
  assert.equal(r.effectiveAgentRate, 8000);
  assert.equal(r.capReachedOnThisDeal, false);
  assert.equal(r.capRemainingAfter, $(7_000)); // 15,000 − (4,000 + 4,000)
  assert.deepEqual(r.ytdAfter, { houseCollected: $(8_000), franchisePaid: 0 });
});

test("2) agent hits the $15,000 cap mid-transaction, next deal is 100%", () => {
  // House already has $13,000 → only $2,000 of room left
  const r = calculateCommission({
    gci: $(20_000),
    split: PLAN_80_20,
    ytd: { houseCollected: $(13_000), franchisePaid: 0 },
    fees: STANDARD_FEES,
  });

  assertReconciles(r);
  assert.equal(r.houseGross, $(2_000));      // capped, not the normal $4,000
  assert.equal(r.agentGross, $(18_000));     // 80% on the first $10,000, 100% on the rest
  assert.equal(r.agentNet, $(17_800));
  assert.equal(r.effectiveAgentRate, 9000);  // 90% blended on this deal
  assert.equal(r.capReachedOnThisDeal, true);
  assert.equal(r.capRemainingAfter, 0);
  assert.equal(r.ytdAfter.houseCollected, $(15_000));

  // Following deal: agent is capped, house takes nothing from the split; fees still apply
  const next = calculateCommission({
    gci: $(12_500),
    split: PLAN_80_20,
    ytd: r.ytdAfter,
    fees: STANDARD_FEES,
  });

  assertReconciles(next);
  assert.equal(next.houseGross, 0);
  assert.equal(next.agentGross, $(12_500));
  assert.equal(next.agentNet, $(12_300));
  assert.equal(next.effectiveAgentRate, 10_000);
  assert.equal(next.capReachedOnThisDeal, false); // reached on the previous deal, not this one
  assert.equal(next.ytdAfter.houseCollected, $(15_000));
});

test("3) 25% outside referral off the top, then franchise fee, then split", () => {
  const r = calculateCommission({
    gci: $(20_000),
    split: PLAN_80_20,
    ytd: { houseCollected: 0, franchisePaid: 0 },
    referral: { payee: "Out-of-town Realty Brokerage", rate: 2500 },
    franchise: { rate: 600, annualCap: $(3_000) },
    fees: [
      { name: "E&O insurance", amount: $(150), paidBy: "AGENT" },
      { name: "Tech fee", amount: $(50), paidBy: "HOUSE" }, // house absorbs this one
    ],
  });

  assertReconciles(r);
  assert.deepEqual(r.referral, { payee: "Out-of-town Realty Brokerage", amount: $(5_000) });
  assert.equal(r.franchiseFee, $(900));      // 6% of the $15,000 left after referral
  assert.equal(r.splittable, $(14_100));
  assert.equal(r.houseGross, $(2_820));      // 20% of $14,100
  assert.equal(r.agentGross, $(11_280));     // 80% of $14,100
  assert.equal(r.agentNet, $(11_130));       // less E&O
  assert.equal(r.houseNet, $(2_770));        // less tech fee
  assert.deepEqual(r.agentFees.map((f) => f.name), ["E&O insurance"]);
  assert.deepEqual(r.houseFees.map((f) => f.name), ["Tech fee"]);
  assert.deepEqual(r.ytdAfter, { houseCollected: $(2_820), franchisePaid: $(900) });

  // Franchise cap: with $2,500 already paid this year, only $500 more is charged
  const nearFranchiseCap = calculateCommission({
    gci: $(20_000),
    split: PLAN_80_20,
    ytd: { houseCollected: 0, franchisePaid: $(2_500) },
    referral: { payee: "Out-of-town Realty Brokerage", rate: 2500 },
    franchise: { rate: 600, annualCap: $(3_000) },
  });
  assertReconciles(nearFranchiseCap);
  assert.equal(nearFranchiseCap.franchiseFee, $(500));
  assert.equal(nearFranchiseCap.splittable, $(14_500));
});
