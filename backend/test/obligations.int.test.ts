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
import { designateBroker, multipart, TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-10-18";
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

describe("compliance obligations", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { agent: "", agent2: "", broker: "", compliance: "", admin: "" };
  let account = "";

  const as = (user: string, method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user, "idempotency-key": randomUUID() }, ...(body ? { payload: body } : {}) });

  async function deal(side: "LISTING" | "DUAL", parties: object[], extra: object = {}) {
    const res = await as(u.agent, "POST", "/api/deals", {
      side, streetAddress: "5 Lake Ave", city: "Stoney Creek", salePrice: "690000", offerDate: "2026-10-10", closeDate: "2026-12-10",
      depositAmount: "20000", trustDepositHolder: "OUR_BROKERAGE", totalGci: "17250",
      ...(side === "DUAL" ? { listingSideGci: "8625", buyerSideGci: "8625", buyerSideSellerPays: "8625",
        remunerationSource: "Listing agreement: the seller pays both sides" } : {}),
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
    u.admin = await make("ADMIN");
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

  test("double-ended: representation not verified until both agreements are recorded; offer content only under the seller's written direction", async () => {
    const d = await deal("DUAL", [{ role: "SELLER", fullName: "Ann Lee" }, { role: "BUYER", fullName: "Bo Kim" }]);
    const ob = (await as(u.agent, "GET", `/api/deals/${d.deal.id}/obligations`)).json();
    // Not called multiple representation without the facts, but nothing goes firm until it's verified
    assert.equal(ob.representation.mode, "UNDETERMINED");
    assert.match(ob.representation.explanation, /^Representation not verified/);
    assert.equal(ob.tresa.filter((f: { rule: string }) => f.rule === "REPRESENTATION_UNVERIFIED").length, 1);
    assert.equal(ob.tresa.filter((f: { rule: string }) => f.rule === "MULTIPLE_REPRESENTATION").length, 0);
    const firm = (await as(u.agent, "POST", `/api/deals/${d.deal.id}/firm`)).json();
    assert.equal(firm.error.code, "CONSENT_OUTSTANDING");
    assert.match(firm.error.message, /representation isn't verified/);

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

  // ── Same brokerage on both sides (O. Reg. 567/05 s.22 to s.22.0.3; RECO Bulletins 2.2, 2.3, 3.2, 3.3) ──────────
  /** A $1,000,000 sale, 2% per side, Agent A for the seller and Agent B for the buyer; the seller pays both sides */
  async function twoAgentDeal(extra: object = {}) {
    const res = await as(u.agent, "POST", "/api/deals", {
      side: "DUAL", streetAddress: "1 Escarpment Cres", city: "Hamilton", salePrice: "1000000", offerDate: "2026-10-20", closeDate: "2026-12-15",
      depositAmount: "50000", trustDepositHolder: "OUR_BROKERAGE", listingSideGci: "20000", buyerSideGci: "20000",
      buyerSideSellerPays: "20000", remunerationSource: "Listing agreement s.3: the seller pays 2% to each side",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80, side: "LISTING" }, { userId: u.agent2, role: "CO_AGENT", splitPct: 80, side: "BUYER" }],
      parties: [{ role: "SELLER", fullName: "Ana Seller" }, { role: "BUYER", fullName: "Ben Buyer" }], ...extra,
    });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().deal.id as string;
    const parties = await prisma.transactionParty.findMany({ where: { transactionId: id } });
    return { id, seller: parties.find((p) => p.role === "SELLER")!.id, buyer: parties.find((p) => p.role === "BUYER")!.id };
  }
  const agreement = (dealId: string, partyId: string, type: "BROKERAGE" | "DESIGNATED", reps: string[] = [], by = u.agent) =>
    as(by, "POST", `/api/deals/${dealId}/representation-agreements`, {
      partyId, type, ...(type === "DESIGNATED" ? { designatedRepresentativeIds: reps } : {}), signedAt: "2026-09-01T10:00:00-04:00",
      effectiveFrom: "2026-09-01", expiresOn: "2027-03-01", remunerationTerms: "2% of the sale price plus HST", services: "Full service", terminationTerms: "On written notice" });
  /** Each client is told, in writing, both agreements' remuneration terms (RECO Bulletin 3.3) */
  const remunerationDisclosed = async (dealId: string, partyIds: string[], by = u.agent) => {
    for (const partyId of partyIds) {
      const r = await as(by, "POST", `/api/deals/${dealId}/disclosures`, { kind: "REMUNERATION_DISCLOSURE", partyId, deliveredAt: "2026-10-15T09:00:00-04:00",
        method: "Email with both agreements' remuneration clauses", content: "Seller's agreement: 2% to each side. Buyer's agreement: 2%, paid by the seller first." });
      assert.equal(r.statusCode, 201, r.body);
    }
  };
  /** The signed disclosure and consent, uploaded to the deal's consents slot; returns the file id */
  const uploadConsent = async (dealId: string, by = u.compliance) => {
    const slot = await prisma.documentSlot.findFirstOrThrow({ where: { transactionId: dealId, documentType: { code: "REPRESENTATION_CONSENTS" } } });
    const { payload, contentType } = multipart({ name: "signed-consents.pdf", type: "application/pdf", bytes: PDF });
    const up = await app.inject({ method: "POST", url: `/api/documents/slots/${slot.id}/files`, payload, headers: { "x-user-id": by, "content-type": contentType } });
    assert.equal(up.statusCode, 201, up.body);
    return up.json().fileId as string;
  };
  const obligations = async (dealId: string, by = u.broker) => (await as(by, "GET", `/api/deals/${dealId}/obligations`)).json();
  const rules = (o: { tresa: { rule: string }[] }) => o.tresa.map((f) => f.rule);

  test("same brokerage: each side's commission, who pays it (never assumed), and the trade record's items 8 and 10", async () => {
    const d = await twoAgentDeal();
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: d.id }, include: { agents: true } });
    assert.deepEqual([row.totalGci.toFixed(2), row.listingSideGci!.toFixed(2), row.buyerSideGci!.toFixed(2), row.buyerSideSellerPays!.toFixed(2)],
      ["40000.00", "20000.00", "20000.00", "20000.00"]);
    assert.deepEqual(row.agents.map((a) => [a.side, a.gciSharePct.toFixed(2)]).sort(), [["BUYER", "100.00"], ["LISTING", "100.00"]]);
    const bad = await as(u.agent, "POST", "/api/deals", {
      side: "DUAL", streetAddress: "2 Escarpment Cres", city: "Hamilton", salePrice: "1000000", offerDate: "2026-10-20", closeDate: "2026-12-15",
      depositAmount: "50000", trustDepositHolder: "OUR_BROKERAGE", totalGci: "40000",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80 }], parties: [{ role: "SELLER", fullName: "Ana Seller" }, { role: "BUYER", fullName: "Ben Buyer" }],
    });
    assert.equal(bad.statusCode, 400);
    const fields = bad.json().error.details.issues.map((i: { field: string }) => i.field);
    for (const f of ["listingSideGci", "buyerSideGci", "agents[0].side", "buyerSideSellerPays", "remunerationSource"]) assert.ok(fields.includes(f), f);
    // The trade record carries both sides, and a freshly prepared one matches the deal
    assert.equal((await as(u.agent, "POST", `/api/deals/${d.id}/trade-record`)).statusCode, 201);
    const sheet = async () => (await as(u.agent, "GET", `/api/deals/${d.id}/trade-record`)).json();
    const item = (s: { items: { item: string; value: unknown }[] }, k: string) => s.items.find((i) => i.item === k)!.value as Record<string, string | null>;
    assert.deepEqual((await sheet()).differsFromDeal, []);
    assert.deepEqual(item(await sheet(), "completionDate"), { scheduled: "2026-12-15", amendedDate: null });
    // A side's commission is amended under its own agreement; the deal's commission follows
    const amend = (field: string, newValue: string) => as(u.broker, "POST", `/api/deals/${d.id}/amendments`, { field, newValue, reference: "Amendment to the agreement" });
    assert.equal((await amend("TOTAL_GCI", "45000")).json().error.code, "AMEND_A_SIDE");
    assert.equal((await amend("LISTING_SIDE_GCI", "25000")).statusCode, 201);
    assert.equal((await amend("BUYER_SIDE_SELLER_PAYS", "25000")).json().error.code, "SELLER_PAYS_MORE_THAN_BUYER_SIDE");
    assert.equal((await amend("BUYER_SIDE_SELLER_PAYS", "15000")).statusCode, 201);
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: d.id } });
    assert.deepEqual([after.listingSideGci!.toFixed(2), after.buyerSideGci!.toFixed(2), after.totalGci.toFixed(2)], ["25000.00", "20000.00", "45000.00"]);
    const drift = (await sheet()).differsFromDeal.join();
    assert.match(drift, /listing side \$25,000\.00/);
    assert.match(drift, /payer Ana Seller, Ben Buyer/); // the buyer now pays $5,000 of the buyer side themselves
    assert.match(drift, /paid by seller \$40,000\.00 · paid by buyer \$5,000\.00/);
    // Item 10: the scheduled completion date and the amended one
    assert.equal((await amend("CLOSE_DATE", "2026-12-22")).statusCode, 201);
    assert.match((await sheet()).differsFromDeal.join(), /10\. Completion date.*scheduled 2026-12-15 · amended date 2026-12-22/);
  });

  test("separate designated representatives on opposite sides: not multiple representation; firm once each client has both agreements' remuneration terms", async () => {
    const d = await twoAgentDeal();
    assert.equal((await obligations(d.id)).representation.mode, "UNDETERMINED"); // until the agreements are recorded
    await agreement(d.id, d.seller, "DESIGNATED", [u.agent]);
    await agreement(d.id, d.buyer, "DESIGNATED", [u.agent2], u.agent2);
    const o = await obligations(d.id);
    assert.equal(o.representation.mode, "SEPARATE_DESIGNATED");
    assert.ok(!rules(o).some((r) => r.startsWith("MULTIPLE_REPRESENTATION")));
    assert.ok(!rules(o).includes("DESIGNATED_REPRESENTATIVES"), "each agent is checked against their own client's agreement");
    assert.equal(rules(o).filter((r) => r === "REMUNERATION_DISCLOSURE").length, 2);
    assert.equal(await prisma.documentSlot.count({ where: { transactionId: d.id, documentType: { code: "REPRESENTATION_CONSENTS" } } }), 0); // no consent needed
    const refused = (await as(u.agent, "POST", `/api/deals/${d.id}/firm`)).json();
    assert.match(refused.error.message, /written disclosure of both agreements' remuneration terms/);
    await remunerationDisclosed(d.id, [d.seller]);
    await remunerationDisclosed(d.id, [d.buyer], u.agent2);
    const firm = await as(u.agent, "POST", `/api/deals/${d.id}/firm`);
    assert.equal(firm.statusCode, 200, firm.body);
    // The trade record stays on the deal's next steps until both signatures are on it
    assert.ok((await as(u.agent, "GET", `/api/deals/${d.id}/lifecycle`)).json().nextSteps.includes("Trade record sheet: not prepared yet"));
    // Each agent sees only their own client's identification record; staff see both
    const names = async (user: string) => ((await as(user, "GET", `/api/deals/${d.id}/documents`)).json().slots as { party: { fullName: string } | null }[])
      .map((x) => x.party?.fullName).filter(Boolean);
    assert.deepEqual(await names(u.agent), ["Ana Seller"]);
    assert.deepEqual(await names(u.agent2), ["Ben Buyer"]);
    assert.deepEqual((await names(u.broker)).sort(), ["Ana Seller", "Ben Buyer"]);
  });

  test("confidentiality through the API: each designated representative only reaches their own client's records; the office admin can't open client files", async () => {
    const d = await twoAgentDeal();
    await agreement(d.id, d.seller, "DESIGNATED", [u.agent]);
    await agreement(d.id, d.buyer, "DESIGNATED", [u.agent2], u.agent2);
    // The seller's FINTRAC record, uploaded by the seller's agent
    const sellerSlot = await prisma.documentSlot.findFirstOrThrow({ where: { transactionId: d.id, partyId: d.seller } });
    const { payload, contentType } = multipart({ name: "id.pdf", type: "application/pdf", bytes: PDF }, {
      verificationDate: "2026-10-15", fullLegalName: "Ana Seller", dateOfBirth: "1975-05-05", address: "1 Escarpment Cres, Hamilton",
      occupation: "Engineer", idType: "PASSPORT", idNumber: "HB123456", issuingJurisdiction: "Canada", expiryDate: "2031-01-01", thirdPartyDetermination: false });
    const up = await app.inject({ method: "POST", url: `/api/documents/slots/${sellerSlot.id}/files`, payload, headers: { "x-user-id": u.agent, "content-type": contentType } });
    assert.equal(up.statusCode, 201, up.body);
    const file = up.json().fileId;
    for (const url of [`/api/documents/files/${file}`, `/api/documents/files/${file}/content`]) {
      assert.equal((await as(u.agent2, "GET", url)).statusCode, 403, `buyer's agent: ${url}`);
      assert.equal((await as(u.admin, "GET", url)).statusCode, 403, `office admin: ${url}`);
      assert.equal((await as(u.compliance, "GET", url)).statusCode, 200, `compliance: ${url}`);
    }
    assert.equal((await as(u.broker, "GET", `/api/documents/files/${file}`)).json().metadata.idNumber, "HB123456"); // the broker of record, for supervision
    // Offers on the listing: the seller's agent records them; the buyer's agent sees only their own buyer's offer
    const offer = (body: object, by = u.agent) => as(by, "POST", `/api/deals/${d.id}/offers`, { receivedAt: "2026-10-19T19:00:00-04:00", written: true, ...body });
    assert.equal((await offer({ offerorBrokerage: "This brokerage", fromOurBrokerage: true, buyerRepresentation: "DESIGNATED", buyerAgentIds: [u.agent2] })).statusCode, 201);
    assert.equal((await offer({ offerorBrokerage: "Other Realty", price: "1010000" })).statusCode, 201);
    assert.equal((await offer({ offerorBrokerage: "This brokerage" }, u.agent2)).statusCode, 403);
    const seen = (await as(u.agent2, "GET", `/api/deals/${d.id}/offers`)).json().offers;
    assert.deepEqual(seen.map((o: { offerorBrokerage: string }) => o.offerorBrokerage), ["This brokerage"]); // not the competing $1,010,000 offer
    assert.equal((await as(u.agent, "GET", `/api/deals/${d.id}/offers`)).json().offers.length, 2);
    const competing = (await prisma.offer.findFirstOrThrow({ where: { listingDealId: d.id, offerorBrokerage: "Other Realty" } })).id;
    assert.equal((await as(u.agent2, "POST", `/api/offers/${competing}/events`, { status: "REJECTED" })).statusCode, 403);
    assert.equal((await as(u.agent2, "POST", `/api/deals/${d.id}/offer-directions`, { givenAt: "2026-10-19T10:00:00-04:00", shareContent: false })).statusCode, 403);
    // The seller's records and findings stay with the seller's agent
    assert.equal((await as(u.agent2, "POST", `/api/deals/${d.id}/disclosures`, { kind: "INFORMATION_GUIDE", partyId: d.seller,
      deliveredAt: "2026-10-01T10:00:00-04:00", explainedAt: "2026-10-01T10:00:00-04:00", method: "In person" })).statusCode, 403);
    assert.equal((await as(u.agent2, "POST", `/api/parties/${d.seller}/fintrac-determinations`, { kind: "PEP_HIO", result: "Not a PEP", details: "Asked" })).statusCode, 403);
    const mine = await obligations(d.id, u.agent2);
    assert.ok([...mine.tresa, ...mine.fintrac].every((f: { partyId?: string; offerId?: string }) => f.partyId !== d.seller && f.offerId !== competing));
    assert.ok([...(await obligations(d.id)).fintrac].some((f: { partyId?: string }) => f.partyId === d.seller)); // the broker sees all
  });

  test("brokerage representation, the same designated representative (co-designated included), or mixed: multiple representation; no firm deal until each client consents", async () => {
    for (const [seller, buyer, mode] of [
      [["BROKERAGE"], ["BROKERAGE"], "BROKERAGE"],
      [["DESIGNATED", "a"], ["DESIGNATED", "a"], "DESIGNATED_SAME"],
      [["DESIGNATED", "ab"], ["DESIGNATED", "b"], "DESIGNATED_SAME"], // Agent B is co-designated on the seller's agreement
      [["BROKERAGE"], ["DESIGNATED", "b"], "MIXED"],
    ] as const) {
      const d = await twoAgentDeal();
      const rep = (x: readonly string[]) => [...(x[1]?.includes("a") ? [u.agent] : []), ...(x[1]?.includes("b") ? [u.agent2] : [])];
      await agreement(d.id, d.seller, seller[0] as "BROKERAGE" | "DESIGNATED", rep(seller));
      await agreement(d.id, d.buyer, buyer[0] as "BROKERAGE" | "DESIGNATED", rep(buyer), u.broker);
      await remunerationDisclosed(d.id, [d.seller, d.buyer], u.broker);
      const o = await obligations(d.id);
      assert.equal(o.representation.mode, mode);
      assert.equal(o.tresa.filter((f: { rule: string }) => f.rule === "MULTIPLE_REPRESENTATION").length, 2, mode);
      const firm = await as(u.agent, "POST", `/api/deals/${d.id}/firm`);
      assert.equal(firm.json().error?.code, "CONSENT_OUTSTANDING", mode);
      assert.match(firm.json().error.message, /multiple representation needs each client's written disclosure and consent/);
      // A place for the signed consents appears as soon as consent is needed
      assert.equal(await prisma.documentSlot.count({ where: { transactionId: d.id, documentType: { code: "REPRESENTATION_CONSENTS" } } }), 1, mode);
    }
  });

  test("consent: the disclosure explains duties, services, remuneration and independent advice; compliance records each signed consent with when it arose", async () => {
    const d = await twoAgentDeal();
    await agreement(d.id, d.seller, "BROKERAGE");
    await agreement(d.id, d.buyer, "BROKERAGE", [], u.broker);
    await remunerationDisclosed(d.id, [d.seller, d.buyer], u.broker);
    const disclose = (partyId: string, confirms: string[]) => as(u.broker, "POST", `/api/deals/${d.id}/disclosures`, {
      kind: "MULTIPLE_REPRESENTATION_DISCLOSURE", partyId, deliveredAt: "2026-09-01T09:00:00-04:00", method: "Written disclosure, signed",
      acknowledgedAt: "2026-09-01T09:10:00-04:00", confirms });
    assert.equal((await disclose(d.seller, ["DUTIES", "SERVICES"])).json().error.code, "DISCLOSURE_INCOMPLETE");
    const file = await uploadConsent(d.id);
    const consent = (user: string, partyId: string, extra: object = {}) => as(user, "POST", `/api/deals/${d.id}/disclosures`, {
      kind: "MULTIPLE_REPRESENTATION_CONSENT", partyId, deliveredAt: "2026-09-01T09:00:00-04:00", method: "Signed consent",
      acknowledgedAt: "2026-09-01T09:15:00-04:00", situationAroseOn: "2026-09-01", documentFileId: file, ...extra });
    assert.equal((await consent(u.agent, d.seller)).statusCode, 403); // never the agent
    assert.equal((await consent(u.compliance, d.seller, { documentFileId: undefined })).json().error.code, "DISCLOSURE_INCOMPLETE"); // the signed copy
    assert.equal((await consent(u.compliance, d.seller, { situationAroseOn: undefined })).json().error.code, "DISCLOSURE_INCOMPLETE"); // when it arose
    const elsewhere = await twoAgentDeal();
    await agreement(elsewhere.id, elsewhere.seller, "BROKERAGE");
    await agreement(elsewhere.id, elsewhere.buyer, "BROKERAGE", [], u.broker);
    const otherFile = await uploadConsent(elsewhere.id);
    assert.equal((await consent(u.compliance, d.seller, { documentFileId: otherFile })).statusCode, 422); // a file from another deal
    for (const p of [d.seller, d.buyer]) {
      assert.equal((await disclose(p, ["DUTIES", "SERVICES", "REMUNERATION", "INDEPENDENT_ADVICE"])).statusCode, 201);
      assert.equal((await consent(u.compliance, p)).statusCode, 201);
    }
    assert.ok(!rules(await obligations(d.id)).some((r) => r.startsWith("MULTIPLE_REPRESENTATION")));
    assert.equal((await as(u.agent, "POST", `/api/deals/${d.id}/firm`)).statusCode, 200);

    // Signed weeks after it arose: flagged for the broker of record's review, not declared a breach
    const late = await twoAgentDeal();
    await agreement(late.id, late.seller, "BROKERAGE");
    await agreement(late.id, late.buyer, "BROKERAGE", [], u.broker);
    const lateFile = await uploadConsent(late.id);
    for (const p of [late.seller, late.buyer]) {
      await as(u.broker, "POST", `/api/deals/${late.id}/disclosures`, { kind: "MULTIPLE_REPRESENTATION_DISCLOSURE", partyId: p, deliveredAt: "2026-10-15T09:00:00-04:00",
        method: "Written disclosure", acknowledgedAt: "2026-10-15T09:10:00-04:00", confirms: ["DUTIES", "SERVICES", "REMUNERATION", "INDEPENDENT_ADVICE"] });
      assert.equal((await as(u.compliance, "POST", `/api/deals/${late.id}/disclosures`, { kind: "MULTIPLE_REPRESENTATION_CONSENT", partyId: p,
        deliveredAt: "2026-10-15T09:00:00-04:00", method: "Signed consent", acknowledgedAt: "2026-10-15T09:15:00-04:00", situationAroseOn: "2026-09-20",
        documentFileId: lateFile })).statusCode, 201);
    }
    const review = (await obligations(late.id)).tresa.filter((f: { rule: string }) => f.rule === "MULTIPLE_REPRESENTATION_REVIEW");
    assert.deepEqual(review.map((f: { severity: string }) => f.severity), ["WARNING", "WARNING"]);
    assert.match(review[0].message, /arose on 2026-09-20: broker of record to review/);
  });

  test("our buyers' offers on our listing: separate designated representatives need no consent; the seller's own agent does; other buyers and variable commission are disclosed", async () => {
    const l = await deal("LISTING", [{ role: "SELLER", fullName: "Ann Lee" }, { role: "BUYER", fullName: "Bo Kim" }, { role: "COOP_BROKERAGE", fullName: "Other Realty" }],
      { sellerRemunerationVaries: true });
    const seller = await prisma.transactionParty.findFirstOrThrow({ where: { transactionId: l.deal.id, role: "SELLER" } });
    await agreement(l.deal.id, seller.id, "DESIGNATED", [u.agent]);
    const offer = (at: string, body: object) => as(u.agent, "POST", `/api/deals/${l.deal.id}/offers`, { receivedAt: at, written: true, ...body });
    assert.equal((await offer("2026-10-09T19:00:00-04:00", { offerorBrokerage: "This brokerage", fromOurBrokerage: true, buyerRepresentation: "DESIGNATED", buyerAgentIds: [u.agent2] })).statusCode, 201);
    assert.equal((await offer("2026-10-09T19:30:00-04:00", { offerorBrokerage: "This brokerage", fromOurBrokerage: true, buyerRepresentation: "DESIGNATED", buyerAgentIds: [u.broker] })).statusCode, 201);
    assert.equal((await offer("2026-10-09T20:00:00-04:00", { offerorBrokerage: "Other Realty" })).statusCode, 201);
    assert.equal((await offer("2026-10-09T20:05:00-04:00", { offerorBrokerage: "Other Realty", buyerRepresentation: "BROKERAGE" })).statusCode, 400); // only for our buyers
    const offers = await prisma.offer.findMany({ where: { listingDealId: l.deal.id }, orderBy: { receivedAt: "asc" } });
    let o = await obligations(l.deal.id);
    // Two buyers with different designated agents, neither the seller's: no multiple representation, no consent
    assert.ok(!rules(o).includes("OFFER_MULTIPLE_REPRESENTATION"));
    assert.ok(o.tresa.some((f: { rule: string; offerId: string }) => f.rule === "SAME_BROKERAGE_REPRESENTATION" && f.offerId === offers[2]!.id));
    assert.equal(o.tresa.filter((f: { rule: string }) => f.rule === "VARIABLE_REMUNERATION").length, 3); // every written offeror
    assert.equal(await prisma.documentSlot.count({ where: { transactionId: l.deal.id, documentType: { code: "REPRESENTATION_CONSENTS" } } }), 0);

    // A third buyer of ours, represented by the seller's own designated agent: multiple representation, consent before acceptance
    assert.equal((await offer("2026-10-09T20:10:00-04:00", { offerorBrokerage: "This brokerage", fromOurBrokerage: true, buyerRepresentation: "DESIGNATED", buyerAgentIds: [u.agent] })).statusCode, 201);
    const third = (await prisma.offer.findFirstOrThrow({ where: { listingDealId: l.deal.id, buyerAgentIds: { has: u.agent } } })).id;
    o = await obligations(l.deal.id);
    const mr = o.tresa.filter((f: { rule: string }) => f.rule === "OFFER_MULTIPLE_REPRESENTATION");
    assert.deepEqual(mr.map((f: { offerId: string }) => f.offerId), [third]);
    assert.match(mr[0].message, /multiple representation with the seller/);
    const accept = await as(u.agent, "POST", `/api/offers/${offers[0]!.id}/events`, { status: "ACCEPTED" });
    assert.equal(accept.json().error.code, "OFFER_DISCLOSURES_OUTSTANDING");
    const file = await uploadConsent(l.deal.id);
    const consent = (user: string) => as(user, "POST", `/api/deals/${l.deal.id}/disclosures`, {
      kind: "COMPETING_BUYERS_CONSENT", offerId: third, deliveredAt: "2026-10-09T20:00:00-04:00", method: "Signed consent",
      acknowledgedAt: "2026-10-09T20:05:00-04:00", situationAroseOn: "2026-10-09", documentFileId: file,
      content: "Seller and buyer consented in writing to the same designated representative" });
    assert.equal((await consent(u.agent)).statusCode, 403);
    assert.equal((await consent(u.broker)).statusCode, 201);
    o = await obligations(l.deal.id);
    assert.ok(!rules(o).includes("OFFER_MULTIPLE_REPRESENTATION"));
    // The seller's variable commission, told to each written offeror
    for (const off of await prisma.offer.findMany({ where: { listingDealId: l.deal.id } })) {
      const r = await as(u.agent, "POST", `/api/deals/${l.deal.id}/disclosures`, { kind: "VARIABLE_REMUNERATION_DISCLOSURE", offerId: off.id,
        deliveredAt: "2026-10-09T20:30:00-04:00", method: "Email", content: "The listing commission is 1% lower if this brokerage also represents the buyer" });
      assert.equal(r.statusCode, 201, r.body);
    }
    assert.ok(!rules(await obligations(l.deal.id)).includes("VARIABLE_REMUNERATION"));
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
