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
import { approvedPlan, attestCleared, attestedObligations, designateBroker, JPEG, multipart, TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-12-01";

describe("closing and CDA API", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({
    prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY,
  });
  const u = { broker: "", compliance: "", agent: "", admin: "" };
  let account = "";
  let operating = "";

  before(async () => {
    const make = async (role: UserRole, extra: object = {}) =>
      (await prisma.user.create({
        data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: "Jane", lastName: "Smith", role, ...extra },
      })).id;
    u.broker = await make("MANAGING_BROKER");
    await designateBroker(app, prisma, u.broker);
    u.compliance = await make("COMPLIANCE_ADMIN");
    u.admin = await make("ADMIN");
    u.agent = await make("AGENT", {
      isPrec: true, precLegalName: "Jane Smith Real Estate Professional Corporation", hstNumber: "123456789RT0001",
    });
    await approvedPlan(prisma, u.agent, { annualCap: "15000", fees: [{ name: "Deal fee", amount: "150.00" }, { name: "Desk fee", amount: "50.00" }] });
    account = (await prisma.trustAccount.create({ data: { name: "Trust", bankName: "TD", accountLast4: "4821" } })).id;
    operating = (await prisma.operatingAccount.create({ data: { name: "General", bankName: "TD", accountLast4: "1177" } })).id;
    await attestedObligations(prisma, operating, TODAY);
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const as = (user: string, method: "GET" | "POST", url: string, body?: object, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { "x-user-id": user, ...headers }, ...(body ? { payload: body } : {}) });

  /** A Toronto listing, FINTRAC-approved, with an optional deposit in our trust. */
  async function torontoListing(opts: { deposit?: number; approveFintrac?: boolean; cleared?: boolean } = {}) {
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
      if (opts.cleared !== false) await attestCleared(app, u.broker, [dep.json().entry.id]);
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

  test("deposit short of the commission: lawyer pays the brokerage; the agent is paid only after receipt and broker approval", async () => {
    const dealId = await torontoListing({ deposit: 40_000 });
    await close(dealId);
    const res = await finalize(dealId);
    assert.equal(res.statusCode, 201, res.body);
    const c = res.json().computation;
    assert.equal(c.trust.balanceDueFromLawyer, 1_593_500);
    assert.deepEqual(c.wires.map((w: { to: string; amount: number }) => [w.to, w.amount]), [["BROKERAGE", 1_593_500]]);

    const row = await prisma.closingAgentPayout.findFirstOrThrow({ where: { closing: { transactionId: dealId } } });
    assert.equal(row.wiredByLawyer.toFixed(2), "0.00");
    assert.equal(row.paidByBrokerage.toFixed(2), "24634.00");

    const payouts = (await as(u.admin, "GET", `/api/deals/${dealId}/closing/payouts`)).json();
    assert.equal(payouts.commissionDue, "15935.00");
    assert.equal(payouts.payouts[0].status, "AWAITING_COMMISSION");
    const payoutId: string = payouts.payouts[0].id;

    // Can't approve before the money is in, or pay before approval
    const early = await as(u.broker, "POST", `/api/payouts/${payoutId}/approve`, {});
    assert.equal(early.json().error.code, "COMMISSION_NOT_RECEIVED");
    const unapproved = await as(u.admin, "POST", `/api/payouts/${payoutId}/paid`, { paidDate: "2026-12-01", reference: "EFT-1" });
    assert.equal(unapproved.json().error.code, "PAYOUT_NOT_APPROVED");

    const receive = (amount: string, user = u.admin) => as(user, "POST", `/api/deals/${dealId}/closing/commission-received`,
      { amount, receivedDate: "2026-11-30", reference: "WIRE-PATEL-77", account: { type: "OPERATING", id: operating } });
    assert.equal((await receive("15935.00", u.agent)).statusCode, 403);
    assert.equal((await receive("10000.00")).statusCode, 201);
    assert.equal((await receive("6000.00")).json().error.code, "COMMISSION_OVER_RECEIVED");
    const intoRealEstateTrust = await as(u.admin, "POST", `/api/deals/${dealId}/closing/commission-received`,
      { amount: "1.00", receivedDate: "2026-11-30", reference: "X", account: { type: "COMMISSION_TRUST", id: account } });
    assert.match(intoRealEstateTrust.json().error.message, /never the real estate trust account/);
    const full = await receive("5935.00");
    assert.equal(full.json().commissionReceived, "15935.00");
    assert.equal(full.json().payouts[0].status, "AWAITING_BANK_VERIFICATION");
    assert.equal((await as(u.broker, "POST", `/api/payouts/${payoutId}/approve`, {})).json().error.code, "COMMISSION_NOT_CLEARED");

    // The operating statement shows the trust transfer and the lawyer's two wires; each wire is matched to its receipt
    const imported = await as(u.admin, "POST", "/api/bank/statements", {
      accountType: "OPERATING", accountId: operating, periodStart: "2026-11-01", periodEnd: "2026-11-30",
      openingBalance: "0.00", closingBalance: "31075.00", receivedDate: "2026-12-01", source: "BANK_PORTAL_DOWNLOAD",
      fileName: "general-nov.csv", autoMatch: false,
      csv: "Date,Description,Amount\n11/30/2026,TRANSFER FROM TRUST,15140.00\n" +
        "11/30/2026,WIRE IN PATEL LAW LLP WIRE-PATEL-77,10000.00\n11/30/2026,WIRE IN PATEL LAW LLP WIRE-PATEL-77,5935.00\n",
    });
    assert.equal(imported.statusCode, 201, imported.body);
    const receipts: { id: string; amount: string }[] = full.json().receipts;
    for (const line of imported.json().lines as { id: string; amount: string }[]) {
      const receipt = receipts.find((r) => r.amount === line.amount);
      if (!receipt) continue;
      const m = await as(u.admin, "POST", "/api/bank/matches", { bankTransactionId: line.id, commissionReceiptId: receipt.id });
      assert.equal(m.statusCode, 201, m.body);
    }
    // Matched, but the file isn't evidence until someone other than the importer checks it against the bank
    assert.equal((await as(u.admin, "GET", `/api/deals/${dealId}/closing/payouts`)).json().payouts[0].status, "AWAITING_BANK_VERIFICATION");
    const selfCheck = await as(u.admin, "POST", `/api/bank/statements/${imported.json().id}/verify`, { method: "Compared to TD portal" });
    assert.equal(selfCheck.statusCode, 403);
    assert.match(selfCheck.json().error.message, /importer can't verify their own import/);
    const verified = await as(u.broker, "POST", `/api/bank/statements/${imported.json().id}/verify`, { method: "Compared to TD EasyLine" });
    assert.equal(verified.statusCode, 200, verified.body);
    const ready = (await as(u.admin, "GET", `/api/deals/${dealId}/closing/payouts`)).json();
    assert.equal(ready.payouts[0].status, "READY_FOR_APPROVAL");
    assert.ok(ready.receipts.every((r: { bankVerified: boolean }) => r.bankVerified));

    assert.equal((await as(u.admin, "POST", `/api/payouts/${payoutId}/approve`, {})).statusCode, 403); // broker only
    const approved = await as(u.broker, "POST", `/api/payouts/${payoutId}/approve`, { note: "Checked against CDA" });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().payouts[0].status, "APPROVED");
    assert.equal((await as(u.broker, "POST", `/api/payouts/${payoutId}/approve`, {})).json().error.code, "PAYOUT_ALREADY_APPROVED");
    const event = await prisma.payoutEvent.findFirstOrThrow({ where: { payoutId, kind: "APPROVED" } });
    assert.equal(event.payFromOperatingAccountId, operating);
    assert.equal(event.balanceStatementId, imported.json().id);
    assert.equal(event.amount!.toFixed(2), "24634.00");

    // The approver can't also release the money
    const selfPay = await as(u.broker, "POST", `/api/payouts/${payoutId}/paid`, { paidDate: "2026-12-01", reference: "EFT-0" });
    assert.equal(selfPay.statusCode, 403);
    const paid = await as(u.admin, "POST", `/api/payouts/${payoutId}/paid`, { paidDate: "2026-12-01", reference: "EFT-20261201-1" });
    assert.equal(paid.statusCode, 200, paid.body);
    assert.deepEqual(
      [paid.json().payouts[0].status, paid.json().payouts[0].paymentReference], ["PAID", "EFT-20261201-1"]);
    assert.equal((await as(u.admin, "POST", `/api/payouts/${payoutId}/paid`, { paidDate: "2026-12-01", reference: "again" })).json().error.code, "PAYOUT_ALREADY_PAID");

    // The EFT bounces: recorded, then paid again under the same approval
    const bounced = await as(u.admin, "POST", `/api/payouts/${payoutId}/payment-reversed`,
      { date: "2026-12-01", reference: "EFT-RETURN-9", reason: "Account closed" });
    assert.equal(bounced.json().payouts[0].status, "PAYMENT_RETURNED");
    const repaid = await as(u.admin, "POST", `/api/payouts/${payoutId}/paid`, { paidDate: "2026-12-01", reference: "EFT-20261201-2" });
    assert.equal(repaid.json().payouts[0].status, "PAID");
    assert.deepEqual(repaid.json().payouts[0].history.map((h: { kind: string }) => h.kind), ["APPROVED", "PAID", "PAYMENT_REVERSED", "PAID"]);

    // Then the lawyer's second wire is recalled: the paid payout is flagged for recovery, not silently left
    const recalled = await as(u.admin, "POST", `/api/commission-receipts/${receipts.find((r) => r.amount === "5935.00")!.id}/reverse`,
      { reason: "Wire recalled by sending bank", reversedDate: "2026-12-01", reference: "RECALL-1" });
    assert.equal(recalled.statusCode, 200, recalled.body);
    assert.equal(recalled.json().commissionReceived, "10000.00");
    assert.equal(recalled.json().payouts[0].recoveryRequired, true);

    // The database enforces the same rules if the API is bypassed
    let code = "no error";
    try {
      await prisma.$executeRaw`INSERT INTO "ClosingAgentPayout" (id, "closingId", "userId", "closeDate", "payeeName",
        "allocatedBaseGci", "houseSplitBase", "agentSplitBase", "agentSplitHst", "feesBase", "feesHst", "netPayout",
        "wiredByLawyer", "paidByBrokerage")
        VALUES (gen_random_uuid(), ${row.closingId}::uuid, ${u.agent}::uuid, '2026-11-30', 'x', 1, 0, 1, 0, 0, 0, 1, 1, 0)`;
    } catch (err) {
      code = (err as { meta?: { code?: string } }).meta?.code ?? "other";
    }
    assert.equal(code, "23514", "direct-to-agent payments are rejected by a CHECK constraint");
  });

  test("payouts on a closing paid entirely from trust can be approved straight away", async () => {
    const dealId = await torontoListing({ deposit: 60_000 });
    await close(dealId);
    assert.equal((await finalize(dealId)).statusCode, 201);
    const view = (await as(u.broker, "GET", `/api/deals/${dealId}/closing/payouts`)).json();
    assert.equal(view.commissionDue, "0.00");
    assert.equal(view.payouts[0].status, "READY_FOR_APPROVAL");
  });

  test("void and reissue: a corrected CDA keeps every earlier approval and payment, and carries payments forward", async () => {
    const dealId = await torontoListing({ deposit: 60_000 });
    await close(dealId);
    const first = await finalize(dealId);
    assert.equal(first.statusCode, 201, first.body);
    const cda0: string = first.json().cdaNumber;

    // Pay the agent under the first CDA, against a verified same-day balance
    const balance = await as(u.admin, "POST", "/api/bank/statements", {
      kind: "INTERIM", accountType: "OPERATING", accountId: operating, periodStart: TODAY, periodEnd: TODAY, closingBalance: "100000.00",
      receivedDate: TODAY, source: "BANK_PORTAL_DOWNLOAD", fileName: "today.csv", csv: `Date,Description,Amount\n${TODAY},TRANSFER FROM TRUST,31075.00\n`,
    });
    assert.equal(balance.statusCode, 201, balance.body);
    assert.equal((await as(u.broker, "POST", `/api/bank/statements/${balance.json().id}/verify`, { method: "TD portal" })).statusCode, 200);
    const before = (await as(u.broker, "GET", `/api/deals/${dealId}/closing/payouts`)).json().payouts[0];
    const payoutId: string = before.id;
    const paidAmount: string = before.remaining; // depends on how far the agent is toward their cap
    const approved = await as(u.broker, "POST", `/api/payouts/${payoutId}/approve`, { payFrom: { type: "OPERATING", id: operating } });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal((await as(u.admin, "POST", `/api/payouts/${payoutId}/paid`, { paidDate: TODAY, reference: "EFT-V1" })).statusCode, 200);

    // The split was wrong: void, correct, reissue
    assert.equal((await as(u.agent, "POST", `/api/deals/${dealId}/closing/void`, { reason: "x" })).statusCode, 403);
    const voided = await as(u.broker, "POST", `/api/deals/${dealId}/closing/void`, { reason: "Agent split should have been 85/15" });
    assert.equal(voided.statusCode, 200, voided.body);
    assert.deepEqual(voided.json(), { voided: cda0, cancelledApprovals: 0 });
    assert.equal((await as(u.broker, "GET", `/api/deals/${dealId}/closing/payouts`)).statusCode, 404);
    await prisma.transactionAgent.updateMany({ where: { transactionId: dealId }, data: { splitPct: 85 } });

    const reissued = await finalize(dealId);
    assert.equal(reissued.statusCode, 201, reissued.body);
    assert.equal(reissued.json().cdaNumber, `${cda0}-R1`);
    assert.deepEqual(reissued.json().trustEntries, []); // same trust distributions as before: nothing posted twice
    assert.equal((await as(u.broker, "GET", `/api/deals/${dealId}/trust`)).json().balances[0].balance, "0.00");
    const lawyerCopy = await as(u.broker, "GET", `/api/deals/${dealId}/closing/cda?audience=lawyer`);
    assert.ok(lawyerCopy.body.includes(`This CDA replaces ${cda0}`));

    const view = (await as(u.broker, "GET", `/api/deals/${dealId}/closing/payouts`)).json();
    const line = view.payouts[0];
    assert.equal(view.revision, 1);
    assert.equal(line.carriedForward, paidAmount);
    assert.equal(Number(line.remaining).toFixed(2), (Number(line.amount) - Number(paidAmount)).toFixed(2));
    // The first CDA's approval and payment are still on record
    assert.deepEqual((await prisma.payoutEvent.findMany({ where: { payoutId }, orderBy: { seq: "asc" } })).map((e) => e.kind), ["APPROVED", "PAID"]);

    // A correction that changes what trust paid out has to reverse those distributions first
    await as(u.broker, "POST", `/api/deals/${dealId}/closing/void`, { reason: "GCI was keyed wrong" });
    await prisma.transaction.update({ where: { id: dealId }, data: { totalGci: "30000" } });
    const differs = await finalize(dealId);
    assert.equal(differs.statusCode, 422);
    assert.equal(differs.json().error.code, "PRIOR_DISTRIBUTIONS_DIFFER");
  });

  test("no closing distribution until the deposit has cleared the bank", async () => {
    const dealId = await torontoListing({ deposit: 60_000, cleared: false });
    await close(dealId);
    const res = await finalize(dealId);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, "FUNDS_NOT_CLEARED");
    assert.match(res.json().error.message, /only \$0\.00 has been matched to the bank statement/);
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
  test("commission trust account: off until the broker of record enables it; then its own ledger and reconciliation", async () => {
    const dealId = await torontoListing({ deposit: 40_000 });
    await close(dealId);
    assert.equal((await finalize(dealId)).statusCode, 201);
    const cta = (await prisma.trustAccount.create({ data: { name: "Commission Trust", bankName: "TD", accountLast4: "5550", kind: "COMMISSION_TRUST" } })).id;
    const receive = () => as(u.admin, "POST", `/api/deals/${dealId}/closing/commission-received`,
      { amount: "15935.00", receivedDate: "2026-11-30", reference: "WIRE-CTA-9", account: { type: "COMMISSION_TRUST", id: cta } });
    assert.equal((await receive()).json().error.code, "POLICY_NOT_APPROVED");

    const policy = (enabled: boolean) => as(u.broker, "POST", "/api/financial-policies",
      { policy: "COMMISSION_TRUST_ACCOUNT", enabled, reference: "Test: counsel and accountant sign-off" });
    assert.equal((await policy(true)).statusCode, 200);
    try {
      assert.equal((await receive()).statusCode, 201);
      const imported = await as(u.admin, "POST", "/api/bank/statements", {
        accountType: "TRUST", accountId: cta, periodStart: "2026-11-01", periodEnd: "2026-11-30", openingBalance: "0.00",
        closingBalance: "15935.00", receivedDate: "2026-12-01", source: "BANK_PORTAL_DOWNLOAD", fileName: "cta-nov.csv",
        csv: "Date,Description,Amount\n11/30/2026,WIRE IN WIRE-CTA-9,15935.00\n",
      });
      assert.equal(imported.statusCode, 201, imported.body);
      assert.equal(imported.json().autoMatched, 1);
      assert.equal((await as(u.broker, "POST", `/api/bank/statements/${imported.json().id}/verify`, { method: "Checked TD portal" })).statusCode, 200);
      const recon = await as(u.admin, "POST", "/api/trust/reconciliations", { statementId: imported.json().id });
      assert.equal(recon.statusCode, 201, recon.body);
      const r = recon.json();
      assert.deepEqual([r.isBalanced, r.figures.ledgerBalance, r.figures.clientLiabilities], [true, "15935.00", "15935.00"]);
      assert.deepEqual(r.details.deals.map((d: { basis: string; balance: number }) => [d.basis, d.balance]), [["PER_CDA", 1_593_500]]);
      assert.equal((await as(u.broker, "POST", `/api/trust/reconciliations/${r.id}/sign`, {})).json().status, "SIGNED");
    } finally {
      await policy(false);
    }
  });
  test("plans are effective-dated, approved by a second broker, and can't reach back into an issued CDA", async () => {
    let code = "no error";
    try {
      await prisma.$executeRaw`INSERT INTO "CommissionPlan" (id, "userId", "updatedAt") VALUES (gen_random_uuid(), ${u.agent}::uuid, now())`;
    } catch (err) {
      code = fromDatabaseError(err)?.code ?? "other";
    }
    assert.equal(code, "APPEND_ONLY"); // the old one-row plan is history

    const broker2 = (await prisma.user.create({ data: { email: `b2-${randomUUID()}@zareh.test`, firstName: "Second", lastName: "Broker", role: "MANAGING_BROKER" } })).id;
    const propose = (effectiveFrom: string, user = u.broker) => as(user, "POST", `/api/agents/${u.agent}/commission-plans`, {
      effectiveFrom, splitPct: 85, annualCap: "12000", fees: [{ name: "Deal fee", amount: "175.00" }], reason: "2027 plan renewal",
    });
    assert.equal((await propose("2027-01-01", u.agent)).statusCode, 403);
    // Before the agent's issued closings (Nov 30): proposing is fine, approving isn't
    const back = await propose("2026-11-15");
    assert.equal(back.statusCode, 201, back.body);
    const backId = back.json().versions.find((v: { effectiveFrom: string }) => v.effectiveFrom === "2026-11-15").id;
    assert.match((await as(broker2, "POST", `/api/commission-plans/${backId}/approve`, {})).json().error.message, /already issued for a closing on 2026-11-30/);

    const next = await propose("2027-01-01");
    const nextId = next.json().versions.find((v: { effectiveFrom: string }) => v.effectiveFrom === "2027-01-01").id;
    assert.equal((await as(u.broker, "POST", `/api/commission-plans/${nextId}/approve`, {})).statusCode, 403); // proposer can't approve
    const approved = await as(broker2, "POST", `/api/commission-plans/${nextId}/approve`, {});
    assert.equal(approved.statusCode, 200, approved.body);
    const versions = approved.json().versions.map((v: { effectiveFrom: string; status: string }) => [v.effectiveFrom, v.status]);
    assert.deepEqual(versions, [["2020-01-01", "APPROVED"], ["2026-11-15", "PROPOSED"], ["2027-01-01", "APPROVED"]]);
    assert.notEqual(approved.json().inForceToday, nextId); // today is 2026-12-01
    let edit = "no error";
    try {
      await prisma.$executeRaw`UPDATE "CommissionPlanVersion" SET "annualCap" = 1 WHERE id = ${nextId}::uuid`;
    } catch (err) {
      edit = fromDatabaseError(err)?.code ?? "other";
    }
    assert.equal(edit, "APPEND_ONLY");
  });

  test("bonuses, deductions and recoveries: approved by a second person, on the CDA, locked once it's issued", async () => {
    const dealId = await torontoListing({ deposit: 40_000 });
    await close(dealId);
    const recovery = await as(u.broker, "POST", "/api/agent-recoveries", {
      userId: u.agent, amount: "1000.00", reason: "COMMISSION_RECALLED", note: "Deal 2026-0011 commission wire recalled after payout",
    });
    assert.equal(recovery.statusCode, 201, recovery.body);
    const add = (body: object, user = u.admin) => as(user, "POST", `/api/deals/${dealId}/commission-adjustments`, { userId: u.agent, ...body });
    assert.equal((await add({ kind: "BONUS", description: "x", amount: "1.00" }, u.agent)).statusCode, 403);
    await add({ kind: "BONUS", description: "Top producer bonus", amount: "500.00", taxable: true });
    await add({ kind: "DEDUCTION", description: "Feature sheet printing", amount: "100.00", taxable: true });
    const tooMuch = await add({ kind: "RECOVERY", description: "Recalled commission", amount: "1500.00", recoveryId: recovery.json().id });
    assert.match(tooMuch.json().error.message, /more than is still owed/);
    const listed = (await add({ kind: "RECOVERY", description: "Recalled commission (part)", amount: "400.00", recoveryId: recovery.json().id })).json();
    const before = (await as(u.broker, "GET", `/api/deals/${dealId}/closing`)).json().computation.agents[0];
    assert.equal(before.adjustments.length, 0); // not approved yet: not on the CDA
    const approve = (id: string, user = u.broker) => as(user, "POST", `/api/commission-adjustments/${id}/approve`, {});
    assert.equal((await approve(listed[0].id, u.admin)).statusCode, 403);
    for (const a of listed) assert.equal((await approve(a.id)).statusCode, 200);
    const after = (await as(u.broker, "GET", `/api/deals/${dealId}/closing`)).json().computation.agents[0];
    assert.equal(after.payout, before.payout + 56_500 - 11_300 - 40_000);

    assert.equal((await finalize(dealId)).statusCode, 201);
    const locked = await add({ kind: "BONUS", description: "Late bonus", amount: "50.00" });
    assert.match(locked.json().error.message, /CDA is issued; void and reissue/);
    const rec = (await as(u.broker, "GET", `/api/agent-recoveries/${recovery.json().id}`)).json();
    assert.equal(rec.outstanding, "600.00");
    assert.match((await as(u.admin, "POST", `/api/agent-recoveries/${rec.id}/repayments`, { amount: "700.00", paidDate: TODAY, reference: "E-TRANSFER 55" })).json().error.message, /more than is still owed/);
    const repaid = await as(u.admin, "POST", `/api/agent-recoveries/${rec.id}/repayments`, { amount: "600.00", paidDate: TODAY, reference: "E-TRANSFER 55" });
    assert.equal(repaid.json().outstanding, "0.00");
  });

  test("tax follows the property's province and the close date; no rate on file means no CDA", async () => {
    const ns = await torontoListing({});
    await prisma.transaction.update({ where: { id: ns }, data: { province: "NS", city: "Halifax" } });
    const c = (await as(u.broker, "GET", `/api/deals/${ns}/closing`)).json().computation;
    assert.deepEqual([c.hstRate, c.taxName, c.incoming.commission.hst], [1400, "HST", 385_000]);
    const old = await torontoListing({});
    await prisma.transaction.update({ where: { id: old }, data: { province: "BC", closeDate: new Date("2024-06-30") } });
    const res = await as(u.broker, "GET", `/api/deals/${old}/closing`);
    assert.equal(res.json().error.code, "TAX_RATE_UNKNOWN");
  });
});
