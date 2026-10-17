/**
 * Integration tests against a real PostgreSQL database with migrations
 * 001–003 applied. Set DATABASE_URL to run them; they are skipped otherwise.
 *
 * Ledger rows can't be deleted (that's the point), so every test creates its
 * own deal and never cleans up.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type DealStatus, type DepositHolder } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { fromDatabaseError } from "../src/errors.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-10-17";

describe("trust ledger API", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), today: () => TODAY });
  const users = { broker: "", admin: "", reviewer: "", agent: "" };
  let account = "";

  before(async () => {
    const make = async (role: "MANAGING_BROKER" | "ADMIN" | "COMPLIANCE_ADMIN" | "AGENT") =>
      (await prisma.user.create({
        data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: role, lastName: "Test", role },
      })).id;
    users.broker = await make("MANAGING_BROKER");
    users.admin = await make("ADMIN");
    users.reviewer = await make("COMPLIANCE_ADMIN");
    users.agent = await make("AGENT");
    account = (await prisma.trustAccount.create({
      data: { name: "Real Estate Trust", bankName: "TD", accountLast4: "4821" },
    })).id;
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  async function newDeal(opts: { status?: DealStatus; holder?: DepositHolder; deposit?: string } = {}) {
    const deal = await prisma.transaction.create({
      data: {
        dealNumber: `T-${randomUUID().slice(0, 8)}`,
        side: "LISTING",
        status: opts.status ?? "FIRM",
        streetAddress: "88 Queens Quay W",
        city: "Toronto",
        salePrice: "1100000",
        offerDate: new Date("2026-10-01"),
        closeDate: new Date("2026-11-30"),
        depositAmount: opts.deposit ?? "40000",
        trustDepositHolder: opts.holder ?? "OUR_BROKERAGE",
        totalGci: "27500",
      },
    });
    return deal.id;
  }

  function post(url: string, body: unknown, user = users.broker, key: string = randomUUID()) {
    return app.inject({ method: "POST", url, payload: body as object, headers: { "x-user-id": user, "idempotency-key": key } });
  }

  const depositBody = (dealId: string, amount = "40000.00", extra: object = {}) => ({
    dealId,
    trustAccountId: account,
    amount,
    method: "BANK_DRAFT",
    dateReceived: "2026-10-14",
    dateDeposited: "2026-10-15",
    payorName: "John Buyer",
    bankReference: "TD-DRAFT-55821",
    ...extra,
  });

  const payoutBody = (dealId: string, amount: string, extra: object = {}) => ({
    dealId,
    trustAccountId: account,
    amount,
    method: "EFT",
    dateDisbursed: "2026-10-16",
    payeeType: "OUR_BROKERAGE",
    payeeName: "Zareh Homes Brokerage (general account)",
    authorizationMethod: "CLOSING_COMPLETED",
    ...extra,
  });

  async function balance(dealId: string): Promise<string> {
    const res = await app.inject({ method: "GET", url: `/api/deals/${dealId}/trust`, headers: { "x-user-id": users.broker } });
    return res.json().balances[0]?.balance ?? "0.00";
  }

  // ── 1. Deposits ────────────────────────────────────────────────────────────

  test("deposit: receipted, numbered, timestamped to the microsecond, signed by the broker", async () => {
    const dealId = await newDeal();
    const res = await post("/api/trust/deposits", depositBody(dealId));
    assert.equal(res.statusCode, 201, res.body);
    const { entry, dealBalance, warnings } = res.json();
    assert.equal(entry.entryType, "DEPOSIT_RECEIVED");
    assert.equal(entry.direction, 1);
    assert.equal(entry.amount, "40000.00");
    assert.equal(typeof entry.receiptNumber, "number");
    assert.equal(entry.receivedDate, "2026-10-14");
    assert.equal(entry.effectiveDate, "2026-10-15");
    assert.equal(entry.referenceNo, "TD-DRAFT-55821");
    assert.equal(entry.authorizedById, users.broker);
    assert.match(entry.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    assert.equal(dealBalance, "40000.00");
    assert.deepEqual(warnings, []);
    const deal = await prisma.transaction.findUniqueOrThrow({ where: { id: dealId } });
    assert.equal(deal.depositStatus, "RECEIVED");
  });

  test("deposit: receipt numbers are sequential with no gaps", async () => {
    const dealId = await newDeal({ deposit: "60000" });
    const a = (await post("/api/trust/deposits", depositBody(dealId, "20000.00"))).json().entry.receiptNumber;
    const b = (await post("/api/trust/deposits", depositBody(dealId, "20000.00"))).json().entry.receiptNumber;
    assert.equal(b, a + 1);
  });

  test("deposit: refused when the deal says someone else holds the deposit", async () => {
    const dealId = await newDeal({ holder: "COOP_BROKERAGE" });
    const res = await post("/api/trust/deposits", depositBody(dealId));
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, "DEPOSIT_NOT_HELD_BY_BROKERAGE");
  });

  test("deposit: late deposit and over-deposit are recorded with warnings", async () => {
    const dealId = await newDeal({ deposit: "10000" });
    const res = await post("/api/trust/deposits", depositBody(dealId, "15000.00", { dateReceived: "2026-10-05", dateDeposited: "2026-10-15" }));
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(res.json().warnings, ["DEPOSITED_AFTER_5_BUSINESS_DAYS", "EXCEEDS_EXPECTED_DEPOSIT"]);
  });

  test("deposit: only a managing broker can receipt trust funds; bad input is a 400", async () => {
    const dealId = await newDeal();
    assert.equal((await post("/api/trust/deposits", depositBody(dealId), users.admin)).statusCode, 403);
    assert.equal((await post("/api/trust/deposits", depositBody(dealId), users.agent)).statusCode, 403);
    const noUser = await app.inject({ method: "POST", url: "/api/trust/deposits", payload: depositBody(dealId) });
    assert.equal(noUser.statusCode, 401);
    const bad = await post("/api/trust/deposits", depositBody(dealId, "40000.00", { method: "CHEQUE" }));
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error.code, "VALIDATION_FAILED");
    const noKey = await app.inject({ method: "POST", url: "/api/trust/deposits", payload: depositBody(dealId), headers: { "x-user-id": users.broker } });
    assert.equal(noKey.statusCode, 400);
  });

  // ── 2 + 3. Disbursements and per-deal segregation ──────────────────────────

  test("disbursement: more than the deal holds is a hard InsufficientTrustFunds error", async () => {
    const dealId = await newDeal({ status: "CLOSED" });
    await post("/api/trust/deposits", depositBody(dealId));
    const res = await post("/api/trust/disbursements", payoutBody(dealId, "40000.01"));
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json().error, {
      code: "INSUFFICIENT_TRUST_FUNDS",
      message: `Deal ${dealId} holds $40000.00 in trust; $40000.01 was requested`,
      details: { dealId, available: "40000.00", requested: "40000.01" },
    });
    assert.equal(await balance(dealId), "40000.00");
  });

  test("segregation: one deal can't be paid from another deal's money in the same account", async () => {
    const funded = await newDeal({ status: "CLOSED" });
    const empty = await newDeal({ status: "CLOSED" });
    await post("/api/trust/deposits", depositBody(funded));
    const res = await post("/api/trust/disbursements", payoutBody(empty, "1.00"));
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.details.available, "0.00");
  });

  test("disbursement: 'closing' authority needs a CLOSED deal; full release marks the deposit RELEASED", async () => {
    const dealId = await newDeal({ status: "FIRM" });
    await post("/api/trust/deposits", depositBody(dealId));
    const early = await post("/api/trust/disbursements", payoutBody(dealId, "27500.00"));
    assert.equal(early.statusCode, 422);
    assert.equal(early.json().error.code, "DEAL_NOT_CLOSED");

    await prisma.transaction.update({ where: { id: dealId }, data: { status: "CLOSED" } });
    const commission = await post("/api/trust/disbursements", payoutBody(dealId, "27500.00"));
    assert.equal(commission.statusCode, 201, commission.body);
    assert.equal(commission.json().entry.entryType, "DISBURSEMENT_TO_GENERAL");
    assert.equal(commission.json().entry.direction, -1);
    assert.equal(commission.json().dealBalance, "12500.00");

    const lawyer = await post("/api/trust/disbursements", payoutBody(dealId, "12500.00", {
      payeeType: "LAWYER", payeeName: "Smith LLP in trust", method: "WIRE",
    }));
    assert.equal(lawyer.statusCode, 201, lawyer.body);
    assert.equal(lawyer.json().entry.entryType, "DISBURSEMENT_TO_LAWYER");
    assert.equal(lawyer.json().dealBalance, "0.00");
    const deal = await prisma.transaction.findUniqueOrThrow({ where: { id: dealId } });
    assert.equal(deal.depositStatus, "RELEASED");
  });

  test("concurrency: three simultaneous $15k payouts against $40k — exactly two succeed", async () => {
    const dealId = await newDeal({ status: "CLOSED" });
    await post("/api/trust/deposits", depositBody(dealId));
    const results = await Promise.all(
      [1, 2, 3].map(() => post("/api/trust/disbursements", payoutBody(dealId, "15000.00"))),
    );
    const codes = results.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [201, 201, 409]);
    assert.equal(await balance(dealId), "10000.00");
  });

  test("idempotency: a retried payout is returned, not paid twice; a reused key with new data is refused", async () => {
    const dealId = await newDeal({ status: "CLOSED" });
    await post("/api/trust/deposits", depositBody(dealId));
    const key = randomUUID();
    const first = await post("/api/trust/disbursements", payoutBody(dealId, "5000.00"), users.broker, key);
    const retry = await post("/api/trust/disbursements", payoutBody(dealId, "5000.00"), users.broker, key);
    assert.equal(first.statusCode, 201);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().replayed, true);
    assert.equal(retry.json().entry.id, first.json().entry.id);
    assert.equal(await balance(dealId), "35000.00");

    const reused = await post("/api/trust/disbursements", payoutBody(dealId, "9000.00"), users.broker, key);
    assert.equal(reused.statusCode, 409);
    assert.equal(reused.json().error.code, "IDEMPOTENCY_KEY_REUSED");
  });

  // ── 4. Disputed / unclaimed holds ──────────────────────────────────────────

  test("hold: a disputed deposit blocks every payout until a broker releases it", async () => {
    const dealId = await newDeal({ status: "FIRM" });
    const depositId = (await post("/api/trust/deposits", depositBody(dealId))).json().entry.id;
    await prisma.transaction.update({ where: { id: dealId }, data: { status: "COLLAPSED" } });

    const holdUrl = `/api/deals/${dealId}/trust/holds`;
    const holdBody = { reason: "DISPUTED", note: "Buyer walked; seller won't sign the mutual release", depositEntryId: depositId };
    assert.equal((await post(holdUrl, holdBody, users.agent)).statusCode, 403);
    const flagged = await post(holdUrl, holdBody, users.reviewer);
    assert.equal(flagged.statusCode, 201, flagged.body);
    const hold = flagged.json();
    assert.equal(hold.active, true);
    assert.match(hold.flaggedAt, /\.\d{6}Z$/);
    assert.equal((await post(holdUrl, holdBody, users.admin)).statusCode, 409); // one active hold per deal

    const refund = payoutBody(dealId, "40000.00", {
      payeeType: "PAYOR_REFUND", payeeName: "John Buyer",
      authorizationMethod: "MUTUAL_RELEASE", authorizationReference: "Mutual release signed 2026-10-16",
    });
    const blocked = await post("/api/trust/disbursements", refund);
    assert.equal(blocked.statusCode, 423);
    assert.equal(blocked.json().error.code, "TRUST_HOLD_ACTIVE");

    const releaseUrl = `/api/trust/holds/${hold.id}/release`;
    assert.equal((await post(releaseUrl, { releaseNote: "Release signed" }, users.admin)).statusCode, 403);
    const released = await post(releaseUrl, { releaseNote: "Signed mutual release received 2026-10-16" });
    assert.equal(released.statusCode, 200, released.body);
    assert.equal(released.json().active, false);
    assert.equal(released.json().releasedById, users.broker);
    assert.equal((await post(releaseUrl, { releaseNote: "again" })).statusCode, 409);

    const paid = await post("/api/trust/disbursements", refund);
    assert.equal(paid.statusCode, 201, paid.body);
    assert.equal(paid.json().entry.entryType, "REFUND_TO_PAYER");
    const deal = await prisma.transaction.findUniqueOrThrow({ where: { id: dealId } });
    assert.equal(deal.depositStatus, "REFUNDED");
  });

  // ── 5. Immutability and reversals ──────────────────────────────────────────

  test("reversal: corrects by adding a row; can't be repeated, reversed, or overdraw the deal", async () => {
    const dealId = await newDeal({ status: "CLOSED" });
    const deposit = (await post("/api/trust/deposits", depositBody(dealId))).json().entry;
    const payout = (await post("/api/trust/disbursements", payoutBody(dealId, "30000.00"))).json().entry;

    // Pulling the $40k deposit back out would leave the deal at −$30k
    const overdraw = await post(`/api/trust/entries/${deposit.id}/reversals`, { reason: "Draft returned NSF" });
    assert.equal(overdraw.statusCode, 409);
    assert.equal(overdraw.json().error.code, "INSUFFICIENT_TRUST_FUNDS");

    const fixPayout = await post(`/api/trust/entries/${payout.id}/reversals`, { reason: "Wrong amount keyed" });
    assert.equal(fixPayout.statusCode, 201, fixPayout.body);
    assert.equal(fixPayout.json().entry.direction, 1);
    assert.equal(fixPayout.json().entry.reversesEntryId, payout.id);
    assert.equal(fixPayout.json().dealBalance, "40000.00");

    const again = await post(`/api/trust/entries/${payout.id}/reversals`, { reason: "again" });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, "ALREADY_REVERSED");
    const ofReversal = await post(`/api/trust/entries/${fixPayout.json().entry.id}/reversals`, { reason: "undo" });
    assert.equal(ofReversal.statusCode, 422);

    // The original rows are untouched
    const ledger = await app.inject({ method: "GET", url: `/api/deals/${dealId}/trust`, headers: { "x-user-id": users.broker } });
    assert.deepEqual(
      ledger.json().entries.map((e: { entryType: string; runningBalance: string }) => [e.entryType, e.runningBalance]),
      [["DEPOSIT_RECEIVED", "40000.00"], ["DISBURSEMENT_TO_GENERAL", "10000.00"], ["REVERSAL", "40000.00"]],
    );
  });

  test("immutability: the API has no way to edit or delete an entry", async () => {
    const dealId = await newDeal();
    const id = (await post("/api/trust/deposits", depositBody(dealId))).json().entry.id;
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url: `/api/trust/entries/${id}`, headers: { "x-user-id": users.broker }, payload: {} });
      assert.equal(res.statusCode, 405);
      assert.equal(res.json().error.code, "TRUST_LEDGER_IMMUTABLE");
    }
  });

  test("immutability: the database itself rejects UPDATE, DELETE, TRUNCATE and rogue inserts", async () => {
    const dealId = await newDeal();
    const id = (await post("/api/trust/deposits", depositBody(dealId))).json().entry.id;
    const dbCode = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        return fromDatabaseError(err)?.code;
      }
      return "no error";
    };

    assert.equal(await dbCode(() => prisma.$executeRaw`UPDATE "TrustLedgerEntry" SET amount = 1 WHERE id = ${id}::uuid`), "TRUST_LEDGER_IMMUTABLE");
    assert.equal(await dbCode(() => prisma.$executeRaw`DELETE FROM "TrustLedgerEntry" WHERE id = ${id}::uuid`), "TRUST_LEDGER_IMMUTABLE");
    assert.equal(await dbCode(() => prisma.$executeRaw`TRUNCATE "TrustLedgerEntry" CASCADE`), "TRUST_LEDGER_IMMUTABLE");

    const rogue = (authorizedBy: string, amount: string) => prisma.$executeRaw`
      INSERT INTO "TrustLedgerEntry" (id, "trustAccountId", "transactionId", "entryType", amount, method, counterparty,
        "effectiveDate", "authorizationMethod", "idempotencyKey", "enteredById", "authorizedById")
      VALUES (gen_random_uuid(), ${account}::uuid, ${dealId}::uuid, 'DISBURSEMENT_TO_COOP', ${amount}::numeric, 'EFT',
        'Someone', '2026-10-16', 'CLOSING_COMPLETED', gen_random_uuid(), ${authorizedBy}::uuid, ${authorizedBy}::uuid)`;
    assert.equal(await dbCode(() => rogue(users.agent, "1.00")), "FORBIDDEN");               // not a broker
    assert.equal(await dbCode(() => rogue(users.broker, "40000.01")), "INSUFFICIENT_TRUST_FUNDS"); // overdraw
    assert.equal(await balance(dealId), "40000.00");
  });

  test("ledger view: agents see only their own deals", async () => {
    const dealId = await newDeal();
    await post("/api/trust/deposits", depositBody(dealId));
    const asAgent = () => app.inject({ method: "GET", url: `/api/deals/${dealId}/trust`, headers: { "x-user-id": users.agent } });
    assert.equal((await asAgent()).statusCode, 403);
    await prisma.transactionAgent.create({
      data: { transactionId: dealId, userId: users.agent, splitPct: "80", grossShare: "22000", netPayout: "21800" },
    });
    const res = await asAgent();
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().balances[0].balance, "40000.00");
    assert.equal(res.json().activeHold, null);
  });
});
