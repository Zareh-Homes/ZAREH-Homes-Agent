import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateTresa, type TresaFacts } from "../src/obligations/tresa.ts";
import { evaluateFintrac, evaluateProgram, type FintracFacts } from "../src/obligations/fintrac.ts";

const seller = { id: "s", role: "SELLER", name: "Ann Lee", entityType: "INDIVIDUAL" as const, representation: "OUR_CLIENT" as const };
const buyer = { id: "b", role: "BUYER", name: "Bo Kim", entityType: "INDIVIDUAL" as const, representation: "OUR_CLIENT" as const };
const disclosure = (kind: string, partyId: string | null, deliveredAt: string, extra: object = {}) => ({
  kind, partyId, offerId: null, deliveredAt, explainedAt: deliveredAt, acknowledgedAt: null, bestEffortsNote: null, formVersion: null, numberDisclosed: null, ...extra,
});
const agreement = (partyId: string, signedAt = "2026-09-01T15:00:00.000Z") => ({
  partyId, type: "BROKERAGE" as const, designatedRepresentativeIds: [], signedAt, effectiveFrom: "2026-09-01", expiresOn: "2027-03-01",
});
const base: TresaFacts = { side: "LISTING", offerDate: "2026-10-10", agentIds: ["a1"], parties: [seller], disclosures: [], agreements: [], offers: [], now: "2026-10-18T12:00:00.000Z" };
const rules = (fs: { rule: string; severity: string }[]) => fs.map((f) => `${f.rule}:${f.severity}`).sort();

test("TRESA: a client needs the Information Guide explained before services, and a representation agreement", () => {
  assert.deepEqual(rules(evaluateTresa(base)), ["INFORMATION_GUIDE:BLOCKING", "REPRESENTATION_AGREEMENT:BLOCKING"]);
  const late = evaluateTresa({ ...base, agreements: [agreement("s")], disclosures: [disclosure("INFORMATION_GUIDE", "s", "2026-09-02T10:00:00.000Z")] });
  assert.deepEqual(rules(late), ["INFORMATION_GUIDE_LATE:BREACH"]);
  const ok = evaluateTresa({ ...base, agreements: [agreement("s")], disclosures: [disclosure("INFORMATION_GUIDE", "s", "2026-09-01T14:00:00.000Z")] });
  assert.deepEqual(ok, []);
});

test("TRESA: multiple representation needs written consent from each client before the offer", () => {
  const dual: TresaFacts = { ...base, side: "DUAL", parties: [seller, buyer], agreements: [agreement("s"), agreement("b")],
    disclosures: [disclosure("INFORMATION_GUIDE", "s", "2026-09-01T10:00:00.000Z"), disclosure("INFORMATION_GUIDE", "b", "2026-09-01T10:00:00.000Z")] };
  assert.deepEqual(rules(evaluateTresa(dual)), ["MULTIPLE_REPRESENTATION:BLOCKING", "MULTIPLE_REPRESENTATION:BLOCKING"]);
  const consentAt = (at: string) => ["s", "b"].flatMap((p) => [
    disclosure("MULTIPLE_REPRESENTATION_DISCLOSURE", p, at, { acknowledgedAt: at }), disclosure("MULTIPLE_REPRESENTATION_CONSENT", p, at, { acknowledgedAt: at })]);
  assert.deepEqual(rules(evaluateTresa({ ...dual, disclosures: [...dual.disclosures, ...consentAt("2026-10-12T10:00:00.000Z")] })),
    ["MULTIPLE_REPRESENTATION_LATE:BREACH", "MULTIPLE_REPRESENTATION_LATE:BREACH"]);
  assert.deepEqual(evaluateTresa({ ...dual, disclosures: [...dual.disclosures, ...consentAt("2026-09-20T10:00:00.000Z")] }), []);
});

