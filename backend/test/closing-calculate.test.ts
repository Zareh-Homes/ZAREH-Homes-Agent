import { test } from "node:test";
import assert from "node:assert/strict";
import { ClosingAuditError, computeClosing, type ClosingInput } from "../src/closing/calculate.ts";
import { renderCda } from "../src/closing/cda-template.ts";
import { capYearStart } from "../src/closing/service.ts";
import { TEST_BROKERAGE } from "./fixtures.ts";

const $ = (dollars: number) => Math.round(dollars * 100);
const BROKERAGE = TEST_BROKERAGE.legalName;

const JANE = {
  userId: "u-jane",
  name: "Jane Smith",
  role: "PRIMARY" as const,
  isPrec: true,
  precLegalName: "Jane Smith Real Estate Professional Corporation",
  hstNumber: "123456789RT0001",
  splitBps: 8000,
  gciShareBps: 10_000,
  annualCap: $(15_000),
  fees: [{ name: "Deal fee", amount: $(150) }, { name: "Desk fee", amount: $(50) }],
  ytdHouseCollected: 0,
  hasPlan: true,
};

/**
 * Toronto listing: $1,100,000 sale. Our commission 2.5% = $27,500, co-op 2.0% = $22,000.
 * Seller owes ($27,500 + $22,000) × 1.13 = $55,935.00 in total.
 */
function toronto(deposit: number, holder: ClosingInput["deal"]["trustDepositHolder"]): ClosingInput {
  return {
    deal: {
      id: "deal-1", dealNumber: "2026-0042", side: "LISTING", status: "CLOSED", closeDate: "2026-11-30",
      streetAddress: "88 Queens Quay W", unit: "1205", city: "Toronto", mlsNumber: "C1234567",
      salePrice: $(1_100_000), expectedDeposit: $(deposit), trustDepositHolder: holder,
      sellers: ["Ann Lee"], buyers: ["Bo Kim"],
    },
    baseGci: $(27_500),
    coopCommission: $(22_000),
    coopBrokerage: "Harbourfront Realty Inc.",
    referral: null,
    agents: [JANE],
    closingLawyer: { name: "Patel Law LLP", email: "closings@patellaw.ca", phone: "416-555-0100" },
    trust: {
      accountId: holder === "OUR_BROKERAGE" ? "acct-1" : null,
      balance: holder === "OUR_BROKERAGE" ? $(deposit) : 0,
      accountsWithFunds: holder === "OUR_BROKERAGE" ? 1 : 0,
      activeHold: false,
      deposits: holder === "OUR_BROKERAGE" ? [{ receiptNumber: 1042, amount: $(deposit), date: "2026-10-15", payor: "Bo Kim" }] : [],
    },
    fintrac: { total: 1, outstanding: [] },
  };
}

function auditCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ClosingAuditError, String(err));
    return err.code;
  }
  assert.fail("expected a ClosingAuditError");
}

test("1–3: incoming funds, agent PREC payout and the brokerage's earned share", () => {
  const c = computeClosing(toronto(55_000, "COOP_BROKERAGE"), BROKERAGE);

  // 1. Base GCI + 13% HST
  assert.deepEqual(c.incoming.commission, { base: $(27_500), hst: $(3_575), total: $(31_075) });
  assert.deepEqual(c.incoming.coop, { base: $(22_000), hst: $(2_860), total: $(24_860) });
  assert.equal(c.incoming.totalPayable, $(55_935));

  // 3. Agent: ($22,000 + $2,860) − ($200 + $26) = $24,634, paid to the PREC by legal name
  const [jane] = c.agents;
  assert.equal(jane!.payeeName, "Jane Smith Real Estate Professional Corporation");
  assert.deepEqual(jane!.split, { base: $(22_000), hst: $(2_860), total: $(24_860) });
  assert.deepEqual(jane!.feesTotal, { base: $(200), hst: $(26), total: $(226) });
  assert.equal(jane!.payout, $(24_634));

  // Brokerage keeps $5,700 + $741 HST; $741 is this deal's net HST before the brokerage's other ITCs
  assert.deepEqual(c.brokerage.netEarnedShare, { base: $(5_700), hst: $(741), total: $(6_441) });
  assert.equal(c.brokerage.netHstEstimate, $(741));
  assert.equal(c.brokerage.agentPayablesTotal, $(24_634));
});

