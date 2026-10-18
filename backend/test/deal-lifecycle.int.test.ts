/**
 * Transaction lifecycle and the trade record sheet (migration 015), through the API.
 * Needs DATABASE_URL; skipped otherwise.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { designateBroker, JPEG, multipart, TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-10-18";

describe("deal lifecycle and trade record sheet", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { agent: "", other: "", broker: "", admin: "", compliance: "" };

  const as = (user: string, method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user }, ...(body ? { payload: body } : {}) });

  async function listing() {
    const res = await as(u.agent, "POST", "/api/deals", {
      side: "LISTING", streetAddress: "41 Main St E", city: "Grimsby", salePrice: "849000", offerDate: "2026-10-10",
      closeDate: "2026-12-15", depositAmount: "40000", trustDepositHolder: "COOP_BROKERAGE", totalGci: "21225",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80 }],
      parties: [
        { role: "SELLER", fullName: "Ann Lee" }, { role: "BUYER", fullName: "Bo Kim" },
        { role: "SELLER_LAWYER", fullName: "Patel Law LLP", email: "deals@patel.test" },
        { role: "COOP_BROKERAGE", fullName: "Harbourfront Realty Inc." },
      ],
    });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().deal.id as string;
    await prisma.transaction.update({ where: { id }, data: { coopCommission: "16980" } });
    return id;
  }

  /** What TRESA and FINTRAC need on file for the seller (our client) on these listings. */
  async function sellerCompliance(deal: string) {
    const parties = await prisma.transactionParty.findMany({ where: { transactionId: deal } });
    const seller = parties.find((p) => p.role === "SELLER")!;
    const ok = async (res: Promise<{ statusCode: number; body: string }>) => { const r = await res; assert.ok(r.statusCode < 300, r.body); };
    await ok(as(u.agent, "POST", `/api/deals/${deal}/disclosures`, {
      kind: "INFORMATION_GUIDE", partyId: seller.id, deliveredAt: "2026-09-01T10:00:00-04:00", explainedAt: "2026-09-01T10:30:00-04:00",
      method: "RECO guide link by email, explained at listing appointment" }));
    await ok(as(u.agent, "POST", `/api/deals/${deal}/representation-agreements`, {
      partyId: seller.id, type: "BROKERAGE", signedAt: "2026-09-01T11:00:00-04:00", effectiveFrom: "2026-09-01", expiresOn: "2027-02-28",
      remunerationTerms: "2.5% of the sale price plus HST; 2% co-operating", services: "Listing, marketing, offer presentation and negotiation",
      terminationTerms: "Either party on 30 days' written notice" }));
    for (const kind of ["PEP_HIO", "BUSINESS_RELATIONSHIP"]) {
      await ok(as(u.agent, "POST", `/api/parties/${seller.id}/fintrac-determinations`, {
        kind, result: kind === "PEP_HIO" ? "NONE" : "Sale of principal residence", riskRating: "LOW", details: "Asked and recorded at the listing appointment" }));
    }
    const slot = await prisma.documentSlot.findFirstOrThrow({ where: { transactionId: deal, partyId: seller.id } });
    const { payload, contentType } = multipart({ name: "id.jpg", type: "image/jpeg", bytes: JPEG }, {
      verificationDate: "2026-10-10", fullLegalName: "Ann Lee", dateOfBirth: "1970-01-01", address: "41 Main St E, Grimsby",
      occupation: "Engineer", idType: "PASSPORT", idNumber: "AB123456", issuingJurisdiction: "Canada", expiryDate: "2030-01-01",
      thirdPartyDetermination: false });
    const up = await app.inject({ method: "POST", url: `/api/documents/slots/${slot.id}/files`, payload, headers: { "x-user-id": u.agent, "content-type": contentType } });
    assert.equal(up.statusCode, 201, up.body);
    await ok(as(u.compliance, "POST", `/api/documents/slots/${slot.id}/review`, { decision: "APPROVED", fileId: up.json().fileId }));
  }

  before(async () => {
    const make = async (role: UserRole) => (await prisma.user.create({
      data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: "Life", lastName: role, role, phone: "905-555-0199" },
    })).id;
    u.agent = await make("AGENT");
    u.other = await make("AGENT");
    u.broker = await make("MANAGING_BROKER");
    u.admin = await make("ADMIN");
    u.compliance = await make("COMPLIANCE_ADMIN");
    await designateBroker(app, prisma, u.broker);
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("conditions: the deal goes firm only once each is fulfilled or waived, with the document", async () => {
    const deal = await listing();
    assert.equal((await as(u.other, "POST", `/api/deals/${deal}/conditions`, {
      kind: "FINANCING", description: "x", forBenefitOf: "BUYER", dueAt: "2026-10-20T23:59:00-04:00" })).statusCode, 403);
    const add = (kind: string, description: string, dueAt: string) =>
      as(u.agent, "POST", `/api/deals/${deal}/conditions`, { kind, description, forBenefitOf: "BUYER", dueAt });
    await add("FINANCING", "Buyer obtaining a first mortgage", "2026-10-20T23:59:00-04:00");
    const view = (await add("INSPECTION", "Home inspection satisfactory to the buyer", "2026-10-17T18:00:00-04:00")).json();
    assert.equal(view.conditions.length, 2);
    assert.ok(view.conditions.find((c: { kind: string }) => c.kind === "INSPECTION").overdue);

    const early = await as(u.agent, "POST", `/api/deals/${deal}/firm`);
    assert.equal(early.statusCode, 409);
    assert.match(early.json().error.message, /2 condition\(s\) are still open/);
    assert.equal((await as(u.agent, "POST", `/api/deals/${deal}/close`, {})).statusCode, 409); // conditional can't close

    const [financing, inspection] = view.conditions.sort((a: { kind: string }, b: { kind: string }) => a.kind.localeCompare(b.kind));
    const outcome = (id: string, body: object) => as(u.agent, "POST", `/api/conditions/${id}/outcome`, body);
    assert.equal((await outcome(inspection.id, { outcome: "EXTENDED", reference: "Form 120 amendment" })).statusCode, 400); // needs the new deadline
    await outcome(inspection.id, { outcome: "EXTENDED", newDueAt: "2026-10-21T18:00:00-04:00", reference: "Form 120 amendment, signed Oct 17" });
    await outcome(inspection.id, { outcome: "FULFILLED", reference: "Form 124 notice of fulfillment" });
    assert.equal((await outcome(inspection.id, { outcome: "WAIVED", reference: "x" })).statusCode, 409); // already fulfilled
    await outcome(financing.id, { outcome: "WAIVED", reference: "Form 123 waiver, signed Oct 19" });

    const firm = await as(u.agent, "POST", `/api/deals/${deal}/firm`);
    assert.equal(firm.statusCode, 200, firm.body);
    assert.equal(firm.json().status, "FIRM");
    assert.deepEqual(firm.json().conditions.map((c: { state: string }) => c.state).sort(), ["FULFILLED", "WAIVED"]);
    assert.equal((await add("OTHER", "Late condition", "2026-11-01T00:00:00-04:00")).statusCode, 409);
  });

  test("amendments change the deal and keep the old value; a terminated deal stays terminated", async () => {
    const deal = await listing();
    const amended = await as(u.agent, "POST", `/api/deals/${deal}/amendments`, {
      field: "CLOSE_DATE", newValue: "2027-01-08", reference: "Form 120, signed by both parties Oct 18",
    });
    assert.equal(amended.statusCode, 201, amended.body);
    assert.deepEqual(amended.json().amendments[0], {
      field: "CLOSE_DATE", oldValue: "2026-12-15", newValue: "2027-01-08", effectiveDate: TODAY, reference: "Form 120, signed by both parties Oct 18",
    });
    assert.equal((await prisma.transaction.findUniqueOrThrow({ where: { id: deal } })).closeDate.toISOString().slice(0, 10), "2027-01-08");
    assert.equal((await as(u.agent, "POST", `/api/deals/${deal}/amendments`, { field: "CLOSE_DATE", newValue: "2027-01-08", reference: "x" })).statusCode, 422);

    const ended = await as(u.agent, "POST", `/api/deals/${deal}/terminate`, {
      reason: "MUTUAL_RELEASE", reference: "Form 122 mutual release, signed Oct 18", note: "Buyer's financing fell through",
    });
    assert.equal(ended.statusCode, 200, ended.body);
    assert.deepEqual([ended.json().status, ended.json().termination.reason], ["COLLAPSED", "MUTUAL_RELEASE"]);
    assert.equal((await as(u.agent, "POST", `/api/deals/${deal}/firm`)).statusCode, 409);
    assert.equal((await as(u.agent, "POST", `/api/deals/${deal}/amendments`, { field: "SALE_PRICE", newValue: "1.00", reference: "x" })).statusCode, 409);
  });

  test("offers register: one accepted offer per listing; unaccepted offers are kept a year", async () => {
    const deal = await listing();
    const record = (brokerage: string | null, at: string) => as(u.agent, "POST", `/api/deals/${deal}/offers`, {
      receivedAt: at, written: true, ...(brokerage ? { offerorBrokerage: brokerage } : { offerorSelfRepresented: true }), price: "845000",
    });
    assert.equal((await as(u.agent, "POST", `/api/deals/${deal}/offers`, { receivedAt: "2026-10-09T19:00:00-04:00", written: true })).statusCode, 400);
    await record("Harbourfront Realty Inc.", "2026-10-09T19:00:00-04:00");
    const offers = (await record(null, "2026-10-09T19:30:00-04:00")).json().offers;
    assert.equal(offers.length, 2);
    const [a, b] = offers;
    // Two written offers: each offeror must be told the number before any is accepted (s.22.7)
    const blocked = await as(u.agent, "POST", `/api/offers/${a.id}/events`, { status: "ACCEPTED" });
    assert.equal(blocked.json().error.code, "OFFER_DISCLOSURES_OUTSTANDING");
    assert.equal(blocked.json().error.details.outstanding.length, 2);
    for (const o of offers) {
      await as(u.agent, "POST", `/api/deals/${deal}/disclosures`, {
        kind: "COMPETING_OFFERS_NUMBER", offerId: o.id, deliveredAt: "2026-10-09T20:00:00-04:00", method: "Email to the buyer's agent", numberDisclosed: 2 });
    }
    assert.equal((await as(u.agent, "POST", `/api/offers/${a.id}/events`, { status: "ACCEPTED" })).statusCode, 201);
    assert.match((await as(u.agent, "POST", `/api/offers/${b.id}/events`, { status: "ACCEPTED" })).json().error.message, /already accepted/);
    const after = (await as(u.agent, "POST", `/api/offers/${b.id}/events`, { status: "REJECTED", note: "Seller accepted another offer" })).json().offers;
    assert.deepEqual(after.map((o: { status: string; keepUntil: string }) => [o.status, o.keepUntil]), [["ACCEPTED", "2032-10-09"], ["REJECTED", "2027-10-09"]]);
  });

  test("trade record sheet: generated from the deal, corrected with initials, signed by the agent once firm, then the broker of record", async () => {
    const deal = await listing();
    assert.equal((await as(u.other, "POST", `/api/deals/${deal}/trade-record`)).statusCode, 403);
    const prepared = await as(u.agent, "POST", `/api/deals/${deal}/trade-record`);
    assert.equal(prepared.statusCode, 201, prepared.body);
    const sheet = prepared.json();
    const item = (s: typeof sheet, k: string) => s.items.find((i: { item: string }) => i.item === k).value;
    assert.equal(item(sheet, "consideration"), "849000.00");
    assert.deepEqual(item(sheet, "otherBrokerageRemuneration"), { amount: "16980.00", brokerage: "Harbourfront Realty Inc." });
    assert.deepEqual(item(sheet, "brokerageRemuneration"), { amount: "21225.00", payer: "Ann Lee", taxExtra: true });
    assert.deepEqual(sheet.missing, [{ item: "registrants", reason: "name and contact details of the registrant at Harbourfront Realty Inc." }]);
    assert.equal((await as(u.agent, "POST", `/api/deals/${deal}/trade-record`)).statusCode, 409);

    // Conditional: can't sign yet
    assert.match((await as(u.agent, "POST", `/api/deals/${deal}/trade-record/sign`)).json().error.message, /no conditions remain outstanding/);
    await as(u.agent, "POST", `/api/deals/${deal}/firm`);
    assert.match((await as(u.agent, "POST", `/api/deals/${deal}/trade-record/sign`)).json().error.message, /complete every item/);

    const registrants = [...item(sheet, "registrants").slice(0, 1),
      { side: "BUYER", brokerage: "Harbourfront Realty Inc.", name: "Carla Diaz", email: "carla@harbourfront.test", phone: null }];
    const corrected = await as(u.agent, "POST", `/api/deals/${deal}/trade-record/corrections`, {
      item: "registrants", value: registrants, reason: "Added the buyer's agent from the co-op confirmation",
    });
    assert.equal(corrected.statusCode, 201, corrected.body);
    assert.deepEqual(corrected.json().missing, []);
    const history = corrected.json().items.find((i: { item: string }) => i.item === "registrants").history;
    assert.equal(history.length, 2);
    assert.equal(history[1].initials, "LA"); // Life AGENT; the original entry is still there
    assert.equal(history[0].value.length, 2);

    assert.equal((await as(u.other, "POST", `/api/deals/${deal}/trade-record/sign`)).statusCode, 403);
    assert.equal((await as(u.agent, "POST", `/api/deals/${deal}/trade-record/broker-sign`)).statusCode, 403); // agent isn't broker of record
    const signed = await as(u.agent, "POST", `/api/deals/${deal}/trade-record/sign`);
    assert.equal(signed.statusCode, 200, signed.body);
    assert.equal(signed.json().status, "SIGNED_BY_AGENT");
    // After the agent signs, only the broker of record corrects, during review
    assert.equal((await as(u.agent, "POST", `/api/deals/${deal}/trade-record/corrections`, { item: "additionalItems", value: "x", reason: "x" })).statusCode, 403);
    assert.equal((await as(u.broker, "POST", `/api/deals/${deal}/trade-record/corrections`, {
      item: "additionalItems", value: "Seller's lawyer confirmed by phone", reason: "Broker review note" })).statusCode, 201);

    // A later amendment shows up as a difference, without rewriting the record
    await as(u.agent, "POST", `/api/deals/${deal}/amendments`, { field: "SALE_PRICE", newValue: "845000", reference: "Form 120 price amendment" });
    // The broker of record's review includes the deal's TRESA and FINTRAC obligations
    const outstanding = await as(u.broker, "POST", `/api/deals/${deal}/trade-record/broker-sign`);
    assert.equal(outstanding.json().error.code, "COMPLIANCE_OUTSTANDING");
    assert.ok(outstanding.json().error.details.outstanding.some((o: { rule: string }) => o.rule === "INFORMATION_GUIDE"));
    await sellerCompliance(deal);
    const final = await as(u.broker, "POST", `/api/deals/${deal}/trade-record/broker-sign`);
    assert.equal(final.statusCode, 200, final.body);
    assert.equal(final.json().status, "SIGNED_BY_BROKER_OF_RECORD");
    assert.match(final.json().differsFromDeal[0], /3\. True consideration: the deal now shows "845000\.00"/);
    assert.equal(final.json().retainUntil.slice(0, 4), String(new Date().getUTCFullYear() + 6));
    const frozen = await as(u.broker, "POST", `/api/deals/${deal}/trade-record/corrections`, { item: "additionalItems", value: "y", reason: "y" });
    assert.equal(frozen.json().error.code, "APPEND_ONLY");
  });
});
