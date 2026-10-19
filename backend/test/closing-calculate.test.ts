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
    hstRate: 1300,
    taxName: "HST",
    coopCommission: $(22_000),
    coopBrokerage: "Harbourfront Realty Inc.",
    referral: null,
    agents: [JANE],
    closingLawyer: { name: "Patel Law LLP", email: "closings@patellaw.ca", phone: "416-555-0100" },
    trust: {
      accountId: holder === "OUR_BROKERAGE" ? "acct-1" : null,
      balance: holder === "OUR_BROKERAGE" ? $(deposit) : 0,
      cleared: holder === "OUR_BROKERAGE" ? $(deposit) : 0,
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
  stray.trust = { ...stray.trust, balance: $(1_000), cleared: $(1_000), accountsWithFunds: 1, accountId: "acct-1" };
  assert.equal(auditCode(() => computeClosing(stray, BROKERAGE)), "TRUST_WILL_NOT_BALANCE");

  const buyerSideDeposit = toronto(50_000, "OUR_BROKERAGE");
  buyerSideDeposit.deal.side = "BUYER";
  buyerSideDeposit.coopCommission = 0;
  assert.equal(auditCode(() => computeClosing(buyerSideDeposit, BROKERAGE)), "TRUST_WILL_NOT_BALANCE");

  const empty = toronto(50_000, "OUR_BROKERAGE");
  empty.trust = { ...empty.trust, balance: 0, accountsWithFunds: 0 };
  assert.equal(auditCode(() => computeClosing(empty, BROKERAGE)), "DEPOSIT_NOT_IN_TRUST");

  const uncleared = toronto(60_000, "OUR_BROKERAGE");
  uncleared.trust.cleared = $(10_000);
  assert.equal(auditCode(() => computeClosing(uncleared, BROKERAGE)), "FUNDS_NOT_CLEARED");

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
    "Do not pay any salesperson, broker or personal real estate", "not necessarily the whole commission on the property",
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

test("adjustments: a taxable bonus, a deduction and a recovery change the agent's payout and the brokerage's share", () => {
  const input = toronto(0, "COOP_BROKERAGE");
  input.agents = [{ ...JANE, adjustments: [
    { id: "b1", kind: "BONUS", description: "Top producer bonus", amount: $(500), taxable: true },
    { id: "d1", kind: "DEDUCTION", description: "Feature sheet printing", amount: $(100), taxable: true },
    { id: "r1", kind: "RECOVERY", description: "Recalled commission on 2026-0011", amount: $(1_000), taxable: false },
  ] }];
  const base = computeClosing(toronto(0, "COOP_BROKERAGE"), "Test Brokerage Inc.");
  const c = computeClosing(input, "Test Brokerage Inc.");
  const jane = c.agents[0]!;
  // +$565 bonus (registered agent), −$113 deduction, −$1,000 recovery (no HST)
  assert.equal(jane.payout, base.agents[0]!.payout + $(565) - $(113) - $(1_000));
  assert.deepEqual(jane.adjustments.map((a) => [a.kind, a.hst, a.signedTotal]), [["BONUS", $(65), $(565)], ["DEDUCTION", $(13), -$(113)], ["RECOVERY", 0, -$(1_000)]]);
  assert.equal(c.brokerage.agentPayablesTotal, jane.payout);
  assert.equal(c.brokerage.netEarnedShare.total, c.incoming.commission.total - jane.payout);
  assert.equal(c.brokerage.netHstEstimate, base.brokerage.netHstEstimate - $(65) + $(13));
  // House share and the cap are unaffected: adjustments sit on top of the split
  assert.equal(jane.houseSplitBase, base.agents[0]!.houseSplitBase);
  assert.match(renderCda(c, TEST_BROKERAGE, { audience: "internal", status: "DRAFT", issuedOn: "2026-11-30" }), /Plus: Top producer bonus/);
});

test("adjustments: a bonus to an agent who isn't HST-registered carries no HST; deductions bigger than the payout leave the agent owing", () => {
  const input = toronto(0, "COOP_BROKERAGE");
  input.agents = [{ ...JANE, hstNumber: null, adjustments: [
    { id: "b1", kind: "BONUS", description: "Bonus", amount: $(500), taxable: true },
    { id: "d1", kind: "DEDUCTION", description: "Advance repaid", amount: $(30_000), taxable: false },
  ] }];
  const c = computeClosing(input, "Test Brokerage Inc.");
  assert.equal(c.agents[0]!.adjustments[0]!.hst, 0);
  assert.equal(c.agents[0]!.payout, 0);
  assert.ok(c.agents[0]!.owes > 0);
  assert.ok(c.warnings.includes("AGENT_OWES_FEES:Jane Smith"));
});

test("tax: no rate on file means no CDA; the rate and its name come from the property's province", () => {
  const unknown = { ...toronto(0, "COOP_BROKERAGE"), hstRate: undefined };
  assert.equal(auditCode(() => computeClosing(unknown, "Test Brokerage Inc.")), "TAX_RATE_UNKNOWN");
  const ns = { ...toronto(0, "COOP_BROKERAGE"), hstRate: 1400, taxName: "HST" as const };
  ns.deal = { ...ns.deal, province: "NS", city: "Halifax" };
  const c = computeClosing(ns, "Test Brokerage Inc.");
  assert.equal(c.incoming.commission.hst, $(3_850)); // 14% of $27,500
  const html = renderCda(c, TEST_BROKERAGE, { audience: "lawyer", status: "DRAFT", issuedOn: "2026-11-30" });
  assert.match(html, /Halifax, Nova Scotia/);
  assert.match(html, /Amounts include HST at 14%/);
  const gst = { ...toronto(0, "COOP_BROKERAGE"), hstRate: 500, taxName: "GST" as const };
  gst.deal = { ...gst.deal, province: "AB" };
  assert.match(renderCda(computeClosing(gst, "Test Brokerage Inc."), TEST_BROKERAGE, { audience: "lawyer", status: "DRAFT", issuedOn: "2026-11-30" }), /Amounts include GST at 5%/);
});

test("plan: a deal split that differs from the agent's plan is flagged", () => {
  const input = toronto(0, "COOP_BROKERAGE");
  input.agents = [{ ...JANE, planSplitBps: 7000 }];
  assert.ok(computeClosing(input, "Test Brokerage Inc.").warnings.includes("SPLIT_DIFFERS_FROM_PLAN:Jane Smith:80% on the deal, 70% in the plan"));
});

// ── Leases ───────────────────────────────────────────────────────────────────

/**
 * Landlord-side residential lease at $3,000/month. We hold first and last month's rent ($6,000).
 * Our commission: one month's rent $3,000; co-op: half a month, $1,500. Landlord owes $4,500 × 1.13 = $5,085.00.
 */
function landlordLease(side: "LANDLORD" | "TENANT" = "LANDLORD"): ClosingInput {
  const base = toronto(6_000, side === "LANDLORD" ? "OUR_BROKERAGE" : "COOP_BROKERAGE");
  return {
    ...base,
    deal: { ...base.deal, side, salePrice: $(3_000), sellers: ["Rita Olsen"], buyers: ["Kofi Mensah"], mlsNumber: null },
    baseGci: side === "LANDLORD" ? $(3_000) : $(1_500),
    coopCommission: side === "LANDLORD" ? $(1_500) : 0,
    coopBrokerage: side === "LANDLORD" ? "Harbourfront Realty Inc." : "Lakeshore Realty Ltd.",
    closingLawyer: null,
    landlord: { name: "Rita Olsen", email: "rita@example.test", phone: null },
    fintrac: { total: 0, outstanding: [] }, // FINTRAC's real estate record-keeping covers purchases and sales, not leases
  };
}

test("landlord-side lease: commission comes out of the rent deposit, the balance goes to the landlord", () => {
  const c = computeClosing(landlordLease(), BROKERAGE);
  assert.deepEqual(c.payer, { kind: "LANDLORD", name: "Rita Olsen" });
  assert.equal(c.incoming.totalPayable, $(5_085));
  assert.deepEqual(c.trust.distributions.map((d) => [d.entryType, d.payee, d.amount]), [
    ["DISBURSEMENT_TO_COOP", "Harbourfront Realty Inc.", $(1_695)],
    ["DISBURSEMENT_TO_GENERAL", `${BROKERAGE} (general account)`, $(3_390)],
    ["DISBURSEMENT_TO_LANDLORD", "Rita Olsen", $(915)],
  ]);
  assert.equal(c.trust.balanceAfter, 0);
  assert.equal(c.wiresTotal, 0);
  // Agent: 80% of $3,000 = $2,400 + HST $312, less fees $200 + HST $26
  assert.equal(c.agents[0]!.payout, $(2_486));

  const html = renderCda(c, TEST_BROKERAGE, { audience: "lawyer", status: "DRAFT", issuedOn: "2026-11-30" });
  assert.ok(html.includes("Lease commencement") && html.includes("To: Landlord") && html.includes("Balance due TO landlord"));
  assert.ok(html.includes("Landlord(s)") && html.includes("Tenant(s)") && !html.includes("Sale price"));
});

test("landlord-side lease with a deposit short of the commission: the landlord pays the rest to the brokerage", () => {
  const input = landlordLease();
  input.trust = { ...input.trust, balance: $(3_000), cleared: $(3_000), deposits: [{ ...input.trust.deposits[0]!, amount: $(3_000) }] };
  input.deal = { ...input.deal, expectedDeposit: $(3_000) };
  const c = computeClosing(input, BROKERAGE);
  assert.equal(c.trust.balanceDueFromLawyer, $(2_085));
  assert.deepEqual(c.wires.map((w) => w.amount), [$(2_085)]);
  assert.ok(!c.trust.distributions.some((d) => d.entryType === "DISBURSEMENT_TO_LANDLORD"));
});

test("tenant-side lease: the listing brokerage pays us, as on a buyer-side sale", () => {
  const c = computeClosing(landlordLease("TENANT"), BROKERAGE);
  assert.deepEqual(c.payer, { kind: "COOPERATING_BROKERAGE", name: "Lakeshore Realty Ltd." });
  assert.equal(c.trust.distributions.length, 0);
  assert.equal(c.wiresTotal, $(1_695));
});

test("leases: no landlord on the deal, no CDA; and FINTRAC records that do exist must still be approved", () => {
  assert.equal(auditCode(() => computeClosing({ ...landlordLease(), landlord: null }, BROKERAGE)), "LANDLORD_MISSING");
  assert.equal(auditCode(() => computeClosing({ ...landlordLease(), fintrac: { total: 1, outstanding: ["ID record: PENDING"] } }, BROKERAGE)),
    "FINTRAC_NOT_APPROVED");
  // A sale still needs FINTRAC records
  assert.equal(auditCode(() => computeClosing({ ...toronto(60_000, "OUR_BROKERAGE"), fintrac: { total: 0, outstanding: [] } }, BROKERAGE)),
    "FINTRAC_NOT_APPROVED");
});

// ── Same brokerage on both sides: a fictional $1,000,000 sale, 2% per side ─────────────────────────────────
// Each side's commission comes from its own agreement and is split among that side's agents only; the
// commission is billed once ($40,000 + 13% HST = $45,200) and the brokerage's share is counted once.

const sameBrokerage = (sides: { listing: number; buyer: number }, agents: ClosingInput["agents"]): ClosingInput => ({
  deal: {
    id: "deal-dual", dealNumber: "2026-0100", side: "DUAL", status: "CLOSED", closeDate: "2026-11-30",
    streetAddress: "1 Escarpment Cres", unit: null, city: "Hamilton", mlsNumber: null,
    salePrice: $(1_000_000), expectedDeposit: $(50_000), trustDepositHolder: "OUR_BROKERAGE", sellers: ["Ana Seller"], buyers: ["Ben Buyer"],
  },
  baseGci: $(sides.listing + sides.buyer), sides: { listing: $(sides.listing), buyer: $(sides.buyer) },
  hstRate: 1300, taxName: "HST", coopCommission: 0, coopBrokerage: null, referral: null, agents,
  closingLawyer: { name: "Seller Law LLP", email: "closings@sellerlaw.test", phone: null },
  trust: { accountId: "acct-1", balance: $(50_000), cleared: $(50_000), accountsWithFunds: 1, activeHold: false,
    deposits: [{ receiptNumber: 2001, amount: $(50_000), date: "2026-10-20", payor: "Ben Buyer" }] },
  fintrac: { total: 2, outstanding: [] },
});
const agentOn = (userId: string, name: string, side: "LISTING" | "BUYER" | "BOTH", gciShareBps: number, extra: Partial<ClosingInput["agents"][number]> = {}) =>
  ({ userId, name, role: "PRIMARY" as const, isPrec: false, precLegalName: null, hstNumber: null, splitBps: 8000, gciShareBps,
     annualCap: null, fees: [], ytdHouseCollected: 0, hasPlan: true, side, ...extra });
const byName = (c: ReturnType<typeof computeClosing>) => Object.fromEntries(c.agents.map((a) => [a.name, a]));

test("same brokerage, two agents (one per side): each paid from their own side, the commission billed once", () => {
  const c = computeClosing(sameBrokerage({ listing: 20_000, buyer: 20_000 }, [
    agentOn("a", "Agent A", "LISTING", 10_000, { hstNumber: "111111111RT0001" }), agentOn("b", "Agent B", "BUYER", 10_000)]), BROKERAGE);
  assert.deepEqual([c.incoming.commission.base, c.incoming.commission.hst, c.incoming.commission.total], [$(40_000), $(5_200), $(45_200)]);
  assert.equal(c.incoming.coop.total, 0); // our own agent is never a co-operating brokerage
  assert.deepEqual(c.incoming.sides, { listing: $(20_000), buyer: $(20_000) });
  const a = byName(c);
  assert.deepEqual(a["Agent A"]!.fromSides, { listing: $(20_000), buyer: 0 });
  assert.deepEqual([a["Agent A"]!.split.base, a["Agent A"]!.split.hst, a["Agent A"]!.payout], [$(16_000), $(2_080), $(18_080)]); // registered: HST on split
  assert.deepEqual(a["Agent B"]!.fromSides, { listing: 0, buyer: $(20_000) });
  assert.deepEqual([a["Agent B"]!.split.base, a["Agent B"]!.split.hst, a["Agent B"]!.payout], [$(16_000), 0, $(16_000)]);
  // Brokerage: $4,000 from each side, once; HST to remit = $5,200 collected − $2,080 paid to Agent A
  assert.deepEqual([c.brokerage.netEarnedShare.base, c.brokerage.netEarnedShare.hst], [$(8_000), $(3_120)]);
  assert.equal(c.agents.reduce((s, x) => s + x.allocatedBaseGci, 0) + 0, $(40_000)); // nothing allocated twice
});

test("same brokerage, one agent on both sides: earns both sides once, through one plan run (cap applies to the total)", () => {
  const c = computeClosing(sameBrokerage({ listing: 20_000, buyer: 20_000 }, [
    agentOn("a", "Agent A", "BOTH", 10_000, { annualCap: $(5_000) })]), BROKERAGE);
  const a = byName(c)["Agent A"]!;
  assert.deepEqual(a.fromSides, { listing: $(20_000), buyer: $(20_000) });
  assert.equal(a.allocatedBaseGci, $(40_000));
  // 20% house share of $40,000 is $8,000, capped at $5,000: the agent keeps $35,000
  assert.deepEqual([a.split.base, a.houseSplitBase, a.capReachedOnThisDeal], [$(35_000), $(5_000), true]);
  assert.equal(c.brokerage.netEarnedShare.base, $(5_000));
});

test("same brokerage, two agents share the listing side, one on the buyer side", () => {
  const c = computeClosing(sameBrokerage({ listing: 20_000, buyer: 20_000 }, [
    agentOn("a1", "Agent A1", "LISTING", 5_000), agentOn("a2", "Agent A2", "LISTING", 5_000, { role: "CO_AGENT", fees: [{ name: "Deal fee", amount: $(250) }] }),
    agentOn("b", "Agent B", "BUYER", 10_000, { role: "CO_AGENT", splitBps: 9000 })]), BROKERAGE);
  const a = byName(c);
  assert.deepEqual([a["Agent A1"]!.allocatedBaseGci, a["Agent A1"]!.split.base], [$(10_000), $(8_000)]);
  assert.deepEqual([a["Agent A2"]!.allocatedBaseGci, a["Agent A2"]!.split.base, a["Agent A2"]!.payout], [$(10_000), $(8_000), $(8_000) - $(250) - $(32.5)]);
  assert.deepEqual([a["Agent B"]!.allocatedBaseGci, a["Agent B"]!.split.base], [$(20_000), $(18_000)]); // B's own 90% plan
});

test("same brokerage, unequal sides (2.5% + 2%): each side exact to the cent, no shifting between agents", () => {
  const c = computeClosing(sameBrokerage({ listing: 25_000, buyer: 20_000 }, [
    agentOn("a", "Agent A", "LISTING", 10_000), agentOn("b", "Agent B", "BUYER", 10_000)]), BROKERAGE);
  const a = byName(c);
  assert.deepEqual([a["Agent A"]!.split.base, a["Agent B"]!.split.base], [$(20_000), $(16_000)]);
});

test("same brokerage: sides missing, not adding up, an agent without a side, or a side without agents: no CDA", () => {
  const two = [agentOn("a", "Agent A", "LISTING", 10_000), agentOn("b", "Agent B", "BUYER", 10_000)];
  assert.equal(auditCode(() => computeClosing({ ...sameBrokerage({ listing: 20_000, buyer: 20_000 }, two), sides: null }, BROKERAGE)), "SIDES_MISSING");
  assert.equal(auditCode(() => computeClosing({ ...sameBrokerage({ listing: 20_000, buyer: 20_000 }, two), baseGci: $(39_000) }, BROKERAGE)), "SIDES_MISMATCH");
  assert.equal(auditCode(() => computeClosing(sameBrokerage({ listing: 20_000, buyer: 20_000 }, [two[0]!, { ...two[1]!, side: null }]), BROKERAGE)), "AGENT_SIDE_MISSING");
  assert.equal(auditCode(() => computeClosing(sameBrokerage({ listing: 20_000, buyer: 20_000 }, [two[0]!]), BROKERAGE)), "SIDE_WITHOUT_AGENT");
  assert.equal(auditCode(() => computeClosing(sameBrokerage({ listing: 20_000, buyer: 20_000 }, [two[0]!, { ...two[1]!, gciShareBps: 5_000 }]), BROKERAGE)), "GCI_SHARES_INVALID");
});

test("the earlier HST figure: $2,437.50 is 13% of the whole $18,750 commission, kept by the brokerage only because the agent isn't HST-registered", () => {
  // Buyer-side $750,000 sale from the demo: $18,750 commission, agent 70% split, no HST number
  const input: ClosingInput = { ...toronto(0, "COOP_BROKERAGE"), deal: { ...toronto(0, "COOP_BROKERAGE").deal, side: "BUYER", salePrice: $(750_000) },
    baseGci: $(18_750), coopCommission: 0, coopBrokerage: "Lakeshore Realty Ltd.",
    agents: [{ ...JANE, isPrec: false, precLegalName: null, hstNumber: null, splitBps: 7000, annualCap: null, fees: [] }] };
  const c = computeClosing(input, BROKERAGE);
  assert.equal(c.incoming.commission.hst, $(2_437.5)); // 13% × $18,750
  assert.equal(c.agents[0]!.split.base, $(13_125));
  assert.equal(c.agents[0]!.split.hst, 0);
  assert.equal(c.brokerage.netEarnedShare.base, $(5_625));
  // HST to remit is the HST collected less HST paid to agents: all $2,437.50 here, not 13% of $5,625 ($731.25)
  assert.equal(c.brokerage.netEarnedShare.hst, $(2_437.5));
  assert.equal(c.brokerage.netHstEstimate, $(2_437.5));
});