test("5: deposit not held by us — lawyer pays the whole $55,935 to the brokerage, nothing to the PREC", () => {
  const c = computeClosing(toronto(55_000, "COOP_BROKERAGE"), BROKERAGE);
  assert.equal(c.payer.kind, "SELLER_LAWYER");
  assert.equal(c.trust.balanceDueFromLawyer, $(55_935));
  assert.deepEqual(c.trust.distributions, []);
  assert.deepEqual(
    c.wires.map((w) => [w.to, w.payeeName, w.owed.base, w.owed.hst, w.lessFromTrust, w.amount]),
    [["BROKERAGE", BROKERAGE, $(49_500), $(6_435), 0, $(55_935)]], // our $27,500 + co-op $22,000, plus HST
  );
  assert.equal(c.wiresTotal, $(55_935));
});

test("2: deposit greater than commission — trust pays everything and $4,065 goes back to the lawyer", () => {
  const c = computeClosing(toronto(60_000, "OUR_BROKERAGE"), BROKERAGE);
  assert.equal(c.trust.balanceDueToLawyer, $(4_065)); // 60,000 − 55,935
  assert.equal(c.trust.balanceDueFromLawyer, 0);
  assert.deepEqual(
    c.trust.distributions.map((d) => [d.entryType, d.amount]),
    [
      ["DISBURSEMENT_TO_COOP", $(24_860)],
      ["DISBURSEMENT_TO_GENERAL", $(31_075)], // brokerage $6,441 + agent payout $24,634, paid out by us
      ["DISBURSEMENT_TO_LAWYER", $(4_065)],
    ],
  );
  assert.equal(c.trust.balanceAfter, 0);
  assert.deepEqual(c.wires, []);
});

test("2: deposit less than commission — co-op and brokerage from trust first, lawyer pays the rest to the brokerage", () => {
  const c = computeClosing(toronto(40_000, "OUR_BROKERAGE"), BROKERAGE);
  assert.equal(c.trust.balanceDueFromLawyer, $(15_935)); // 55,935 − 40,000
  assert.deepEqual(
    c.trust.distributions.map((d) => [d.entryType, d.amount]),
    [["DISBURSEMENT_TO_COOP", $(24_860)], ["DISBURSEMENT_TO_GENERAL", $(15_140)]], // 6,441 + 8,699 toward Jane
  );
  assert.deepEqual(c.wires.map((w) => [w.to, w.lessFromTrust, w.amount]), [["BROKERAGE", $(40_000), $(15_935)]]);
});

test("co-listing, cap and referral: shares split the GCI to the cent and the cap limits the house", () => {
  const input = toronto(0, "LAWYER");
  input.baseGci = $(20_000.01);
  input.coopCommission = 0;
  input.referral = { payee: "Out-of-town Realty", rateBps: 2500 };
  input.agents = [
    { ...JANE, gciShareBps: 5000, ytdHouseCollected: $(14_000) }, // only $1,000 of cap room left
    { ...JANE, userId: "u-sam", name: "Sam Roe", isPrec: false, precLegalName: null, hstNumber: null, gciShareBps: 5000, fees: [] },
  ];
  const c = computeClosing(input, BROKERAGE);
  assert.equal(c.agents[0]!.allocatedBaseGci + c.agents[1]!.allocatedBaseGci, $(20_000.01));
  assert.equal(c.agents[0]!.allocatedBaseGci, $(10_000.01)); // rounding cent to the primary agent
  assert.equal(c.agents[0]!.houseSplitBase, $(1_000));
  assert.equal(c.agents[0]!.capReachedOnThisDeal, true);
  assert.equal(c.agents[1]!.payeeName, "Sam Roe");
  assert.equal(c.agents[1]!.split.hst, 0); // not HST-registered
  assert.ok(c.warnings.includes("AGENT_NOT_HST_REGISTERED:Sam Roe"));
  assert.equal(c.brokerage.referral!.base, $(5_000)); // 25% of base GCI, rounded per agent share
  assert.equal(c.wiresTotal, c.incoming.totalPayable);
});

