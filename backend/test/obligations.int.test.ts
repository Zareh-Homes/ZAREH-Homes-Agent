/**
 * TRESA and FINTRAC obligations through the API (migration 016). Needs DATABASE_URL; skipped otherwise.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { designateBroker, TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-10-18";

describe("compliance obligations", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { agent: "", agent2: "", broker: "", compliance: "" };
  let account = "";

  const as = (user: string, method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user, "idempotency-key": randomUUID() }, ...(body ? { payload: body } : {}) });

  async function deal(side: "LISTING" | "DUAL", parties: object[], extra: object = {}) {
    const res = await as(u.agent, "POST", "/api/deals", {
      side, streetAddress: "5 Lake Ave", city: "Stoney Creek", salePrice: "690000", offerDate: "2026-10-10", closeDate: "2026-12-10",
      depositAmount: "20000", trustDepositHolder: "OUR_BROKERAGE", totalGci: "17250",
      ...(side === "DUAL" ? { listingSideGci: "8625", buyerSideGci: "8625" } : {}),
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80, ...(side === "DUAL" ? { side: "BOTH" } : {}) }], parties, ...extra,
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  }

  before(async () => {
    const make = async (role: UserRole) => (await prisma.user.create({
      data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: "Ob", lastName: role, role },
    })).id;
    u.agent = await make("AGENT");
    u.agent2 = await make("AGENT");
    u.broker = await make("MANAGING_BROKER");
    u.compliance = await make("COMPLIANCE_ADMIN");
    await designateBroker(app, prisma, u.broker);
    account = (await prisma.trustAccount.create({ data: { name: `Trust ${randomUUID().slice(0, 4)}`, bankName: "TD", accountLast4: "4821" } })).id;
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("a self-represented buyer: recorded as such, gets a FINTRAC record, and is owed the SRP disclosures", async () => {
    const d = await deal("LISTING", [{ role: "SELLER", fullName: "Ann Lee" }, { role: "BUYER", fullName: "Sam Solo" }]);
    const buyer = d.deal.parties?.find?.((p: { role: string }) => p.role === "BUYER")
      ?? await prisma.transactionParty.findFirstOrThrow({ where: { transactionId: d.deal.id, role: "BUYER" } });
    const first = (await as(u.agent, "GET", `/api/deals/${d.deal.id}/obligations`)).json();
    // No co-operating brokerage on the deal: we don't know whether the buyer is represented
    assert.ok(first.tresa.some((f: { rule: string; partyId: string }) => f.rule === "REPRESENTATION_UNKNOWN" && f.partyId === buyer.id));

    const set = await as(u.agent, "POST", `/api/deals/${d.deal.id}/parties/${buyer.id}/representation`, { representation: "SELF_REPRESENTED" });
    assert.equal(set.statusCode, 200, set.body);
    const after = set.json();
    assert.ok(after.tresa.some((f: { rule: string }) => f.rule === "SELF_REPRESENTED_PARTY"));
    assert.ok(after.fintrac.some((f: { rule: string; partyId: string }) => f.rule === "IDENTITY_VERIFICATION" && f.partyId === buyer.id));
    assert.equal(await prisma.documentSlot.count({ where: { transactionId: d.deal.id, partyId: buyer.id } }), 1); // FINTRAC record slot added

    for (const kind of ["INFORMATION_GUIDE", "SELF_REPRESENTED_PARTY_FORM"]) {
      const res = await as(u.agent, "POST", `/api/deals/${d.deal.id}/disclosures`, {
        kind, partyId: buyer.id, deliveredAt: "2026-10-09T15:00:00-04:00", explainedAt: "2026-10-09T15:20:00-04:00", method: "In person",
        acknowledgedAt: "2026-10-09T15:25:00-04:00", ...(kind === "SELF_REPRESENTED_PARTY_FORM" ? { formVersion: "BROKERAGE_REPRESENTATION" } : {}),
      });
      assert.equal(res.statusCode, 201, res.body);
    }
    const done = (await as(u.agent, "GET", `/api/deals/${d.deal.id}/obligations`)).json();
    assert.ok(!done.tresa.some((f: { partyId: string }) => f.partyId === buyer.id));
    // The SRP form has to say which version
    const bad = await as(u.agent, "POST", `/api/deals/${d.deal.id}/disclosures`, {
      kind: "SELF_REPRESENTED_PARTY_FORM", partyId: buyer.id, deliveredAt: "2026-10-09T15:00:00-04:00", method: "In person" });
    assert.equal(bad.json().error.code, "DISCLOSURE_INCOMPLETE");
  });

  test("double-ended: multiple representation consent; offer content only under the seller's written direction", async () => {
    const d = await deal("DUAL", [{ role: "SELLER", fullName: "Ann Lee" }, { role: "BUYER", fullName: "Bo Kim" }]);
    const ob = (await as(u.agent, "GET", `/api/deals/${d.deal.id}/obligations`)).json();
    assert.equal(ob.tresa.filter((f: { rule: string }) => f.rule === "MULTIPLE_REPRESENTATION").length, 2);

    await as(u.agent, "POST", `/api/deals/${d.deal.id}/offers`, { receivedAt: "2026-10-09T19:00:00-04:00", written: true, offerorBrokerage: "This brokerage" });
    const offer = (await prisma.offer.findFirstOrThrow({ where: { listingDealId: d.deal.id } })).id;
    const share = (directionId?: string) => as(u.agent, "POST", `/api/deals/${d.deal.id}/disclosures`, {
      kind: "COMPETING_OFFERS_CONTENT", offerId: offer, deliveredAt: "2026-10-09T20:00:00-04:00", method: "Email", content: "Price and closing date",
      ...(directionId ? { directionId } : {}) });
    assert.equal((await share()).statusCode, 422); // no direction given
    const none = (await as(u.agent, "POST", `/api/deals/${d.deal.id}/offer-directions`, { givenAt: "2026-10-08T10:00:00-04:00", shareContent: false })).json();
    assert.match((await share(none.id)).json().error.message, /seller's written direction/);
    const yes = (await as(u.agent, "POST", `/api/deals/${d.deal.id}/offer-directions`, {
      givenAt: "2026-10-09T18:00:00-04:00", shareContent: true, scope: "Price and closing date only" })).json();
    assert.equal((await share(yes.id)).statusCode, 201);
  });

  // ── Same brokerage on both sides (O. Reg. 567/05 s.22 to s.22.0.3) ─────────────────────────────────────
  /** A $1,000,000 sale, 2% per side, Agent A for the seller and Agent B for the buyer */
  async function twoAgentDeal() {
    const res = await as(u.agent, "POST", "/api/deals", {
      side: "DUAL", streetAddress: "1 Escarpment Cres", city: "Hamilton", salePrice: "1000000", offerDate: "2026-10-20", closeDate: "2026-12-15",
      depositAmount: "50000", trustDepositHolder: "OUR_BROKERAGE", listingSideGci: "20000", buyerSideGci: "20000",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80, side: "LISTING" }, { userId: u.agent2, role: "CO_AGENT", splitPct: 80, side: "BUYER" }],
      parties: [{ role: "SELLER", fullName: "Ana Seller" }, { role: "BUYER", fullName: "Ben Buyer" }],
    });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().deal.id as string;
    const parties = await prisma.transactionParty.findMany({ where: { transactionId: id } });
    return { id, seller: parties.find((p) => p.role === "SELLER")!.id, buyer: parties.find((p) => p.role === "BUYER")!.id };
  }
  const agreement = (dealId: string, partyId: string, type: "BROKERAGE" | "DESIGNATED", reps: string[] = []) =>
    as(u.agent, "POST", `/api/deals/${dealId}/representation-agreements`, {
      partyId, type, ...(type === "DESIGNATED" ? { designatedRepresentativeIds: reps } : {}), signedAt: "2026-09-01T10:00:00-04:00",
      effectiveFrom: "2026-09-01", expiresOn: "2027-03-01", remunerationTerms: "2% of the sale price plus HST", services: "Full service", terminationTerms: "On written notice" });
  const obligations = async (dealId: string) => (await as(u.broker, "GET", `/api/deals/${dealId}/obligations`)).json();
  const rules = (o: { tresa: { rule: string }[] }) => o.tresa.map((f) => f.rule);

  test("same brokerage: the deal records each side's commission and each agent's side; the deal's commission is their total", async () => {
    const d = await twoAgentDeal();
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: d.id }, include: { agents: true } });
    assert.deepEqual([row.totalGci.toFixed(2), row.listingSideGci!.toFixed(2), row.buyerSideGci!.toFixed(2)], ["40000.00", "20000.00", "20000.00"]);
    assert.deepEqual(row.agents.map((a) => [a.side, a.gciSharePct.toFixed(2)]).sort(), [["BUYER", "100.00"], ["LISTING", "100.00"]]);
    const bad = await as(u.agent, "POST", "/api/deals", {
      side: "DUAL", streetAddress: "2 Escarpment Cres", city: "Hamilton", salePrice: "1000000", offerDate: "2026-10-20", closeDate: "2026-12-15",
      depositAmount: "50000", trustDepositHolder: "OUR_BROKERAGE", totalGci: "40000",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80 }], parties: [{ role: "SELLER", fullName: "Ana Seller" }, { role: "BUYER", fullName: "Ben Buyer" }],
    });
    assert.equal(bad.statusCode, 400);
    const fields = bad.json().error.details.issues.map((i: { field: string }) => i.field);
    for (const f of ["listingSideGci", "buyerSideGci", "agents[0].side"]) assert.ok(fields.includes(f), f);
    // The trade record carries both sides, and a freshly prepared one matches the deal
    assert.equal((await as(u.agent, "POST", `/api/deals/${d.id}/trade-record`)).statusCode, 201);
    const sheet = async () => (await as(u.agent, "GET", `/api/deals/${d.id}/trade-record`)).json();
    assert.deepEqual((await sheet()).differsFromDeal, []);
    // A side's commission is amended under its own agreement; the deal's commission follows
    const amend = (field: string, newValue: string) => as(u.broker, "POST", `/api/deals/${d.id}/amendments`, { field, newValue, reference: "Amendment to the listing agreement" });
    assert.equal((await amend("TOTAL_GCI", "45000")).json().error.code, "AMEND_A_SIDE");
    assert.equal((await amend("LISTING_SIDE_GCI", "25000")).statusCode, 201);
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: d.id } });
    assert.deepEqual([after.listingSideGci!.toFixed(2), after.buyerSideGci!.toFixed(2), after.totalGci.toFixed(2)], ["25000.00", "20000.00", "45000.00"]);
    assert.match((await sheet()).differsFromDeal.join(), /listing side \$25,000\.00/);
  });

  test("separate designated representatives on opposite sides: not multiple representation, and the deal can go firm", async () => {
    const d = await twoAgentDeal();
    assert.equal((await obligations(d.id)).representation.mode, "UNDETERMINED"); // until the agreements are recorded
    await agreement(d.id, d.seller, "DESIGNATED", [u.agent]);
    await agreement(d.id, d.buyer, "DESIGNATED", [u.agent2]);
    const o = await obligations(d.id);
    assert.equal(o.representation.mode, "SEPARATE_DESIGNATED");
    assert.ok(!rules(o).includes("MULTIPLE_REPRESENTATION"));
    assert.ok(!rules(o).includes("DESIGNATED_REPRESENTATIVES"), "each agent is checked against their own client's agreement");
    const firm = await as(u.agent, "POST", `/api/deals/${d.id}/firm`);
    assert.equal(firm.statusCode, 200, firm.body);
    // Each agent sees only their own client's identification record; staff see both
    const names = async (user: string) => ((await as(user, "GET", `/api/deals/${d.id}/documents`)).json().slots as { party: { fullName: string } | null }[])
      .map((x) => x.party?.fullName).filter(Boolean);
    assert.deepEqual(await names(u.agent), ["Ana Seller"]);
    assert.deepEqual(await names(u.agent2), ["Ben Buyer"]);
    assert.deepEqual((await names(u.broker)).sort(), ["Ana Seller", "Ben Buyer"]);
  });

  test("brokerage representation, the same designated representative, or mixed: multiple representation; no firm deal until each client consents", async () => {
    for (const [seller, buyer, mode] of [
      [["BROKERAGE"], ["BROKERAGE"], "BROKERAGE"],
      [["DESIGNATED", "a"], ["DESIGNATED", "a"], "DESIGNATED_SAME"],
      [["BROKERAGE"], ["DESIGNATED", "b"], "MIXED"],
    ] as const) {
      const d = await twoAgentDeal();
      const rep = (x: readonly string[]) => (x[1] === "a" ? [u.agent] : x[1] === "b" ? [u.agent2] : []);
      await agreement(d.id, d.seller, seller[0] as "BROKERAGE" | "DESIGNATED", rep(seller));
      await agreement(d.id, d.buyer, buyer[0] as "BROKERAGE" | "DESIGNATED", rep(buyer));
      const o = await obligations(d.id);
      assert.equal(o.representation.mode, mode);
      assert.equal(o.tresa.filter((f: { rule: string }) => f.rule === "MULTIPLE_REPRESENTATION").length, 2, mode);
      const firm = await as(u.agent, "POST", `/api/deals/${d.id}/firm`);
      assert.equal(firm.json().error?.code, "CONSENT_OUTSTANDING", mode);
    }
  });

  test("consent is recorded by a managing broker or compliance, never by the agent; with it, the deal can go firm", async () => {
    const d = await twoAgentDeal();
    await agreement(d.id, d.seller, "BROKERAGE");
    await agreement(d.id, d.buyer, "BROKERAGE");
    const record = (user: string, kind: string, partyId: string) => as(user, "POST", `/api/deals/${d.id}/disclosures`, {
      kind, partyId, deliveredAt: "2026-10-15T10:00:00-04:00", method: "Signed disclosure and consent, PDF on file", acknowledgedAt: "2026-10-15T10:30:00-04:00" });
    const byAgent = await record(u.agent, "MULTIPLE_REPRESENTATION_CONSENT", d.seller);
    assert.equal(byAgent.statusCode, 403, byAgent.body);
    for (const p of [d.seller, d.buyer]) {
      assert.equal((await record(u.agent, "MULTIPLE_REPRESENTATION_DISCLOSURE", p)).statusCode, 201); // the agent delivers the disclosure
      assert.equal((await record(u.compliance, "MULTIPLE_REPRESENTATION_CONSENT", p)).statusCode, 201); // compliance confirms the signed consent
    }
    assert.ok(!rules(await obligations(d.id)).includes("MULTIPLE_REPRESENTATION"));
    assert.equal((await as(u.agent, "POST", `/api/deals/${d.id}/firm`)).statusCode, 200);
  });

  test("other buyers are told when we act for seller and buyer (also on a same-brokerage deal); two of our buyers competing need consent", async () => {
    // Same-brokerage deal with separate designated representatives: another buyer's written offer still gets the s.22.0.3 disclosure
    const d = await twoAgentDeal();
    await agreement(d.id, d.seller, "DESIGNATED", [u.agent]);
    await agreement(d.id, d.buyer, "DESIGNATED", [u.agent2]);
    await as(u.agent, "POST", `/api/deals/${d.id}/offers`, { receivedAt: "2026-10-19T19:00:00-04:00", written: true, offerorBrokerage: "Other Realty" });
    assert.ok(rules(await obligations(d.id)).includes("SAME_BROKERAGE_REPRESENTATION"));

    // A listing with offers from two buyers this brokerage represents, and one from elsewhere
    const l = await deal("LISTING", [{ role: "SELLER", fullName: "Ann Lee" }, { role: "BUYER", fullName: "Bo Kim" }, { role: "COOP_BROKERAGE", fullName: "Other Realty" }]);
    for (const [at, ours] of [["2026-10-09T19:00:00-04:00", true], ["2026-10-09T19:30:00-04:00", true], ["2026-10-09T20:00:00-04:00", false]] as const) {
      const r = await as(u.agent, "POST", `/api/deals/${l.deal.id}/offers`, { receivedAt: at, written: true, offerorBrokerage: ours ? "This brokerage" : "Other Realty", fromOurBrokerage: ours });
      assert.equal(r.statusCode, 201, r.body);
    }
    const offers = await prisma.offer.findMany({ where: { listingDealId: l.deal.id }, orderBy: { receivedAt: "asc" } });
    const o = await obligations(l.deal.id);
    assert.equal(o.tresa.filter((f: { rule: string }) => f.rule === "COMPETING_BUYER_CLIENTS").length, 2);
    assert.ok(o.tresa.some((f: { rule: string; offerId: string }) => f.rule === "SAME_BROKERAGE_REPRESENTATION" && f.offerId === offers[2]!.id));
    const accept = await as(u.agent, "POST", `/api/offers/${offers[0]!.id}/events`, { status: "ACCEPTED" });
    assert.equal(accept.json().error.code, "OFFER_DISCLOSURES_OUTSTANDING");
    const consent = (user: string, offerId: string) => as(user, "POST", `/api/deals/${l.deal.id}/disclosures`, {
      kind: "COMPETING_BUYERS_CONSENT", offerId, deliveredAt: "2026-10-09T21:00:00-04:00", method: "Signed consent, PDF on file",
      acknowledgedAt: "2026-10-09T21:10:00-04:00", content: "Buyer consented in writing to multiple representation" });
    assert.equal((await consent(u.agent, offers[0]!.id)).statusCode, 403);
    for (const off of offers.slice(0, 2)) assert.equal((await consent(u.broker, off.id)).statusCode, 201);
    assert.ok(!rules(await obligations(l.deal.id)).includes("COMPETING_BUYER_CLIENTS"));
  });

  test("FINTRAC: cash over $10,000 within 24 hours opens a report task due in 15 days; receipt of funds details are encrypted", async () => {
    // The 24-hour rule is per person, across deals: a fresh name keeps reruns apart
    const payer = `Cash Buyer ${randomUUID().slice(0, 6)}`;
    const d = await deal("LISTING", [{ role: "SELLER", fullName: "Ann Lee" }, { role: "BUYER", fullName: payer },
      { role: "COOP_BROKERAGE", fullName: "Other Realty" }]);
    await prisma.transaction.update({ where: { id: d.deal.id }, data: { status: "FIRM" } });
    const deposit = async (amount: string, date: string) => {
      const res = await as(u.broker, "POST", "/api/trust/deposits", {
        dealId: d.deal.id, trustAccountId: account, amount, method: "CASH", dateReceived: date, dateDeposited: date,
        payorName: payer, bankReference: `CASH-${randomUUID().slice(0, 4)}` });
      assert.equal(res.statusCode, 201, res.body);
      return res.json();
    };
    const one = await deposit("6000.00", "2026-10-12");
    assert.ok(!one.warnings.includes("FINTRAC_LARGE_TRANSACTION_REPORT_OPENED"));
    const two = await deposit("5000.00", "2026-10-13");
    assert.ok(two.warnings.includes("FINTRAC_LARGE_TRANSACTION_REPORT_OPENED"));
    const report = await prisma.fintracReport.findFirstOrThrow({ where: { transactionId: d.deal.id } });
    assert.equal(report.kind, "LARGE_CASH");
    assert.equal(report.trustEntryIds.length, 2);
    assert.equal(report.dueAt.toISOString(), "2026-10-29T03:59:00.000Z"); // Oct 28, 23:59 Toronto
    // Prepared, not submitted: nothing is sent to FINTRAC; the report stays open until a person records the filing
    assert.equal(await prisma.fintracReportEvent.count({ where: { reportId: report.id } }), 0);
    const ob = (await as(u.agent, "GET", `/api/deals/${d.deal.id}/obligations`)).json();
    assert.equal(ob.fintrac.filter((f: { rule: string }) => f.rule === "RECEIPT_OF_FUNDS").length, 2);
    assert.ok(ob.fintrac.some((f: { rule: string; severity: string }) => f.rule === "REPORT_LARGE_CASH" && f.severity === "BLOCKING"));

    const rof = await as(u.agent, "POST", `/api/trust/entries/${one.entry.id}/receipt-of-funds`, {
      payerType: "PERSON", payerName: payer, cashAmount: "6000.00",
      payerDetails: { address: "77 Hidden Rd, Hamilton", dateOfBirth: "1981-05-05", occupation: "Contractor" } });
    assert.equal(rof.statusCode, 201, rof.body);
    const stored = await prisma.receiptOfFundsRecord.findUniqueOrThrow({ where: { trustEntryId: one.entry.id } });
    assert.ok(!stored.payerDetailsEnc!.includes("Hidden Rd") && stored.payerDetailsEnc!.startsWith("v1."));
    assert.equal((await as(u.agent, "POST", `/api/trust/entries/${one.entry.id}/receipt-of-funds`, {
      payerType: "FINANCIAL_ENTITY", payerName: "TD Bank" })).statusCode, 400); // exemption reason required

    // Only compliance staff record the filing, with FINTRAC's reference
    assert.equal((await as(u.agent, "POST", `/api/fintrac/reports/${report.id}/events`, { status: "FILED", reference: "X", note: "x" })).statusCode, 403);
    assert.equal((await as(u.compliance, "POST", `/api/fintrac/reports/${report.id}/events`, { status: "FILED", note: "Filed" })).statusCode, 400);
    const filed = await as(u.compliance, "POST", `/api/fintrac/reports/${report.id}/events`, { status: "FILED", reference: "LCTR-ACK-0099", note: "Filed in FWR" });
    assert.equal(filed.statusCode, 200, filed.body);
    assert.ok(!(await as(u.agent, "GET", `/api/deals/${d.deal.id}/obligations`)).json().fintrac.some((f: { rule: string }) => f.rule === "REPORT_LARGE_CASH"));
  });

  test("FINTRAC: suspicion reports are opened by compliance, due immediately; PEP determinations must be consistent", async () => {
    assert.equal((await as(u.agent, "POST", "/api/fintrac/reports", { kind: "SUSPICIOUS_TRANSACTION", summary: "x" })).statusCode, 403);
    const opened = await as(u.compliance, "POST", "/api/fintrac/reports", { kind: "SUSPICIOUS_TRANSACTION", summary: "Buyer insisted on structuring cash deposits" });
    assert.equal(opened.statusCode, 201, opened.body);
    assert.ok(opened.json().reports.some((r: { kind: string; status: string }) => r.kind === "SUSPICIOUS_TRANSACTION" && r.status === "OPEN"));

    const d = await deal("LISTING", [{ role: "SELLER", fullName: "Ann Lee" }, { role: "BUYER", fullName: "Bo Kim" }, { role: "COOP_BROKERAGE", fullName: "Other Realty" }]);
    const seller = await prisma.transactionParty.findFirstOrThrow({ where: { transactionId: d.deal.id, role: "SELLER" } });
    const pep = (body: object) => as(u.agent, "POST", `/api/parties/${seller.id}/fintrac-determinations`, { kind: "PEP_HIO", details: "Asked directly", ...body });
    assert.equal((await pep({ result: "FOREIGN_PEP", riskRating: "LOW" })).json().error.code, "DETERMINATION_INVALID");
    const high = await pep({ result: "FOREIGN_PEP", riskRating: "HIGH" });
    assert.equal(high.statusCode, 201, high.body);
    assert.ok(high.json().fintrac.some((f: { rule: string }) => f.rule === "ENHANCED_MEASURES"));
  });

  test("compliance program: officer, policies, risk assessment and review are tracked; agents can't change it", async () => {
    assert.equal((await as(u.agent, "GET", "/api/fintrac/program")).statusCode, 403);
    const rec = (body: object) => as(u.compliance, "POST", "/api/fintrac/program", body);
    assert.equal((await rec({ kind: "COMPLIANCE_OFFICER", effectiveDate: "2026-01-05", title: "Appointment", details: "x" })).statusCode, 400); // name the person
    await rec({ kind: "COMPLIANCE_OFFICER", effectiveDate: "2026-01-05", subjectUserId: u.broker, title: "Appointment", details: "Board resolution" });
    await rec({ kind: "POLICIES_APPROVED", effectiveDate: "2026-01-10", title: "AML policies v3", details: "Approved by the broker of record" });
    await rec({ kind: "RISK_ASSESSMENT", effectiveDate: "2026-01-15", title: "2026 risk assessment", details: "Geography, clients, products" });
    const status = (await rec({ kind: "EFFECTIVENESS_REVIEW", effectiveDate: "2025-06-30", title: "Two-year review", details: "External reviewer" })).json();
    const rules = status.findings.map((f: { rule: string }) => f.rule);
    for (const r of ["COMPLIANCE_OFFICER", "POLICIES", "RISK_ASSESSMENT", "EFFECTIVENESS_REVIEW"]) assert.ok(!rules.includes(r), r);
  });
});