test("TRESA: a self-represented buyer gets the guide and the right SRP form before we assist", () => {
  const srp = { ...buyer, representation: "SELF_REPRESENTED" as const };
  const facts: TresaFacts = { ...base, parties: [seller, srp], agreements: [agreement("s")], disclosures: [disclosure("INFORMATION_GUIDE", "s", "2026-09-01T10:00:00.000Z")] };
  assert.deepEqual(rules(evaluateTresa(facts)), ["SELF_REPRESENTED_PARTY:BLOCKING"]);
  const given = evaluateTresa({ ...facts, disclosures: [...facts.disclosures, disclosure("INFORMATION_GUIDE", "b", "2026-10-09T10:00:00.000Z"),
    disclosure("SELF_REPRESENTED_PARTY_FORM", "b", "2026-10-09T10:00:00.000Z", { formVersion: "DESIGNATED_REPRESENTATION" })] });
  assert.deepEqual(rules(given), ["SELF_REPRESENTED_ACKNOWLEDGEMENT:WARNING", "SELF_REPRESENTED_FORM_VERSION:WARNING"]);
  assert.deepEqual(rules(evaluateTresa({ ...facts, parties: [seller, { ...buyer, representation: "UNKNOWN" }] })), ["REPRESENTATION_UNKNOWN:BLOCKING"]);
});

test("TRESA: competing offers — the number to every written offeror, content to all or none, our own buyer disclosed", () => {
  const offer = (id: string, receivedAt: string, extra: object = {}) =>
    ({ id, receivedAt, written: true, status: "RECEIVED", acceptedAt: null, fromOurBrokerage: false, label: `offer ${id}`, ...extra });
  const facts: TresaFacts = { ...base, agreements: [agreement("s")], disclosures: [disclosure("INFORMATION_GUIDE", "s", "2026-09-01T10:00:00.000Z")],
    offers: [offer("1", "2026-10-09T19:00:00.000Z"), offer("2", "2026-10-09T19:30:00.000Z", { fromOurBrokerage: true }), offer("3", "2026-10-09T19:45:00.000Z", { written: false })] };
  assert.deepEqual(rules(evaluateTresa(facts)), ["COMPETING_OFFERS_NUMBER:BLOCKING", "COMPETING_OFFERS_NUMBER:BLOCKING", "SAME_BROKERAGE_REPRESENTATION:BLOCKING"]);
  const number = (id: string, at: string, n: number) => ({ ...disclosure("COMPETING_OFFERS_NUMBER", null, at), offerId: id, numberDisclosed: n });
  const told = { ...facts, disclosures: [...facts.disclosures, number("1", "2026-10-09T20:00:00.000Z", 3), number("2", "2026-10-09T20:00:00.000Z", 2),
    { ...disclosure("SAME_BROKERAGE_REPRESENTATION", null, "2026-10-09T20:00:00.000Z"), offerId: "1" }] };
  assert.deepEqual(rules(evaluateTresa(told)), ["COMPETING_OFFERS_COUNT:WARNING"]); // the verbal offer doesn't count
  const content = { ...told, disclosures: [...told.disclosures, { ...disclosure("COMPETING_OFFERS_CONTENT", null, "2026-10-09T20:05:00.000Z"), offerId: "1" }] };
  assert.ok(rules(evaluateTresa(content)).includes("COMPETING_OFFERS_CONTENT:BLOCKING"));
  // After acceptance, a missing disclosure is a breach, not a to-do
  const accepted = { ...facts, offers: facts.offers.map((o) => o.id === "2" ? { ...o, status: "ACCEPTED", acceptedAt: "2026-10-09T21:00:00.000Z" } : o) };
  assert.ok(rules(evaluateTresa(accepted)).every((r) => r.endsWith(":BREACH")));
});

const fintracBase: FintracFacts = {
  side: "LISTING", offerDate: "2026-10-10", parties: [seller], records: [], determinations: [], deposits: [], reports: [], today: "2026-10-18",
};

