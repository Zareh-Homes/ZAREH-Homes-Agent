/**
 * Bank statements, cleared funds and monthly reconciliation, end to end:
 * two months of a trust account through the API. Needs DATABASE_URL with
 * migrations 001–008; skipped otherwise.
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
const TODAY = "2026-12-15";

describe("bank reconciliation API", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { broker: "", admin: "", agent: "" };
  const deal = { a: "", b: "" };
  const entry = { depositA: "", depositB: "" };
  const recon = { october: "", novemberFirst: "", november: "", incident: "" };
  let account = "";

  const as = (user: string, method: "GET" | "POST" | "DELETE", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user, "idempotency-key": randomUUID() }, ...(body ? { payload: body } : {}) });

  async function newDeal(deposit: string) {
    return (await prisma.transaction.create({
      data: {
        dealNumber: `B-${randomUUID().slice(0, 8)}`, side: "LISTING", status: "FIRM", streetAddress: "12 Lakeshore Rd", city: "Oakville",
        salePrice: "1000000", offerDate: new Date("2026-10-01"), closeDate: new Date("2026-11-20"), depositAmount: deposit,
        trustDepositHolder: "OUR_BROKERAGE", totalGci: "25000",
      },
    })).id;
  }

  async function deposit(dealId: string, amount: string, received: string, deposited: string, bankReference: string) {
    const res = await as(u.broker, "POST", "/api/trust/deposits", {
      dealId, trustAccountId: account, amount, method: "BANK_DRAFT", dateReceived: received, dateDeposited: deposited,
      payorName: "Bo Kim", bankReference,
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json().entry.id as string;
  }

  const payout = (dealId: string, amount: string, date: string, extra: object = {}) => as(u.broker, "POST", "/api/trust/disbursements", {
    dealId, trustAccountId: account, amount, method: "EFT", dateDisbursed: date, payeeType: "OUR_BROKERAGE",
    payeeName: "Test Brokerage Inc. (general account)", authorizationMethod: "CLOSING_COMPLETED", ...extra,
  });

  // Statements arrive three days after the period ends
  const received = (periodEnd: string) => new Date(Date.parse(`${periodEnd}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10);
  const statement = (period: [string, string], opening: string, closing: string, csv: string, user = u.admin) =>
    as(user, "POST", "/api/bank/statements", {
      accountType: "TRUST", accountId: account, periodStart: period[0], periodEnd: period[1],
      openingBalance: opening, closingBalance: closing, receivedDate: received(period[1]), source: "BANK_PORTAL_DOWNLOAD",
      fileName: `trust-${period[1]}.csv`, csv,
    });
  const verify = async (statementId: string) => {
    const res = await as(u.broker, "POST", `/api/bank/statements/${statementId}/verify`, { method: "Compared to TD EasyLine statement" });
    assert.equal(res.statusCode, 200, res.body);
  };

  const notifications = (type: string) => prisma.notification.count({ where: { userId: u.broker, type } });

  before(async () => {
    const make = async (role: UserRole) =>
      (await prisma.user.create({ data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: "Bank", lastName: role, role } })).id;
    u.broker = await make("MANAGING_BROKER");
    await designateBroker(app, prisma, u.broker);
    u.admin = await make("ADMIN");
    u.agent = await make("AGENT");
    account = (await prisma.trustAccount.create({ data: { name: `Trust ${randomUUID().slice(0, 4)}`, bankName: "TD", accountLast4: "4821" } })).id;
    deal.a = await newDeal("50000");
    deal.b = await newDeal("20000");
    entry.depositA = await deposit(deal.a, "50000.00", "2026-10-14", "2026-10-15", "DRAFT-881");
    entry.depositB = await deposit(deal.b, "20000.00", "2026-10-19", "2026-10-20", "WIRE-B");
    await prisma.transaction.update({ where: { id: deal.a }, data: { status: "CLOSED" } });
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("October: nothing leaves trust until the deposit is on a bank statement; import, auto-match, prepare", async () => {
    const blocked = await payout(deal.a, "30000.00", "2026-11-20");
    assert.equal(blocked.statusCode, 409);
    assert.equal(blocked.json().error.code, "FUNDS_NOT_CLEARED");

    const csv = "Date,Description,Reference,Amount\n10/15/2026,BRANCH DEPOSIT,DRAFT-881,50000.00\n10/21/2026,WIRE IN,WIRE-B,\"20,000.00\"\n";
    assert.equal((await statement(["2026-10-01", "2026-10-31"], "0.00", "70000.00", csv, u.agent)).statusCode, 403);
    const wrongTotal = await statement(["2026-10-01", "2026-10-31"], "0.00", "69000.00", csv);
    assert.equal(wrongTotal.statusCode, 400);
    assert.match(wrongTotal.json().error.message, /but the statement closes at 69000\.00/);
    const wrongDates = await statement(["2026-10-01", "2026-10-31"], "0.00", "70000.00", csv.replace("10/21/2026", "11/21/2026"));
    assert.match(wrongDates.json().error.message, /outside 2026-10-01 to 2026-10-31/);

    const imported = await statement(["2026-10-01", "2026-10-31"], "0.00", "70000.00", csv);
    assert.equal(imported.statusCode, 201, imported.body);
    assert.equal(imported.json().autoMatched, 2);
    assert.equal(imported.json().unmatched, 0);
    assert.equal((await statement(["2026-10-01", "2026-10-31"], "0.00", "70000.00", csv)).json().error.code, "STATEMENT_ALREADY_IMPORTED");

    const preview = (await as(u.broker, "GET", `/api/bank/statements/${imported.json().id}/reconciliation`)).json();
    assert.equal(preview.isBalanced, true);
    assert.equal(preview.ledgerBalance, 7_000_000);
    assert.equal(preview.clientLiabilities, 7_000_000);

    const prepared = await as(u.admin, "POST", "/api/trust/reconciliations", { statementId: imported.json().id });
    assert.equal(prepared.statusCode, 201, prepared.body);
    // s.13: due 30 days after the statement was received (Nov 3), not after the period end
    assert.deepEqual([prepared.json().status, prepared.json().statementReceived, prepared.json().dueBy, prepared.json().figures.difference],
      ["PREPARED", "2026-11-03", "2026-12-03", "0.00"]);
    recon.october = prepared.json().id;
    assert.equal((await as(u.admin, "POST", `/api/trust/reconciliations/${recon.october}/sign`, {})).statusCode, 403);

    // Matched, but not evidence until a second person verifies the file against the bank
    const unverified = await payout(deal.a, "30000.00", "2026-11-20");
    assert.equal(unverified.json().error.code, "FUNDS_NOT_CLEARED");
    await verify(imported.json().id);

    const paid = await payout(deal.a, "30000.00", "2026-11-20");
    assert.equal(paid.statusCode, 201, paid.body);
    const lawyer = await payout(deal.a, "20000.00", "2026-11-28", { payeeType: "LAWYER", payeeName: "Patel Law LLP in trust", method: "CHEQUE" });
    assert.equal(lawyer.statusCode, 201, lawyer.body);
  });

  test("November: a returned wire is a shortfall, alerts the broker, and has to be dealt with before signing", async () => {
    const before = { withdrawal: await notifications("TRUST_BANK_UNMATCHED_WITHDRAWAL"), shortfall: await notifications("TRUST_SHORTFALL") };
    const csv = "Date,Description,Amount\n11/20/2026,EFT TO GENERAL ACCOUNT,-30000.00\n11/25/2026,RETURNED ITEM WIRE-B,-20000.00\n";

    const gap = await statement(["2026-11-01", "2026-11-30"], "100.00", "-49900.00", csv);
    assert.equal(gap.statusCode, 422);
    assert.match(gap.json().error.message, /doesn't equal the previous statement's closing balance 70000\.00/);

    const imported = await statement(["2026-11-01", "2026-11-30"], "70000.00", "20000.00", csv);
    assert.equal(imported.statusCode, 201, imported.body);
    assert.equal(imported.json().autoMatched, 1); // the returned wire is not the lawyer's cheque written on the 28th
    await verify(imported.json().id);
    assert.equal(await notifications("TRUST_BANK_UNMATCHED_WITHDRAWAL"), before.withdrawal + 1);
    const returned = imported.json().lines.find((l: { amount: string }) => l.amount === "-20000.00");

    const first = await as(u.admin, "POST", "/api/trust/reconciliations", { statementId: imported.json().id });
    assert.equal(first.statusCode, 201, first.body);
    recon.novemberFirst = first.json().id;
    assert.equal(first.json().isBalanced, false);
    assert.equal(first.json().figures.adjustedBankBalance, "0.00"); // 20,000 at the bank − the 20,000 cheque not yet cashed
    assert.equal(first.json().figures.ledgerBalance, "20000.00");
    assert.equal(first.json().figures.difference, "-20000.00");
    assert.match(first.json().details.exceptions[0], /^Shortfall: the bank holds \$20000\.00 less/);
    assert.equal(await notifications("TRUST_SHORTFALL"), before.shortfall + 1);
    // s.14: a shortfall opens a trust incident that tracks registrar notification and replenishment
    assert.deepEqual(first.json().incidents.map((i: { kind: string; open: boolean }) => [i.kind, i.open]), [["SHORTFALL", true]]);
    const incident = (await as(u.broker, "GET", `/api/trust/incidents/${first.json().incidents[0].id}`)).json();
    assert.equal(incident.amount, "20000.00");
    assert.match(incident.outstanding[0], /Notify the RECO registrar immediately/);
    recon.incident = incident.id;
    const unsigned = await as(u.broker, "POST", `/api/trust/reconciliations/${recon.novemberFirst}/sign`, {});
    assert.equal(unsigned.json().error.code, "RECONCILIATION_NEEDS_EXPLANATION");

    // Record the return in the ledger on the day the bank took it, and match it
    const reversal = await as(u.broker, "POST", `/api/trust/entries/${entry.depositB}/reversals`, {
      reason: "Wire recalled by the sender's bank", effectiveDate: "2026-11-25",
    });
    assert.equal(reversal.statusCode, 201, reversal.body);
    const matched = await as(u.admin, "POST", "/api/bank/matches", { bankTransactionId: returned.id, trustEntryId: reversal.json().entry.id });
    assert.equal(matched.statusCode, 201, matched.body);

    const second = await as(u.admin, "POST", "/api/trust/reconciliations", { statementId: imported.json().id });
    recon.november = second.json().id;
    assert.equal(second.json().isBalanced, true);
    assert.deepEqual(second.json().details.outstanding.map((o: { amount: number }) => o.amount), [-2_000_000]);
  });

  test("months are signed in order by the broker; signed months are frozen", async () => {
    const outOfOrder = await as(u.broker, "POST", `/api/trust/reconciliations/${recon.november}/sign`, {});
    assert.equal(outOfOrder.statusCode, 422);
    assert.match(outOfOrder.json().error.message, /earlier months must be signed first/);

    const october = await as(u.broker, "POST", `/api/trust/reconciliations/${recon.october}/sign`, { note: "Reviewed against TD statement" });
    assert.equal(october.statusCode, 200, october.body);
    assert.equal(october.json().status, "SIGNED");
    assert.equal(october.json().signedBy, `Bank MANAGING_BROKER`);

    const stale = await as(u.broker, "POST", `/api/trust/reconciliations/${recon.novemberFirst}/sign`, {});
    assert.equal(stale.json().error.code, "RECONCILIATION_SUPERSEDED");
    assert.equal((await as(u.broker, "POST", `/api/trust/reconciliations/${recon.november}/sign`, {})).statusCode, 200);
    assert.equal((await as(u.broker, "POST", `/api/trust/reconciliations/${recon.november}/sign`, {})).json().error.code, "RECONCILIATION_ALREADY_SIGNED");

    // The shortfall turned out to be the unrecorded returned wire: resolving needs evidence, and only the broker of record can do it
    const incidentUrl = `/api/trust/incidents/${recon.incident}/events`;
    assert.equal((await as(u.admin, "POST", incidentUrl, { kind: "REGISTRAR_NOTIFIED", reference: "x" })).statusCode, 403);
    const bare = await as(u.broker, "POST", incidentUrl, { kind: "RESOLVED", note: "All good" });
    assert.match(bare.json().error.message, /registrar has been notified/);
    const resolved = await as(u.broker, "POST", incidentUrl, {
      kind: "RESOLVED", reconciliationId: recon.november,
      note: "Returned wire recorded as a reversal on Nov 25; the re-prepared November reconciliation balances. No money was missing.",
    });
    assert.equal(resolved.statusCode, 201, resolved.body);
    assert.equal(resolved.json().open, false);

    const status = (await as(u.broker, "GET", "/api/trust/reconciliation-status")).json().accounts.find((a: { trustAccountId: string }) => a.trustAccountId === account);
    assert.deepEqual(status.openIncidents, []);
    assert.deepEqual([status.lastStatementEnd, status.lastSignedPeriodEnd, status.awaitingSignature], ["2026-11-30", "2026-11-30", []]);

    let code = "no error";
    try {
      await prisma.$executeRaw`UPDATE "TrustReconciliation" SET difference = 0, explanation = 'x' WHERE id = ${recon.october}::uuid`;
    } catch (err) {
      code = (err as { meta?: { code?: string } }).meta?.code ?? "other";
    }
    assert.equal(code, "ZD003");

    // The October deposit match can't be undone: money was paid out against it, and the month is signed
    const match = await prisma.bankMatch.findFirstOrThrow({ where: { trustEntryId: entry.depositA, matchKind: "MONTHLY" } });
    const undo = await as(u.admin, "DELETE", `/api/bank/matches/${match.id}`);
    assert.equal(undo.statusCode, 422);
    assert.match(undo.json().error.message, /already been paid out/);

    // Statements now cover this account, so new entries can't be waved through as pre-cutover history
    const lateDeal = await newDeal("1000");
    const fresh = await deposit(lateDeal, "1000.00", "2026-12-01", "2026-12-02", "D-9");
    const refused = await as(u.broker, "POST", "/api/bank/pre-cutover", { trustEntryIds: [fresh], note: "x" });
    assert.equal(refused.statusCode, 422);
    assert.match(refused.json().error.message, /covered by imported statements/);
  });
});