test("4: audits — not FINTRAC approved, trust that won't net to $0, holds, missing lawyer", () => {
  const notApproved = toronto(60_000, "OUR_BROKERAGE");
  notApproved.fintrac = { total: 2, outstanding: ["FINTRAC Individual Identification Record (Ann Lee): PENDING_REVIEW"] };
  assert.equal(auditCode(() => computeClosing(notApproved, BROKERAGE)), "FINTRAC_NOT_APPROVED");

  const noRecords = toronto(60_000, "OUR_BROKERAGE");
  noRecords.fintrac = { total: 0, outstanding: [] };
  assert.equal(auditCode(() => computeClosing(noRecords, BROKERAGE)), "FINTRAC_NOT_APPROVED");

  // Deal says the co-op holds the deposit, but $1,000 is sitting in our trust for it
  const stray = toronto(0, "COOP_BROKERAGE");
  stray.trust = { ...stray.trust, balance: $(1_000), accountsWithFunds: 1, accountId: "acct-1" };
  assert.equal(auditCode(() => computeClosing(stray, BROKERAGE)), "TRUST_WILL_NOT_BALANCE");

  const buyerSideDeposit = toronto(50_000, "OUR_BROKERAGE");
  buyerSideDeposit.deal.side = "BUYER";
  buyerSideDeposit.coopCommission = 0;
  assert.equal(auditCode(() => computeClosing(buyerSideDeposit, BROKERAGE)), "TRUST_WILL_NOT_BALANCE");

  const empty = toronto(50_000, "OUR_BROKERAGE");
  empty.trust = { ...empty.trust, balance: 0, accountsWithFunds: 0 };
  assert.equal(auditCode(() => computeClosing(empty, BROKERAGE)), "DEPOSIT_NOT_IN_TRUST");

  const held = toronto(60_000, "OUR_BROKERAGE");
  held.trust.activeHold = true;
  assert.equal(auditCode(() => computeClosing(held, BROKERAGE)), "TRUST_HOLD_ACTIVE");

  const noLawyer = toronto(60_000, "OUR_BROKERAGE");
  noLawyer.closingLawyer = null;
  assert.equal(auditCode(() => computeClosing(noLawyer, BROKERAGE)), "CLOSING_LAWYER_MISSING");
});

test("buyer side: the listing brokerage pays; nothing comes from our trust", () => {
  const input = toronto(0, "COOP_BROKERAGE");
  input.deal.side = "BUYER";
  input.coopCommission = 0;
  input.coopBrokerage = "Lakeshore Listing Realty";
  const c = computeClosing(input, BROKERAGE);
  assert.equal(c.payer.kind, "COOPERATING_BROKERAGE");
  assert.equal(c.payer.name, "Lakeshore Listing Realty");
  assert.equal(c.trust.balanceDueFromLawyer, 0);
  assert.equal(c.wiresTotal, $(31_075));
});

test("CDA document: lawyer copy has the wires but not the split; internal copy adds statements; HTML is escaped", () => {
  const input = toronto(40_000, "OUR_BROKERAGE");
  input.closingLawyer = { name: "Patel <Law> & Co", email: null, phone: "416-555-0100" };
  const c = computeClosing(input, BROKERAGE);
  const lawyer = renderCda(c, TEST_BROKERAGE, { audience: "lawyer", status: "FINAL", issuedOn: "2026-11-30", computationSha: "abc123" });
  const internal = renderCda(c, TEST_BROKERAGE, { audience: "internal", status: "DRAFT", issuedOn: "2026-11-28" });

  for (const text of [
    "Commission Disbursement", "CDA-2026-0042", "November 30, 2026", "1205 – 88 Queens Quay W, Toronto, Ontario",
    "Patel &lt;Law&gt; &amp; Co", "Balance due FROM lawyer", "$15,935.00", "$55,935.00",
    "Trust balance for this deal after closing", "$0.00", "Wire fraud warning",
    "Do not pay any salesperson, broker or personal real estate corporation directly",
  ]) assert.ok(lawyer.includes(text), `lawyer copy is missing: ${text}`);
  assert.ok(!lawyer.includes("Jane Smith Real Estate Professional Corporation"), "the lawyer copy names no agent payee");
  assert.ok(!lawyer.includes("Patel <Law>"));
  assert.ok(!lawyer.includes("Agent commission statements"));
  assert.ok(!lawyer.includes("DRAFT</div>"));

  assert.ok(internal.includes("Agent commission statements"));
  assert.ok(internal.includes("Estimated net HST on this deal"));
  assert.ok(internal.includes("Paid by Test Brokerage Inc. once the commission is received"), "agent statements say the brokerage pays them");
  assert.ok(internal.includes('class="watermark"'));
});

test("cap year: starts on the plan's anniversary", () => {
  assert.equal(capYearStart("2026-11-30", 1, 1), "2026-01-01");
  assert.equal(capYearStart("2026-02-10", 3, 15), "2025-03-15");
  assert.equal(capYearStart("2026-03-15", 3, 15), "2026-03-15");
});
