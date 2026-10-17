/**
 * Closing / CDA integration tests: real deals through the API, FINTRAC
 * approval, deposits in trust, then finalize. Needs DATABASE_URL with
 * migrations 001–005; skipped otherwise.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { fromDatabaseError } from "../src/errors.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { JPEG, multipart, TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-12-01";

describe("closing and CDA API", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({
    prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY,
  });
  const u = { broker: "", compliance: "", agent: "" };
  let account = "";

  before(async () => {
    const make = async (role: UserRole, extra: object = {}) =>
      (await prisma.user.create({
        data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: "Jane", lastName: "Smith", role, ...extra },
      })).id;
    u.broker = await make("MANAGING_BROKER");
    u.compliance = await make("COMPLIANCE_ADMIN");
    u.agent = await make("AGENT", {
      isPrec: true, precLegalName: "Jane Smith Real Estate Professional Corporation", hstNumber: "123456789RT0001",
    });
    await prisma.commissionPlan.create({
      data: {
        userId: u.agent, annualCap: "15000",
        fees: { create: [{ name: "Deal fee", amount: "150" }, { name: "Desk fee", amount: "50" }] },
      },
    });
    account = (await prisma.trustAccount.create({ data: { name: "Trust", bankName: "TD", accountLast4: "4821" } })).id;
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const as = (user: string, method: "GET" | "POST", url: string, body?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { "x-user-id": user, ...headers }, ...(body ? { payload: body } : {}) });

  /** A Toronto listing, FINTRAC-approved, with an optional deposit in our trust. */
  async function torontoListing(opts: { deposit?: number; approveFintrac?: boolean } = {}) {
    const created = await as(u.agent, "POST", "/api/deals", {
      side: "LISTING", streetAddress: "88 Queens Quay W", unit: "1205", city: "Toronto", mlsNumber: "C1234567",
      salePrice: "1100000", offerDate: "2026-10-10", closeDate: "2026-11-30",
      depositAmount: String(opts.deposit ?? 55_000),
      trustDepositHolder: opts.deposit ? "OUR_BROKERAGE" : "COOP_BROKERAGE",
      totalGci: "27500",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80 }],
      parties: [
        { role: "SELLER", fullName: "Ann Lee" },
        { role: "BUYER", fullName: "Bo Kim" },
        { role: "SELLER_LAWYER", fullName: "Patel Law LLP", email: "closings@patellaw.ca", phone: "416-555-0100" },
        { role: "COOP_BROKERAGE", fullName: "Harbourfront Realty Inc." },
      ],
    });
    assert.equal(created.statusCode, 201, created.body);
    const docs = created.json();
    const dealId: string = docs.deal.id;
    await prisma.transaction.update({ where: { id: dealId }, data: { coopCommission: "22000", status: "FIRM" } });

    if (opts.deposit) {
      const dep = await as(u.broker, "POST", "/api/trust/deposits", {
        dealId, trustAccountId: account, amount: `${opts.deposit}.00`, method: "BANK_DRAFT",
        dateReceived: "2026-10-12", dateDeposited: "2026-10-13", payorName: "Bo Kim", bankReference: "DRAFT-1",
      }, { "idempotency-key": randomUUID() });
      assert.equal(dep.statusCode, 201, dep.body);
    }

    if (opts.approveFintrac !== false) {
      const slot = docs.slots.find((s: { code: string }) => s.code === "FINTRAC_INDIVIDUAL");
      const { payload, contentType } = multipart({ name: "id.jpg", type: "image/jpeg", bytes: JPEG }, {
        verificationDate: "2026-10-01", fullLegalName: "Ann Lee", dateOfBirth: "1970-01-01", address: "1 Bay St, Toronto",
        occupation: "Engineer", idType: "PASSPORT", idNumber: "AB123456", issuingJurisdiction: "Canada",
        expiryDate: "2030-01-01", thirdPartyDetermination: false,
      });
      const up = await app.inject({
        method: "POST", url: `/api/documents/slots/${slot.id}/files`, payload,
        headers: { "x-user-id": u.agent, "content-type": contentType },
      });
      assert.equal(up.statusCode, 201, up.body);
      const ok = await as(u.compliance, "POST", `/api/documents/slots/${slot.id}/review`, { decision: "APPROVED", fileId: up.json().fileId });
      assert.equal(ok.statusCode, 200, ok.body);
    }
    return dealId;
  }

  const close = (dealId: string) => prisma.transaction.update({ where: { id: dealId }, data: { status: "CLOSED" } });
  const finalize = (dealId: string, key = randomUUID(), user = u.broker) =>
    as(user, "POST", `/api/deals/${dealId}/closing/finalize`, undefined, { "idempotency-key": key });

  test("no CDA until the deal is FINTRAC approved", async () => {
    const dealId = await torontoListing({ deposit: 60_000, approveFintrac: false });
    const res = await as(u.broker, "GET", `/api/deals/${dealId}/closing`);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, "FINTRAC_NOT_APPROVED");
    assert.match(res.json().error.message, /FINTRAC Individual Identification Record \(Ann Lee\): MISSING/);
  });

  test("finalize: posts the trust distributions, leaves the deal's trust at $0.00 and freezes the CDA", async () => {
    const dealId = await torontoListing({ deposit: 60_000 });

    const preview = await as(u.broker, "GET", `/api/deals/${dealId}/closing`);
    assert.equal(preview.statusCode, 200, preview.body);
    assert.equal(preview.json().finalized, false);
    assert.equal(preview.json().computation.trust.balanceDueToLawyer, 406_500);
    const draft = await as(u.compliance, "GET", `/api/deals/${dealId}/closing/cda?audience=lawyer`);
    assert.equal(draft.headers["content-type"], "text/html; charset=utf-8");
    assert.match(draft.body, /class="watermark"/);
    assert.equal((await as(u.agent, "GET", `/api/deals/${dealId}/closing`)).statusCode, 403);

    assert.equal((await finalize(dealId)).json().error.code, "DEAL_NOT_CLOSED");
    await close(dealId);
    assert.equal((await finalize(dealId, randomUUID(), u.compliance)).statusCode, 403);

    const key = randomUUID();
    const done = await finalize(dealId, key);
    assert.equal(done.statusCode, 201, done.body);
    const body = done.json();
    assert.equal(body.cdaNumber.startsWith("CDA-"), true);
    assert.deepEqual(
      body.trustEntries.map((e: { entryType: string; amount: string; authorizationReference: string }) =>
        [e.entryType, e.amount, e.authorizationReference]),
      [
        ["DISBURSEMENT_TO_COOP", "24860.00", body.cdaNumber],
        ["DISBURSEMENT_TO_GENERAL", "31075.00", body.cdaNumber],
        ["DISBURSEMENT_TO_LAWYER", "4065.00", body.cdaNumber],
      ],
    );

    const ledger = (await as(u.broker, "GET", `/api/deals/${dealId}/trust`)).json();
    assert.equal(ledger.balances[0].balance, "0.00");
    assert.equal(ledger.deal.depositStatus, "RELEASED");

    const payout = await prisma.closingAgentPayout.findFirstOrThrow({ where: { closing: { transactionId: dealId } } });
    assert.equal(payout.payeeName, "Jane Smith Real Estate Professional Corporation");
    assert.equal(payout.netPayout.toFixed(2), "24634.00");
    assert.equal(payout.houseSplitBase.toFixed(2), "5500.00");

    const finalCda = await as(u.broker, "GET", `/api/deals/${dealId}/closing/cda?audience=internal`);
    assert.match(finalCda.body, /class="status FINAL"/);
    assert.ok(finalCda.body.includes(`Verification ${body.computationSha.slice(0, 16)}`));
    assert.ok(finalCda.body.includes("Agent commission statements"));

    const retry = await finalize(dealId, key);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().replayed, true);
    assert.equal(retry.json().statementId, body.statementId);
    assert.equal((await finalize(dealId)).json().error.code, "ALREADY_FINALIZED");

    // The issued statement can't be edited, even directly in SQL
    let code = "no error";
    try {
      await prisma.$executeRaw`UPDATE "ClosingStatement" SET "lawyerHtml" = 'x' WHERE id = ${body.statementId}::uuid`;
    } catch (err) {
      code = fromDatabaseError(err)?.code ?? "other";
    }
    assert.equal(code, "APPEND_ONLY");
  });

  test("deposit short of the commission: lawyer owes the balance, wired to the PREC", async () => {
    const dealId = await torontoListing({ deposit: 40_000 });
    await close(dealId);
    const res = await finalize(dealId);
    assert.equal(res.statusCode, 201, res.body);
    const c = res.json().computation;
    assert.equal(c.trust.balanceDueFromLawyer, 1_593_500);
    assert.deepEqual(c.wires.map((w: { to: string; amount: number }) => [w.to, w.amount]), [["AGENT", 1_593_500]]);
  });

  test("cap: earlier finalized closings count toward the agent's cap year", async () => {
    const before = (await prisma.closingAgentPayout.aggregate({ where: { userId: u.agent }, _sum: { houseSplitBase: true } }))
      ._sum.houseSplitBase?.toNumber() ?? 0;
    const dealId = await torontoListing({});
    const c = (await as(u.broker, "GET", `/api/deals/${dealId}/closing`)).json().computation;
    const expected = Math.max(0, 15_000 - before - 5_500);
    assert.equal(c.agents[0].capRemainingAfter, expected * 100);
    assert.equal(c.agents[0].houseSplitBase, Math.min(5_500, Math.max(0, 15_000 - before)) * 100);
  });

  test("audit: trust funds the CDA wouldn't distribute block the closing", async () => {
    const dealId = await torontoListing({ deposit: 10_000 });
    // Someone changes the deal to say the co-op holds the deposit, but $10,000 is still in our trust
    await prisma.transaction.update({ where: { id: dealId }, data: { trustDepositHolder: "COOP_BROKERAGE" } });
    await close(dealId);
    const res = await finalize(dealId);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, "TRUST_WILL_NOT_BALANCE");
    assert.equal((await as(u.broker, "GET", `/api/deals/${dealId}/trust`)).json().balances[0].balance, "10000.00");
    assert.equal(await prisma.closingStatement.count({ where: { transactionId: dealId } }), 0);
  });
});