test("FINTRAC: clients and (since 2025-10-01) unrepresented parties are identified; entities within 30 days", () => {
  assert.deepEqual(rules(evaluateFintrac(fintracBase)), ["BUSINESS_RELATIONSHIP:BLOCKING", "IDENTITY_VERIFICATION:BREACH", "PEP_HIO:BLOCKING"]);
  const srp = { ...buyer, representation: "SELF_REPRESENTED" as const };
  const withSrp = evaluateFintrac({ ...fintracBase, parties: [seller, srp] }).filter((f) => f.partyId === "b").map((f) => f.rule);
  assert.deepEqual(withSrp, ["IDENTITY_VERIFICATION"]); // no PEP or relationship record for someone who isn't our client
  assert.equal(evaluateFintrac({ ...fintracBase, offerDate: "2025-09-30", today: "2025-10-05", parties: [seller, srp] }).filter((f) => f.partyId === "b").length, 0);
  const corp = { ...seller, entityType: "CORPORATION" as const };
  const c = evaluateFintrac({ ...fintracBase, parties: [corp] });
  assert.deepEqual(c.filter((f) => f.rule === "IDENTITY_VERIFICATION").map((f) => [f.severity, f.dueBy]), [["BLOCKING", "2026-11-09"]]);
  assert.ok(c.some((f) => f.rule === "BENEFICIAL_OWNERSHIP"));
  const verifiedLate = evaluateFintrac({ ...fintracBase, records: [{ partyId: "s", kind: "FINTRAC_INDIVIDUAL", status: "APPROVED", verificationDate: "2026-10-12" }] });
  assert.ok(rules(verifiedLate).includes("IDENTITY_VERIFICATION_LATE:BREACH"));
});

test("FINTRAC: every deposit needs a receipt of funds record; high risk calls for enhanced measures; open reports have deadlines", () => {
  const f = evaluateFintrac({
    ...fintracBase,
    records: [{ partyId: "s", kind: "FINTRAC_INDIVIDUAL", status: "APPROVED", verificationDate: "2026-10-10" }],
    determinations: [
      { partyId: "s", kind: "PEP_HIO", result: "FOREIGN_PEP", riskRating: "HIGH", determinedAt: "2026-10-10T10:00:00Z" },
      { partyId: "s", kind: "BUSINESS_RELATIONSHIP", result: "Sale", riskRating: null, determinedAt: "2026-10-10T10:00:00Z" },
    ],
    deposits: [{ entryId: "e", amount: "500.00", receivedDate: "2026-10-12", method: "BANK_DRAFT", hasReceiptOfFunds: false }],
    reports: [{ id: "r", kind: "LARGE_CASH", dueAt: "2026-10-17T03:59:00.000Z", status: "OPEN" }],
  });
  assert.deepEqual(rules(f), ["ENHANCED_MEASURES:WARNING", "RECEIPT_OF_FUNDS:BLOCKING", "REPORT_LARGE_CASH:BREACH"]);
  assert.deepEqual(evaluateFintrac({ ...fintracBase, side: "LANDLORD" }), []);
});

test("FINTRAC program: officer, policies, risk assessment, training and the two-year review", () => {
  const empty = evaluateProgram({ officer: null, policiesApprovedOn: null, riskAssessmentOn: null, lastReviewOn: null, agents: [{ id: "a", name: "Ava", lastTrainedOn: null }], today: "2026-10-18" });
  assert.deepEqual(rules(empty), ["COMPLIANCE_OFFICER:BLOCKING", "EFFECTIVENESS_REVIEW:BLOCKING", "POLICIES:BLOCKING", "RISK_ASSESSMENT:BLOCKING", "TRAINING:WARNING"]);
  const stale = evaluateProgram({ officer: { name: "Dan", since: "2024-01-01" }, policiesApprovedOn: "2024-01-01", riskAssessmentOn: "2025-01-01",
    lastReviewOn: "2024-06-30", agents: [{ id: "a", name: "Ava", lastTrainedOn: "2026-02-01" }], today: "2026-10-18" });
  assert.deepEqual(rules(stale), ["EFFECTIVENESS_REVIEW_OVERDUE:BREACH", "RISK_ASSESSMENT_STALE:WARNING"]);
});
