/** The deal check's rules, on their own: a clean deal has nothing to flag; each mistake is caught once. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateDealCheck, type DealCheckFacts } from "../src/deals/check.ts";

const TODAY = "2026-11-09";
const clean: DealCheckFacts = {
  side: "LISTING", status: "CONDITIONAL", salePrice: 849000, offerDate: "2026-11-01", conditionsDueDate: "2026-11-12", closeDate: "2027-01-15",
  depositAmount: 40000, depositDueDate: "2026-11-03", depositHolder: "OUR_BROKERAGE", totalGci: 21225, coopCommission: 16980,
  coopBrokerage: "Harbourfront Realty Inc.", buyerPays: 0,
  parties: [
    { role: "SELLER", name: "Ann Lee", representation: "OUR_CLIENT", email: null, phone: null },
    { role: "BUYER", name: "Bo Kim", representation: "REPRESENTED_ELSEWHERE", email: null, phone: null },
    { role: "SELLER_LAWYER", name: "Patel Law LLP", representation: null, email: "deals@patel.test", phone: null },
  ],
  agents: [{ name: "Priya Shah", recoExpiryDate: "2027-06-30", profile: true, planInForceAtClose: true }],
  conditions: [{ description: "Financing", dueAt: "2026-11-12T23:59:00.000Z", state: "OPEN", lastEventAt: null, lastEventHasDocument: false, extensions: 0 }],
  amendments: [], termination: null, deposits: [{ receivedDate: "2026-11-02", amount: 40000 }],
  documents: [{ name: "Agreement of Purchase and Sale", status: "APPROVED", required: true }],
  agreementsExpiring: [], compliance: [],
};
const check = (patch: Partial<DealCheckFacts>, today = TODAY) => evaluateDealCheck({ ...clean, ...patch }, today);
const one = (patch: Partial<DealCheckFacts>, today = TODAY) => {
  const issues = check(patch, today);
  assert.equal(issues.length, 1, JSON.stringify(issues, null, 1));
  return issues[0]!;
};

test("a clean deal has nothing to flag", () => assert.deepEqual(check({}), []));

test("dates that don't line up", () => {
  const backwards = check({ closeDate: "2026-10-30", conditionsDueDate: null, conditions: [] });
  assert.ok(backwards.some((i) => i.severity === "MUST_FIX" && /Closing \(2026-10-30\) is before the offer date/.test(i.message)));
  assert.match(one({ conditionsDueDate: "2027-02-01" }).message, /outside the offer .* to closing/);
  assert.match(one({ depositDueDate: "2026-10-30", depositHolder: "COOP_BROKERAGE" }).message, /due 2026-10-30, before the offer date/);
  // Closing on a holiday or weekend: Good Friday, a Saturday, and the Civic Holiday (banks and lawyers are closed)
  assert.match(one({ closeDate: "2027-03-26" }).message, /Good Friday/);
  assert.match(one({ closeDate: "2027-01-16" }).message, /a weekend/);
  assert.match(one({ closeDate: "2027-08-02", agents: [{ ...clean.agents[0]!, recoExpiryDate: "2028-01-01" }] }).message, /Civic Holiday/);
  const past = check({ status: "FIRM", closeDate: "2026-11-06", conditions: [] }, TODAY);
  assert.ok(past.some((i) => i.severity === "MUST_FIX" && /has passed and the deal isn't closed/.test(i.message)));
});

test("conditions, waivers and their documents", () => {
  const c = clean.conditions[0]!;
  const overdue = one({ conditions: [{ ...c, dueAt: "2026-11-05T23:59:00.000Z" }] });
  assert.equal(overdue.severity, "MUST_FIX");
  assert.match(overdue.message, /was due 2026-11-05 and nothing is recorded/);
  // Waived on time with the signed waiver: fine
  assert.deepEqual(check({ conditions: [{ ...c, state: "WAIVED", lastEventAt: "2026-11-10T15:00:00.000Z", lastEventHasDocument: true }] }), []);
  // Waived after the deadline
  assert.match(one({ conditions: [{ ...c, state: "WAIVED", lastEventAt: "2026-11-13T15:00:00.000Z", lastEventHasDocument: true }] }).message, /after its deadline/);
  // Waived with nothing signed attached
  assert.match(one({ conditions: [{ ...c, state: "WAIVED", lastEventAt: "2026-11-10T15:00:00.000Z", lastEventHasDocument: false }] }).message, /no signed document attached/);
  assert.match(one({ conditions: [{ ...c, dueAt: "2027-02-01T00:00:00.000Z" }] }).message, /after closing/);
  assert.match(one({ conditions: [] }).message, /no conditions are recorded/);
});

test("amendments and terminations need the signed form", () => {
  assert.match(one({ amendments: [{ field: "CLOSE_DATE", newValue: "2027-01-15", createdAt: "2026-11-05T12:00:00Z", hasDocument: false }] }).message,
    /close date amendment .* no signed amendment/);
  assert.match(one({ termination: { terminatedOn: "2026-11-08", hasDocument: false } }).message, /mutual release/);
});

test("deposit: late, missing, or a different amount from the agreement", () => {
  assert.match(one({ deposits: [] }).message, /due 2026-11-03 and isn't recorded in trust/);
  assert.match(one({ deposits: [{ receivedDate: "2026-11-02", amount: 30000 }] }).message, /Trust holds \$30,000.00; the agreement says \$40,000.00/);
  assert.match(one({ deposits: [{ receivedDate: "2026-11-05", amount: 40000 }] }).message, /after its due date/);
  // Held by the other brokerage: nothing to match in our trust account
  assert.deepEqual(check({ depositHolder: "COOP_BROKERAGE", deposits: [] }), []);
});

test("commission, people and agents", () => {
  assert.match(one({ totalGci: 0, coopCommission: 0 }).message, /No commission/);
  assert.match(one({ totalGci: 70000 }).message, /over 7%/);
  assert.match(one({ coopBrokerage: null }).message, /no co-operating brokerage/);
  assert.match(one({ parties: clean.parties.filter((p) => p.role !== "BUYER") }).message, /No buyer/);
  assert.match(one({ parties: clean.parties.map((p) => p.role === "SELLER" ? { ...p, representation: null } : p) }).message, /Whether Ann Lee is our client/);
  assert.match(one({ parties: clean.parties.map((p) => p.role === "SELLER_LAWYER" ? { ...p, email: null } : p) }).message, /no email or phone/);
  assert.match(one({ agents: [{ ...clean.agents[0]!, recoExpiryDate: "2027-01-10" }] }).message, /RECO registration expires 2027-01-10/);
  assert.equal(one({ agents: [{ ...clean.agents[0]!, planInForceAtClose: false }] }).severity, "MUST_FIX");
  assert.match(one({ agreementsExpiring: [{ client: "Ann Lee", expiresOn: "2026-12-31" }] }).message, /expires 2026-12-31, before closing/);
});

test("documents and TRESA/FINTRAC items roll in", () => {
  assert.match(one({ documents: [{ name: "Agreement of Purchase and Sale", status: "MISSING", required: true }] }).message, /isn't uploaded/);
  assert.deepEqual(check({ documents: [{ name: "Optional", status: "MISSING", required: false }] }), []);
  assert.match(one({ documents: [{ name: "Agreement of Purchase and Sale", status: "NEEDS_REVISION", required: true }] }).message, /was sent back/);
  const c = one({ compliance: [{ severity: "BLOCKING", message: "Bo Kim's identity hasn't been verified" }] });
  assert.equal(c.severity, "MUST_FIX");
  assert.equal(c.tab, "compliance");
  assert.match(one({ compliance: [{ severity: "BREACH", message: "Information guide given late" }] }).message, /^Late:/);
});
