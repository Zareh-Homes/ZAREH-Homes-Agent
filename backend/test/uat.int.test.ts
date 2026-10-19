/**
 * User acceptance workflows run end to end through the API with fictional
 * Ontario deals (docs/uat.md maps every scenario A–L to its evidence).
 *
 *   A  Buyer-side closing: deposit held by the listing brokerage; commission received, verified, approved, paid, confirmed
 *   G  Returned agent payment, correction and replacement payment
 *   F  Failed conditional deal: deposit released only with a mutual release on record
 *   M  Landlord-side lease: rent deposit in trust, commission from it, the balance to the landlord
 *
 * Needs DATABASE_URL; skipped otherwise.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { approvedPlan, attestCleared, attestedObligations, designateBroker, JPEG, multipart, TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-11-20";

describe("UAT workflows", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { agent: "", broker: "", broker2: "", admin: "", admin2: "", compliance: "" };
  let operating = "";
  let trust = "";

  const as = (user: string, method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user, "idempotency-key": randomUUID() }, ...(body ? { payload: body } : {}) });
  const ok = async (p: Promise<{ statusCode: number; body: string; json(): any }>, code = 200) => {
    const r = await p;
    assert.equal(r.statusCode, code, r.body);
    return r.json();
  };

  async function approveFintrac(dealId: string, slots: { code: string; id: string }[], name: string) {
    const slot = slots.find((s) => s.code === "FINTRAC_INDIVIDUAL")!;
    const { payload, contentType } = multipart({ name: "id.jpg", type: "image/jpeg", bytes: JPEG }, {
      verificationDate: "2026-10-01", fullLegalName: name, dateOfBirth: "1984-04-04", address: "12 Elm St, Hamilton", occupation: "Teacher",
      idType: "DRIVERS_LICENCE", idNumber: "K1234-56789-01234", issuingJurisdiction: "Ontario", expiryDate: "2030-04-04", thirdPartyDetermination: false,
    });
    const up = await app.inject({ method: "POST", url: `/api/documents/slots/${slot.id}/files`, payload, headers: { "x-user-id": u.agent, "content-type": contentType } });
    assert.equal(up.statusCode, 201, up.body);
    await ok(as(u.compliance, "POST", `/api/documents/slots/${slot.id}/review`, { decision: "APPROVED", fileId: up.json().fileId }));
    void dealId;
  }

  /** Today's bank activity, imported by one admin and verified by another */
  async function bankFile(lines: [string, string][], balance: string) {
    const csv = "Date,Description,Amount\n" + lines.map(([d, a]) => `${TODAY},${d},${a}`).join("\n") + "\n";
    const s = await ok(as(u.admin, "POST", "/api/bank/statements", {
      kind: "INTERIM", accountType: "OPERATING", accountId: operating, periodStart: TODAY, periodEnd: TODAY, closingBalance: balance,
      receivedDate: TODAY, source: "BANK_PORTAL_DOWNLOAD", fileName: `activity-${randomUUID().slice(0, 4)}.csv`, csv,
    }), 201);
    await ok(as(u.admin2, "POST", `/api/bank/statements/${s.id}/verify`, { method: "Checked against the TD business portal" }));
    return s;
  }

  before(async () => {
    const make = async (role: UserRole, first: string, extra: object = {}) => (await prisma.user.create({
      data: { email: `uat-${first.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: first, lastName: "Uat", role, ...extra },
    })).id;
    u.agent = await make("AGENT", "Priya", { isPrec: true, precLegalName: "Priya Uat Real Estate Professional Corporation", hstNumber: "987654321RT0001" });
    u.broker = await make("MANAGING_BROKER", "Daniel");
    u.broker2 = await make("MANAGING_BROKER", "Maria");
    u.admin = await make("ADMIN", "Alex");
    u.admin2 = await make("ADMIN", "Sam");
    u.compliance = await make("COMPLIANCE_ADMIN", "Chris");
    await designateBroker(app, prisma, u.broker);
    await approvedPlan(prisma, u.agent, { fees: [{ name: "Transaction fee", amount: "250.00" }] });
    operating = (await prisma.operatingAccount.create({ data: { name: `General ${randomUUID().slice(0, 4)}`, bankName: "TD", accountLast4: "2200" } })).id;
    await attestedObligations(prisma, operating, TODAY);
    trust = (await prisma.trustAccount.create({ data: { name: `Trust ${randomUUID().slice(0, 4)}`, bankName: "TD", accountLast4: "4821" } })).id;
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("A + G: buyer-side closing to a confirmed payment, then a returned payment and its replacement", async () => {
    // Buyer-side deal in Oakville: the listing brokerage holds the $50,000 deposit and pays our commission
    const created = await ok(as(u.agent, "POST", "/api/deals", {
      side: "BUYER", streetAddress: "210 Navy St", city: "Oakville", salePrice: "1250000", offerDate: "2026-10-01", closeDate: "2026-11-18",
      depositAmount: "50000", trustDepositHolder: "COOP_BROKERAGE", totalGci: "31250",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 85 }],
      parties: [{ role: "BUYER", fullName: "Jordan Ng" }, { role: "SELLER", fullName: "Lake Holdings Inc.", entityType: "CORPORATION" },
        { role: "BUYER_LAWYER", fullName: "Shah Law", email: "close@shah.test" }, { role: "COOP_BROKERAGE", fullName: "Lakeshore Realty Ltd." }],
    }), 201);
    const dealId = created.deal.id;
    await approveFintrac(dealId, created.slots, "Jordan Ng");
    await ok(as(u.agent, "POST", `/api/deals/${dealId}/firm`));
    await ok(as(u.agent, "POST", `/api/deals/${dealId}/close`, { closedOn: "2026-11-18" }));

    const cda = await ok(as(u.broker, "POST", `/api/deals/${dealId}/closing/finalize`), 201);
    assert.equal(cda.computation.payer.kind, "COOPERATING_BROKERAGE");
    assert.equal(cda.computation.trust.distributions.length, 0); // nothing from our trust
    const due = cda.computation.wiresTotal; // $31,250 + 13% HST = $35,312.50
    assert.equal(due, 3_531_250);

    // Lakeshore Realty wires the commission; it's recorded, then verified at the bank by a second person
    const received = await ok(as(u.admin, "POST", `/api/deals/${dealId}/closing/commission-received`,
      { amount: "35312.50", receivedDate: TODAY, reference: "WIRE-LAKESHORE-118", account: { type: "OPERATING", id: operating } }), 201);
    assert.equal(received.payouts[0].status, "AWAITING_BANK_VERIFICATION");
    await bankFile([["WIRE IN WIRE-LAKESHORE-118", "35312.50"]], "35312.50");
    const payouts = await ok(as(u.admin, "GET", `/api/deals/${dealId}/closing/payouts`));
    const payout = payouts.payouts[0];
    assert.deepEqual([payout.status, payout.payeeName], ["READY_FOR_APPROVAL", "Priya Uat Real Estate Professional Corporation"]);

    // A managing broker who didn't record it approves; someone else sends the payment
    assert.equal((await as(u.admin, "POST", `/api/payouts/${payout.id}/approve`, {})).statusCode, 403);
    await ok(as(u.broker2, "POST", `/api/payouts/${payout.id}/approve`, {}));
    assert.equal((await as(u.broker2, "POST", `/api/payouts/${payout.id}/paid`, { paidDate: TODAY, reference: "EFT-7001" })).statusCode, 403);
    const sent = await ok(as(u.admin, "POST", `/api/payouts/${payout.id}/paid`, { paidDate: TODAY, reference: "EFT-7001" }));
    assert.deepEqual([sent.payouts[0].status, sent.payouts[0].paymentConfirmed], ["PAID", false]);
    const amount = sent.payouts[0].amount as string;

    // G: the EFT comes back (wrong account number): recorded, then paid again under the same approval
    const returned = await ok(as(u.admin, "POST", `/api/payouts/${payout.id}/payment-reversed`,
      { date: TODAY, reference: "EFT-7001-RETURN", reason: "Returned by the bank: account closed; agent supplied new banking" }));
    assert.equal(returned.payouts[0].status, "PAYMENT_RETURNED");
    const resent = await ok(as(u.admin, "POST", `/api/payouts/${payout.id}/paid`, { paidDate: TODAY, reference: "EFT-7002" }));
    assert.equal(resent.payouts[0].status, "PAID");
    // The bank shows the first payment, its return and the replacement; each is matched, the replacement is confirmed
    await bankFile([[`EFT OUT EFT-7001`, `-${amount}`], [`EFT RETURN EFT-7001-RETURN`, amount], [`EFT OUT EFT-7002`, `-${amount}`]],
      (35312.5 - Number(amount)).toFixed(2));
    const final = await ok(as(u.admin, "GET", `/api/deals/${dealId}/closing/payouts`));
    assert.equal(final.payouts[0].paymentConfirmed, true);
    assert.deepEqual(final.payouts[0].history.map((h: { kind: string }) => h.kind), ["APPROVED", "PAID", "PAYMENT_REVERSED", "PAID"]);
    assert.equal(await prisma.payoutEvent.count({ where: { payoutId: payout.id, kind: "PAID" } }), 2);
  });

  test("M: landlord-side lease — first and last month's rent in trust, commission applied, the balance to the landlord", async () => {
    const created = await ok(as(u.agent, "POST", "/api/deals", {
      side: "LANDLORD", streetAddress: "41 Ridge Rd", unit: "Upper", city: "Stoney Creek", salePrice: "3000", offerDate: "2026-11-02",
      closeDate: "2026-11-15", depositAmount: "6000", trustDepositHolder: "OUR_BROKERAGE", totalGci: "3000",
      coopCommission: "1500", coopBrokerageName: "Harbourfront Realty Inc.",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 85 }],
      parties: [{ role: "LANDLORD", fullName: "Rita Olsen", email: "rita@example.test" }, { role: "TENANT", fullName: "Kofi Mensah" },
        { role: "COOP_BROKERAGE", fullName: "Harbourfront Realty Inc." }],
    }), 201);
    const dealId = created.deal.id;
    // Lease paperwork, and no FINTRAC identification slots (FINTRAC covers purchases and sales)
    const codes = created.slots.map((x: { code: string }) => x.code).sort();
    assert.deepEqual(codes, ["AGREEMENT_TO_LEASE", "LEASE_LISTING"]);
    // Only a broker or admin changes commission figures after the deal is opened, and it's recorded
    assert.equal((await as(u.agent, "POST", `/api/deals/${dealId}/amendments`, {
      field: "COOP_COMMISSION", newValue: "1400", reference: "Form 320" })).statusCode, 403);

    const deposit = await ok(as(u.broker, "POST", "/api/trust/deposits", {
      dealId, trustAccountId: trust, amount: "6000.00", method: "CERTIFIED_CHEQUE", dateReceived: "2026-11-03", dateDeposited: "2026-11-03",
      payorName: "Kofi Mensah", bankReference: "CHQ-7781" }), 201);
    await attestCleared(app, u.broker, [deposit.entry.id]);
    await ok(as(u.agent, "POST", `/api/deals/${dealId}/firm`));
    await ok(as(u.agent, "POST", `/api/deals/${dealId}/close`, { closedOn: "2026-11-15" }));

    const cda = await ok(as(u.broker, "POST", `/api/deals/${dealId}/closing/finalize`), 201);
    assert.deepEqual(cda.computation.payer, { kind: "LANDLORD", name: "Rita Olsen" });
    // Landlord owes ($3,000 + $1,500) × 1.13 = $5,085: all of it from the $6,000 deposit, $915 back to the landlord
    assert.deepEqual(cda.trustEntries.map((e: { entryType: string; amount: string }) => [e.entryType, e.amount]), [
      ["DISBURSEMENT_TO_COOP", "1695.00"], ["DISBURSEMENT_TO_GENERAL", "3390.00"], ["DISBURSEMENT_TO_LANDLORD", "915.00"]]);
    const ledger = await ok(as(u.broker, "GET", `/api/deals/${dealId}/trust`));
    assert.equal(ledger.balances[0].balance, "0.00");
    const html = (await as(u.broker, "GET", `/api/deals/${dealId}/closing/cda?audience=lawyer`)).body;
    assert.ok(html.includes("To: Landlord") && html.includes("Lease commencement") && html.includes("rita@example.test"));
  });

  test("F: a failed conditional deal — the deposit goes back only with the signed mutual release on record", async () => {
    const created = await ok(as(u.agent, "POST", "/api/deals", {
      side: "LISTING", streetAddress: "88 Main St W", city: "Grimsby", salePrice: "715000", offerDate: "2026-11-02", closeDate: "2027-01-15",
      depositAmount: "25000", trustDepositHolder: "OUR_BROKERAGE", totalGci: "17875",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 85 }],
      parties: [{ role: "SELLER", fullName: "Rita Olsen" }, { role: "BUYER", fullName: "Kofi Mensah" }, { role: "COOP_BROKERAGE", fullName: "Niagara Homes Inc." }],
    }), 201);
    const dealId = created.deal.id;
    const deposit = await ok(as(u.broker, "POST", "/api/trust/deposits", {
      dealId, trustAccountId: trust, amount: "25000.00", method: "BANK_DRAFT", dateReceived: "2026-11-03", dateDeposited: "2026-11-04",
      payorName: "Kofi Mensah", bankReference: "DRAFT-5521" }), 201);
    await attestCleared(app, u.broker, [deposit.entry.id]);
    const cond = await ok(as(u.agent, "POST", `/api/deals/${dealId}/conditions`, {
      kind: "FINANCING", description: "Buyer arranging a first mortgage", forBenefitOf: "BUYER", dueAt: "2026-11-09T23:59:00-05:00" }), 201);
    await ok(as(u.agent, "POST", `/api/conditions/${cond.conditions[0].id}/outcome`, {
      outcome: "FAILED", reference: "Buyer's notice: financing not obtained" }), 201);
    const ended = await ok(as(u.agent, "POST", `/api/deals/${dealId}/terminate`, {
      reason: "CONDITION_NOT_MET", reference: "Form 122 mutual release, signed by both parties Nov 12", note: "Financing condition failed" }));
    assert.equal(ended.status, "COLLAPSED");
    assert.ok(ended.nextSteps.some((s: string) => /release it only under a signed mutual release or a court order/.test(s)));

    const refund = (extra: object) => as(u.broker, "POST", "/api/trust/disbursements", {
      dealId, trustAccountId: trust, amount: "25000.00", method: "CHEQUE", dateDisbursed: TODAY, payeeType: "PAYOR_REFUND",
      payeeName: "Kofi Mensah", ...extra });
    assert.equal((await refund({ authorizationMethod: "CLOSING_COMPLETED" })).statusCode, 400); // a refund can't use closing authority
    assert.equal((await refund({ authorizationMethod: "MUTUAL_RELEASE" })).statusCode, 400); // the release must be cited
    const paid = await refund({ authorizationMethod: "MUTUAL_RELEASE", authorizationReference: "Form 122 mutual release, signed Nov 12" });
    assert.equal(paid.statusCode, 201, paid.body);
    const ledger = await ok(as(u.broker, "GET", `/api/deals/${dealId}/trust`));
    assert.equal(ledger.balances[0].balance, "0.00");
  });
});
