/**
 * Money controls after review: interim bank evidence, available funds,
 * simultaneous approvals and payments, segregation of duties and its
 * policy-gated exception, third-party payables, broker-of-record checks, and
 * the restricted database role. Policies are global, so every test that
 * switches one lives in this file and switches it back. Needs DATABASE_URL
 * with migrations 001–009; skipped otherwise.
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
const TODAY = "2026-12-10";
const pgCode = (err: unknown) => (err as { meta?: { code?: string }; code?: string }).meta?.code ?? (err as { code?: string }).code;

describe("money controls", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { broker: "", broker2: "", plainBroker: "", admin: "", admin2: "", agent: "" };

  const as = (user: string, method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user, "idempotency-key": randomUUID() }, ...(body ? { payload: body } : {}) });

  const operatingAccount = async () =>
    (await prisma.operatingAccount.create({ data: { name: `General ${randomUUID().slice(0, 4)}`, bankName: "TD", accountLast4: "1177" } })).id;

  /** A finalized closing seeded directly: what's due from the payer, one agent payout, optional third-party payables. */
  async function seededClosing(opts: { due: string; payout: string; payables?: { type: "COOP_BROKERAGE" | "REFERRAL"; amount: string }[] }) {
    const deal = await prisma.transaction.create({
      data: {
        dealNumber: `MC-${randomUUID().slice(0, 8)}`, side: "LISTING", status: "CLOSED", streetAddress: "1 King St", city: "Hamilton",
        salePrice: "800000", offerDate: new Date("2026-10-01"), closeDate: new Date("2026-12-05"), depositAmount: "0",
        trustDepositHolder: "COOP_BROKERAGE", totalGci: "20000",
      },
    });
    const dueCents = Math.round(Number(opts.due) * 100);
    const [closing] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "ClosingStatement" (id, "transactionId", "cdaNumber", computation, "computationSha", "lawyerHtml", "internalHtml",
                                      "idempotencyKey", "finalizedById")
      VALUES (gen_random_uuid(), ${deal.id}::uuid, ${`CDA-${deal.dealNumber}`}, ${JSON.stringify({ wiresTotal: dueCents })}::jsonb, 'x', '', '',
              gen_random_uuid(), ${u.broker}::uuid)
      RETURNING id::text`;
    const [payout] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "ClosingAgentPayout" (id, "closingId", "userId", "closeDate", "payeeName", "allocatedBaseGci", "houseSplitBase",
        "agentSplitBase", "agentSplitHst", "feesBase", "feesHst", "netPayout", "wiredByLawyer", "paidByBrokerage")
      VALUES (gen_random_uuid(), ${closing!.id}::uuid, ${u.agent}::uuid, '2026-12-05', 'Ava Agent', 20000, 4000, 16000, 0, 0, 0,
              ${opts.payout}::numeric, 0, ${opts.payout}::numeric)
      RETURNING id::text`;
    const payables: string[] = [];
    for (const q of opts.payables ?? []) {
      const [row] = await prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO "ClosingPayable" (id, "closingId", "payeeType", "payeeName", amount, hst)
        VALUES (gen_random_uuid(), ${closing!.id}::uuid, ${q.type}::"PayableType", 'Harbourfront Realty Inc.', ${q.amount}::numeric, 0)
        RETURNING id::text`;
      payables.push(row!.id);
    }
    return { dealId: deal.id, closingId: closing!.id, payoutId: payout!.id, payables };
  }

  const receive = (dealId: string, amount: string, account: string, user = u.admin, reference = `WIRE-${randomUUID().slice(0, 6)}`, receivedDate = TODAY) =>
    as(user, "POST", `/api/deals/${dealId}/closing/commission-received`,
      { amount, receivedDate, reference, account: { type: "OPERATING", id: account } });

  /** Today's activity and balance from the bank portal, imported by one person and verified by another. */
  async function interim(account: string, balance: string, lines: [string, string][], opts: { importer?: string; verifier?: string; asOf?: string } = {}) {
    const asOf = opts.asOf ?? TODAY;
    const csv = "Date,Description,Amount\n" + lines.map(([desc, amt]) => `${asOf},${desc},${amt}`).join("\n") + "\n";
    const res = await as(opts.importer ?? u.admin, "POST", "/api/bank/statements", {
      kind: "INTERIM", accountType: "OPERATING", accountId: account, periodStart: asOf, periodEnd: asOf, closingBalance: balance,
      receivedDate: asOf, source: "BANK_PORTAL_DOWNLOAD", fileName: `activity-${randomUUID().slice(0, 4)}.csv`, csv,
    });
    assert.equal(res.statusCode, 201, res.body);
    if (opts.verifier !== null) {
      const v = await as(opts.verifier ?? u.admin2, "POST", `/api/bank/statements/${res.json().id}/verify`, { method: "Checked in TD EasyLine" });
      assert.equal(v.statusCode, 200, v.body);
    }
    return res.json();
  }

  const setPolicy = (policy: string, enabled: boolean, user = u.broker) =>
    as(user, "POST", "/api/financial-policies", { policy, enabled, reference: "Test sign-off" });

  before(async () => {
    const make = async (role: UserRole, first: string) =>
      (await prisma.user.create({ data: { email: `${first.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: first, lastName: "Test", role } })).id;
    u.broker = await make("MANAGING_BROKER", "Brook");
    u.broker2 = await make("MANAGING_BROKER", "Bea");
    u.plainBroker = await make("MANAGING_BROKER", "Pat");
    u.admin = await make("ADMIN", "Ada");
    u.admin2 = await make("ADMIN", "Abe");
    u.agent = await make("AGENT", "Ava");
    await designateBroker(app, prisma, u.broker);
    await designateBroker(app, prisma, u.broker2);
  });

  after(async () => {
    await setPolicy("SOLE_OPERATOR_EXCEPTION", false);
    await setPolicy("THIRD_PARTY_PAYABLES", false);
    await app.close();
    await prisma.$disconnect();
  });

  test("broker of record: a designation is recorded by someone else, and only the designee can act as broker of record", async () => {
    const self = await as(u.plainBroker, "POST", "/api/broker-of-record",
      { userId: u.plainBroker, role: "DESIGNATED_SUBSTITUTE", effectiveFrom: "2026-01-01", reference: "self" });
    assert.equal(self.statusCode, 403);
    assert.match(self.json().error.message, /someone else must record your designation/);
    const agent = await as(u.admin, "POST", "/api/broker-of-record",
      { userId: u.agent, role: "DESIGNATED_SUBSTITUTE", effectiveFrom: "2026-01-01", reference: "x" });
    assert.match(agent.json().error.message, /only an active broker can be designated/);

    // A managing broker who isn't broker of record can't change policy or attest history
    assert.equal((await setPolicy("SOLE_OPERATOR_EXCEPTION", true, u.plainBroker)).statusCode, 403);
    assert.equal((await setPolicy("SOLE_OPERATOR_EXCEPTION", true, u.admin)).statusCode, 403);
    const policies = (await as(u.admin, "GET", "/api/financial-policies")).json().policies;
    assert.deepEqual(policies.map((p: { policy: string; enabled: boolean }) => [p.policy, p.enabled]),
      [["SOLE_OPERATOR_EXCEPTION", false], ["THIRD_PARTY_PAYABLES", false]]);
  });

  test("interim bank record: commission verified the day it lands; overlapping files never double-count a line", async () => {
    const account = await operatingAccount();
    const c = await seededClosing({ due: "31075.00", payout: "24634.00" });
    await receive(c.dealId, "31075.00", account, u.admin, "WIRE-PATEL-91");

    const first = await interim(account, "31075.00", [["WIRE IN PATEL LAW WIRE-PATEL-91", "31075.00"]]);
    assert.equal(first.autoMatched, 1);
    assert.equal(first.kind, "INTERIM");

    // The afternoon download repeats the morning's wire and adds a new item
    const second = await interim(account, "31175.00", [["WIRE IN PATEL LAW WIRE-PATEL-91", "31075.00"], ["DEPOSIT", "100.00"]]);
    assert.equal(second.duplicatesSkipped, 1);
    assert.equal(second.lines.length, 1);

    const view = (await as(u.broker, "GET", `/api/deals/${c.dealId}/closing/payouts`)).json();
    assert.equal(view.payouts[0].status, "READY_FOR_APPROVAL");
    const approved = await as(u.broker, "POST", `/api/payouts/${c.payoutId}/approve`, {});
    assert.equal(approved.statusCode, 200, approved.body);
    const ev = await prisma.payoutEvent.findFirstOrThrow({ where: { payoutId: c.payoutId, kind: "APPROVED" } });
    assert.equal(ev.balanceStatementId, second.id); // the newest verified balance
  });

  test("available funds: the balance must be fresh, and approvals can't commit more than the account holds", async () => {
    const account = await operatingAccount();
    const a = await seededClosing({ due: "15000.00", payout: "15000.00" });
    const b = await seededClosing({ due: "15000.00", payout: "15000.00" });
    await receive(a.dealId, "15000.00", account, u.admin, "WIRE-A", "2026-12-03");
    await receive(b.dealId, "15000.00", account, u.admin, "WIRE-B", "2026-12-03");

    // A balance from a week ago doesn't show what's there today
    await interim(account, "30000.00", [["WIRE IN WIRE-A", "15000.00"], ["WIRE IN WIRE-B", "15000.00"]], { asOf: "2026-12-03" });
    const stale = await as(u.broker, "POST", `/api/payouts/${a.payoutId}/approve`, {});
    assert.equal(stale.json().error.code, "FUNDS_NOT_AVAILABLE");
    assert.match(stale.json().error.message, /latest verified balance is from 2026-12-03/);

    // Today the brokerage has spent $10,000 of it on other things: only one $15,000 payout fits, even approved at the same moment
    await interim(account, "20000.00", [["RENT", "-10000.00"]]);
    const results = await Promise.all([a, b].map((x) => as(u.broker, "POST", `/api/payouts/${x.payoutId}/approve`, {})));
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    assert.match(results.find((r) => r.statusCode === 409)!.json().error.message, /5000\.00 is available in the paying account/);
  });

  test("simultaneous duplicate payment records: exactly one is accepted", async () => {
    const account = await operatingAccount();
    const c = await seededClosing({ due: "5000.00", payout: "5000.00" });
    await receive(c.dealId, "5000.00", account, u.admin, "WIRE-D");
    await interim(account, "5000.00", [["WIRE IN WIRE-D", "5000.00"]]);
    assert.equal((await as(u.broker, "POST", `/api/payouts/${c.payoutId}/approve`, {})).statusCode, 200);
    const results = await Promise.all([1, 2].map((n) =>
      as(u.admin, "POST", `/api/payouts/${c.payoutId}/paid`, { paidDate: TODAY, reference: `EFT-${n}` })));
    // One wins; the other is refused by the API's check or, if it got past it, by the database's state machine
    const codes = results.map((r) => r.statusCode).sort();
    assert.equal(codes[0], 200);
    assert.ok([409, 422].includes(codes[1]!), `second payment record was ${codes[1]}`);
    assert.equal(await prisma.payoutEvent.count({ where: { payoutId: c.payoutId, kind: "PAID" } }), 1);
  });

  test("segregation of duties: whoever recorded the commission can't approve it, unless the sole-operator exception is signed off", async () => {
    const account = await operatingAccount();
    const c = await seededClosing({ due: "8000.00", payout: "6000.00" });
    await receive(c.dealId, "8000.00", account, u.broker, "WIRE-S"); // the broker recorded it
    await interim(account, "8000.00", [["WIRE IN WIRE-S", "8000.00"]]);

    const refused = await as(u.broker, "POST", `/api/payouts/${c.payoutId}/approve`, {});
    assert.equal(refused.statusCode, 403);
    assert.match(refused.json().error.message, /different person/);

    assert.equal((await setPolicy("SOLE_OPERATOR_EXCEPTION", true)).statusCode, 200);
    try {
      const noReason = await as(u.broker, "POST", `/api/payouts/${c.payoutId}/approve`, {});
      assert.equal(noReason.statusCode, 403); // the exception still needs a reason on every use
      const ok = await as(u.broker, "POST", `/api/payouts/${c.payoutId}/approve`, { exceptionReason: "Only broker on site this week" });
      assert.equal(ok.statusCode, 200, ok.body);
      const ev = await prisma.payoutEvent.findFirstOrThrow({ where: { payoutId: c.payoutId, kind: "APPROVED" } });
      assert.deepEqual([ev.segregationException, ev.exceptionReason], [true, "Only broker on site this week"]);
    } finally {
      await setPolicy("SOLE_OPERATOR_EXCEPTION", false);
    }
    // Back off: a different person must record the payment
    assert.equal((await as(u.broker, "POST", `/api/payouts/${c.payoutId}/paid`, { paidDate: TODAY, reference: "EFT-S" })).statusCode, 403);
    assert.equal((await as(u.admin, "POST", `/api/payouts/${c.payoutId}/paid`, { paidDate: TODAY, reference: "EFT-S" })).statusCode, 200);
  });

  test("co-op and referral payables stay disabled until counsel and the accountant sign off", async () => {
    const account = await operatingAccount();
    const c = await seededClosing({ due: "30000.00", payout: "4000.00", payables: [{ type: "COOP_BROKERAGE", amount: "24860.00" }] });
    await receive(c.dealId, "30000.00", account, u.admin, "WIRE-C");
    await interim(account, "30000.00", [["WIRE IN WIRE-C", "30000.00"]]);

    const view = (await as(u.broker, "GET", `/api/deals/${c.dealId}/closing/payouts`)).json();
    const coop = view.payouts.find((p: { kind: string }) => p.kind === "COOP_BROKERAGE");
    assert.deepEqual([coop.status, coop.remaining], ["AWAITING_POLICY_APPROVAL", "24860.00"]);
    assert.equal((await as(u.broker, "POST", `/api/payables/${c.payables[0]}/approve`, {})).json().error.code, "POLICY_NOT_APPROVED");
    let code: string | undefined;
    try {
      await prisma.$executeRaw`INSERT INTO "PayoutEvent" (id, "payableId", seq, kind, "actorId", "eventDate", "payFromOperatingAccountId")
        VALUES (gen_random_uuid(), ${c.payables[0]}::uuid, 0, 'APPROVED', ${u.broker}::uuid, ${TODAY}::date, ${account}::uuid)`;
    } catch (err) {
      code = pgCode(err);
    }
    assert.equal(code, "ZP001", "the database refuses it too");

    assert.equal((await setPolicy("THIRD_PARTY_PAYABLES", true)).statusCode, 200);
    try {
      const ok = await as(u.broker, "POST", `/api/payables/${c.payables[0]}/approve`, {});
      assert.equal(ok.statusCode, 200, ok.body);
      const paid = await as(u.admin, "POST", `/api/payables/${c.payables[0]}/paid`, { paidDate: TODAY, reference: "EFT-COOP" });
      assert.equal(paid.json().payouts.find((p: { kind: string }) => p.kind === "COOP_BROKERAGE").status, "PAID");
    } finally {
      await setPolicy("THIRD_PARTY_PAYABLES", false);
    }
  });

  test("restricted database role: no editing history, no disabling triggers, no bypassing the rules", async () => {
    const attempts: [string, string][] = [
      ["update the trust ledger", `UPDATE "TrustLedgerEntry" SET amount = 1`],
      ["delete payout history", `DELETE FROM "PayoutEvent"`],
      ["truncate bank statements", `TRUNCATE "BankStatement"`],
      ["disable the trust triggers", `ALTER TABLE "TrustLedgerEntry" DISABLE TRIGGER ALL`],
      ["switch triggers off for the session", `SET session_replication_role = replica`],
      ["rewrite a reconciliation's figures", `UPDATE "TrustReconciliation" SET difference = 0`],
      ["edit a policy decision", `UPDATE "FinancialPolicyDecision" SET enabled = true`],
    ];
    for (const [what, sql] of attempts) {
      let code: string | undefined;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL ROLE zareh_app");
          await tx.$executeRawUnsafe(sql);
        });
      } catch (err) {
        code = pgCode(err);
      }
      assert.equal(code, "42501", `the app role must not be able to ${what}`);
    }
  });

  test("restricted database role: the application works end to end as zareh_app", async () => {
    await prisma.$executeRawUnsafe(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zareh_app_test') THEN CREATE ROLE zareh_app_test LOGIN IN ROLE zareh_app; END IF;
    END $$`);
    const url = new URL(process.env.DATABASE_URL!);
    url.username = "zareh_app_test";
    url.password = "";
    const restricted = new PrismaClient({ datasourceUrl: url.toString() });
    const appAsRole = buildApp({ prisma: restricted, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
    const call = (user: string, method: "GET" | "POST", path: string, body?: object) =>
      appAsRole.inject({ method, url: path, headers: { "x-user-id": user, "idempotency-key": randomUUID() }, ...(body ? { payload: body } : {}) });
    try {
      const [{ current_user: who }] = await restricted.$queryRaw<{ current_user: string }[]>`SELECT current_user`;
      assert.equal(who, "zareh_app_test");
      const trust = (await prisma.trustAccount.create({ data: { name: `Role test ${randomUUID().slice(0, 4)}`, bankName: "TD", accountLast4: "4821" } })).id;
      const deal = (await prisma.transaction.create({
        data: {
          dealNumber: `RT-${randomUUID().slice(0, 8)}`, side: "LISTING", status: "FIRM", streetAddress: "5 Bay St", city: "Toronto",
          salePrice: "900000", offerDate: new Date("2026-10-01"), closeDate: new Date("2026-11-20"), depositAmount: "10000",
          trustDepositHolder: "OUR_BROKERAGE", totalGci: "20000",
        },
      })).id;
      const dep = await call(u.broker, "POST", "/api/trust/deposits", {
        dealId: deal, trustAccountId: trust, amount: "10000.00", method: "WIRE", dateReceived: "2026-11-02", dateDeposited: "2026-11-02",
        payorName: "Bo Kim", bankReference: "W-77",
      });
      assert.equal(dep.statusCode, 201, dep.body);
      const stmt = await call(u.admin, "POST", "/api/bank/statements", {
        accountType: "TRUST", accountId: trust, periodStart: "2026-11-01", periodEnd: "2026-11-30", openingBalance: "0.00",
        closingBalance: "10000.00", receivedDate: "2026-12-02", source: "BANK_PORTAL_DOWNLOAD", fileName: "t.csv",
        csv: "Date,Description,Reference,Amount\n11/02/2026,WIRE IN,W-77,10000.00\n",
      });
      assert.equal(stmt.statusCode, 201, stmt.body);
      assert.equal((await call(u.broker, "POST", `/api/bank/statements/${stmt.json().id}/verify`, { method: "TD portal" })).statusCode, 200);
      const recon = await call(u.admin, "POST", "/api/trust/reconciliations", { statementId: stmt.json().id });
      assert.equal(recon.statusCode, 201, recon.body);
      const signed = await call(u.broker, "POST", `/api/trust/reconciliations/${recon.json().id}/sign`, {});
      assert.equal(signed.statusCode, 200, signed.body);
      assert.equal(signed.json().status, "SIGNED");
      await prisma.transaction.update({ where: { id: deal }, data: { status: "COLLAPSED" } });
      const refund = await call(u.broker, "POST", "/api/trust/disbursements", {
        dealId: deal, trustAccountId: trust, amount: "10000.00", method: "WIRE", dateDisbursed: "2026-12-05", payeeType: "PAYOR_REFUND",
        payeeName: "Bo Kim", authorizationMethod: "MUTUAL_RELEASE", authorizationReference: "Mutual release 2026-12-04",
      });
      assert.equal(refund.statusCode, 201, refund.body);
    } finally {
      await appAsRole.close();
      await restricted.$disconnect();
    }
  });
});
