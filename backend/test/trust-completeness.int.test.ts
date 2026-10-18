/**
 * Trust completeness (migration 012), through the API: the bank service-fee
 * shortfall exception, amended reconciliations, interim-vs-monthly integrity
 * checks, proclaimed holidays and the unclaimed trust money register.
 * Needs DATABASE_URL; skipped otherwise.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { todayInToronto } from "../src/lib/dates.ts";
import { designateBroker, TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
// Incident timing is checked against the database clock, so these tests run on the real date
const TODAY = todayInToronto();

describe("trust completeness", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { broker: "", admin: "", agent: "" };

  const as = (user: string, method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user, "idempotency-key": randomUUID() }, ...(body ? { payload: body } : {}) });

  async function trustAccount() {
    return (await prisma.trustAccount.create({ data: { name: `Trust ${randomUUID().slice(0, 6)}`, bankName: "TD", accountLast4: "4821" } })).id;
  }

  async function dealWithDeposit(account: string, amount: string, date: string, payor = "Bo Kim") {
    const deal = (await prisma.transaction.create({
      data: {
        dealNumber: `T-${randomUUID().slice(0, 8)}`, side: "LISTING", status: "FIRM", streetAddress: "4 King St", city: "Grimsby",
        salePrice: "700000", offerDate: new Date("2024-08-01"), closeDate: new Date("2024-10-01"), depositAmount: amount,
        trustDepositHolder: "OUR_BROKERAGE", totalGci: "17500",
      },
    })).id;
    const res = await as(u.broker, "POST", "/api/trust/deposits", {
      dealId: deal, trustAccountId: account, amount, method: "BANK_DRAFT", dateReceived: date, dateDeposited: date,
      payorName: payor, bankReference: `DRAFT-${randomUUID().slice(0, 4)}`,
    });
    assert.equal(res.statusCode, 201, res.body);
    await prisma.transaction.update({ where: { id: deal }, data: { status: "COLLAPSED" } });
    return { deal, entryId: res.json().entry.id as string, reference: res.json().entry.referenceNo as string };
  }

  const monthly = (account: string, period: [string, string], opening: string, closing: string, csv: string) =>
    as(u.admin, "POST", "/api/bank/statements", {
      accountType: "TRUST", accountId: account, periodStart: period[0], periodEnd: period[1], openingBalance: opening,
      closingBalance: closing, receivedDate: TODAY, source: "BANK_PORTAL_DOWNLOAD", fileName: `m-${randomUUID().slice(0, 6)}.csv`, csv,
    });

  /** A September statement with the deposit and a bank fee; reconciled, so a shortfall incident is open. */
  async function shortfallFromFee(extraCsv = "", closing = "9987.50") {
    const account = await trustAccount();
    const { reference } = await dealWithDeposit(account, "10000.00", "2026-09-02");
    const stmt = await monthly(account, ["2026-09-01", "2026-09-30"], "0.00", closing,
      `Date,Description,Reference,Amount\n09/02/2026,DEPOSIT,${reference},10000.00\n09/30/2026,MONTHLY ACCOUNT FEE,,-12.50\n${extraCsv}`);
    assert.equal(stmt.statusCode, 201, stmt.body);
    assert.equal((await as(u.broker, "POST", `/api/bank/statements/${stmt.json().id}/verify`, { method: "TD portal" })).statusCode, 200);
    const fee = stmt.json().lines.find((l: { description: string }) => l.description === "MONTHLY ACCOUNT FEE").id as string;
    const recon = await as(u.admin, "POST", "/api/trust/reconciliations", {
      statementId: stmt.json().id, explanation: "Bank fee charged to trust; brokerage replenishing",
    });
    assert.equal(recon.statusCode, 201, recon.body);
    const incident = recon.json().incidents.find((i: { kind: string }) => i.kind === "SHORTFALL").id as string;
    return { account, statementId: stmt.json().id as string, reconId: recon.json().id as string, incident, fee, lines: stmt.json().lines };
  }

  const event = (incident: string, body: object, user = u.broker) => as(user, "POST", `/api/trust/incidents/${incident}/events`, body);

  before(async () => {
    const make = async (role: UserRole) =>
      (await prisma.user.create({ data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: "Trust", lastName: role, role } })).id;
    u.broker = await make("MANAGING_BROKER");
    await designateBroker(app, prisma, u.broker);
    u.admin = await make("ADMIN");
    u.agent = await make("AGENT");
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("service-fee shortfall: no RECO notice if the broker of record ties it to the fee and it's made good right away", async () => {
    const s = await shortfallFromFee();
    const before = (await as(u.broker, "GET", `/api/trust/incidents/${s.incident}`)).json();
    assert.equal(before.cause, null);
    assert.match(before.outstanding[0], /Notify the RECO registrar immediately/); // until the cause is known, it's reportable

    // Only the broker of record decides the cause, and a fee has to be a bank line
    assert.equal((await event(s.incident, { kind: "CAUSE_DETERMINED", cause: "BANK_SERVICE_FEE", bankTransactionId: s.fee, note: "x" }, u.admin)).statusCode, 403);
    assert.equal((await event(s.incident, { kind: "CAUSE_DETERMINED", cause: "BANK_SERVICE_FEE", note: "Fee" })).statusCode, 400);
    const deposit = s.lines.find((l: { amount: string }) => l.amount === "10000.00").id;
    const notAFee = await event(s.incident, { kind: "CAUSE_DETERMINED", cause: "BANK_SERVICE_FEE", bankTransactionId: deposit, note: "Fee" });
    assert.match(notAFee.json().error.message, /service fee is a withdrawal/);

    const caused = await event(s.incident, { kind: "CAUSE_DETERMINED", cause: "BANK_SERVICE_FEE", bankTransactionId: s.fee, note: "TD monthly account fee" });
    assert.equal(caused.statusCode, 201, caused.body);
    assert.equal(caused.json().cause, "BANK_SERVICE_FEE");
    assert.deepEqual(caused.json().serviceFeeException.available, true);
    assert.ok(!caused.json().outstanding.some((o: string) => /Notify the RECO registrar/.test(o)));

    assert.match((await event(s.incident, { kind: "RESOLVED", note: "Done" })).json().error.message, /service fees and replenished/);
    await event(s.incident, { kind: "REPLENISHED", amount: "12.50", reference: "TRANSFER-GEN-TO-TRUST-88" });
    const resolved = await event(s.incident, { kind: "RESOLVED", note: "Fee replenished from the general account the day it was found" });
    assert.equal(resolved.statusCode, 201, resolved.body);
    assert.equal(resolved.json().open, false);
    assert.equal(resolved.json().registrarNotified, false);
  });

  test("service-fee exception doesn't apply when fees don't explain the whole shortfall, or another cause is recorded", async () => {
    const s = await shortfallFromFee("09/30/2026,WITHDRAWAL,,-100.00\n", "9887.50");
    await event(s.incident, { kind: "CAUSE_DETERMINED", cause: "BANK_SERVICE_FEE", bankTransactionId: s.fee, note: "Fee" });
    const v = (await as(u.broker, "GET", `/api/trust/incidents/${s.incident}`)).json();
    assert.equal(v.serviceFeeException.available, false);
    assert.ok(v.outstanding.some((o: string) => /don't account for the whole \$112\.50/.test(o)));
    await event(s.incident, { kind: "REPLENISHED", amount: "112.50", reference: "TRANSFER-1" });
    assert.match((await event(s.incident, { kind: "RESOLVED", note: "Done" })).json().error.message, /registrar has been notified/);

    const t = await shortfallFromFee();
    await event(t.incident, { kind: "CAUSE_DETERMINED", cause: "OTHER", note: "Unexplained; investigating" });
    await event(t.incident, { kind: "REPLENISHED", amount: "12.50", reference: "TRANSFER-2" });
    assert.match((await event(t.incident, { kind: "RESOLVED", note: "Done" })).json().error.message, /registrar has been notified/);
    await event(t.incident, { kind: "REGISTRAR_NOTIFIED", reference: "RECO portal 2026-0912" });
    assert.equal((await event(t.incident, { kind: "RESOLVED", note: "Reported and replenished" })).statusCode, 201);
  });

  test("a signed reconciliation is never changed: a correction supersedes it, with a reason", async () => {
    const s = await shortfallFromFee();
    const signed = await as(u.broker, "POST", `/api/trust/reconciliations/${s.reconId}/sign`, { note: "Reviewed" });
    assert.equal(signed.statusCode, 200, signed.body);

    const again = await as(u.admin, "POST", "/api/trust/reconciliations", { statementId: s.statementId, explanation: "Redo" });
    assert.match(again.json().error.message, /this month is signed; a new reconciliation must supersede/);
    assert.equal((await as(u.admin, "POST", "/api/trust/reconciliations", { statementId: s.statementId, supersedesId: s.reconId })).statusCode, 400);

    const amended = await as(u.admin, "POST", "/api/trust/reconciliations", {
      statementId: s.statementId, explanation: "Bank fee charged to trust; replenished",
      supersedesId: s.reconId, amendmentReason: "Original omitted the replenishment reference",
    });
    assert.equal(amended.statusCode, 201, amended.body);
    assert.deepEqual(amended.json().supersedes, { id: s.reconId, reason: "Original omitted the replenishment reference" });
    const signAmended = await as(u.broker, "POST", `/api/trust/reconciliations/${amended.json().id}/sign`, {});
    assert.equal(signAmended.statusCode, 200, signAmended.body);

    const original = (await as(u.broker, "GET", `/api/trust/reconciliations/${s.reconId}`)).json();
    assert.deepEqual([original.status, original.supersededBy, original.signedAt !== null], ["SUPERSEDED", amended.json().id, true]);
    // The original is still exactly as signed
    const row = await prisma.trustReconciliation.findUniqueOrThrow({ where: { id: s.reconId } });
    assert.equal(row.signatureNote, "Reviewed");
  });

  test("an interim record that the monthly statement doesn't bear out has to be checked with the bank before verifying", async () => {
    const account = await trustAccount();
    const { reference } = await dealWithDeposit(account, "10000.00", "2026-09-02");
    const interim = await as(u.admin, "POST", "/api/bank/statements", {
      kind: "INTERIM", accountType: "TRUST", accountId: account, periodStart: "2026-09-01", periodEnd: "2026-09-10",
      closingBalance: "9500.00", receivedDate: "2026-09-10", source: "BANK_PORTAL_DOWNLOAD", fileName: "interim.csv",
      csv: `Date,Description,Reference,Amount\n09/02/2026,DEPOSIT,${reference},10000.00\n09/05/2026,WITHDRAWAL,,-500.00\n`,
    });
    assert.equal(interim.statusCode, 201, interim.body);
    assert.deepEqual(interim.json().integrityExceptions, []);
    const stmt = await monthly(account, ["2026-09-01", "2026-09-30"], "0.00", "10000.00",
      `Date,Description,Reference,Amount\n09/02/2026,DEPOSIT,${reference},10000.00\n`);
    assert.equal(stmt.statusCode, 201, stmt.body);
    assert.equal(stmt.json().integrityExceptions.length, 2);
    assert.match(stmt.json().integrityExceptions[0], /\$-500\.00 on 2026-09-05 \(WITHDRAWAL\) isn't on the monthly statement/);
    assert.ok(await prisma.notification.count({ where: { userId: u.broker, type: "BANK_RECORD_MISMATCH" } }) >= 1);

    const url = `/api/bank/statements/${stmt.json().id}/verify`;
    assert.match((await as(u.broker, "POST", url, { method: "TD portal" })).json().error.message, /differs from earlier bank records/);
    const ok = await as(u.broker, "POST", url, {
      method: "TD portal", exceptionsReviewed: "TD confirmed the Sep 5 withdrawal was reversed same day; the interim file showed it before the reversal posted",
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.match(ok.json().verification.exceptionsReviewed, /TD confirmed/);
  });

  test("proclaimed holidays: added by the broker of record with the proclamation, and used for deadlines", async () => {
    // A weekday far enough out not to touch other tests
    const year = 2100 + Math.floor(Math.random() * 800);
    const date = `${year}-06-15`;
    assert.equal((await as(u.admin, "POST", "/api/business-calendar/proclaimed", { date, name: "Test day", reference: "x" })).statusCode, 403);
    const added = await as(u.broker, "POST", "/api/business-calendar/proclaimed", { date, name: "National day of mourning", reference: "Proclamation (test)" });
    assert.equal(added.statusCode, 201, added.body);
    assert.equal((await as(u.broker, "POST", "/api/business-calendar/proclaimed", { date, name: "Again", reference: "x" })).statusCode, 409);
    const cal = (await as(u.agent, "GET", `/api/business-calendar?year=${year}`)).statusCode;
    assert.equal(cal, 403);
    const view = (await as(u.admin, "GET", `/api/business-calendar?year=${year}`)).json();
    assert.equal(view.civicHolidayCounted, false);
    assert.ok(view.holidays.some((h: { date: string; name: string }) => h.date === date && h.name === "National day of mourning"));
  });

  test("unclaimed trust money: register from the ledger, contact attempts, escalation, package; RECO remittance stays disabled", async () => {
    const account = await trustAccount();
    const { deal } = await dealWithDeposit(account, "3200.00", "2024-08-15", "Departed Buyer");
    const candidates = (await as(u.admin, "GET", "/api/trust/unclaimed/candidates")).json().candidates;
    assert.ok(candidates.some((c: { dealId: string; balance: string }) => c.dealId === deal && c.balance === "3200.00"));

    assert.equal((await as(u.agent, "POST", "/api/trust/unclaimed", {})).statusCode, 403);
    const opened = await as(u.admin, "POST", "/api/trust/unclaimed", {
      dealId: deal, trustAccountId: account, heldSince: "2024-08-15", entitlement: "ENTITLED_PARTY_NOT_LOCATED",
      entitledParty: "Departed Buyer", reason: "Deal collapsed; mutual release signed; buyer's refund cheque returned undeliverable",
    });
    assert.equal(opened.statusCode, 201, opened.body);
    const f = opened.json();
    assert.deepEqual([f.principal, f.remitDue, f.status, f.belowRemittanceMinimum], ["3200.00", "2026-08-15", "OPEN", false]);
    assert.equal(f.escalation, 24);
    assert.ok(f.outstanding.some((o: string) => /attempt to locate/.test(o)));
    assert.equal((await as(u.admin, "POST", "/api/trust/unclaimed", {
      dealId: deal, trustAccountId: account, heldSince: "2024-08-15", entitlement: "ENTITLEMENT_UNCLEAR", reason: "dup",
    })).statusCode, 409);

    const ev = (body: object, user = u.admin) => as(user, "POST", `/api/trust/unclaimed/${f.id}/events`, body);
    assert.equal((await ev({ kind: "CONTACT_ATTEMPT", note: "Called" })).statusCode, 400); // method and outcome required
    const contacted = await ev({ kind: "CONTACT_ATTEMPT", method: "Registered letter", outcome: "Returned: moved, no forwarding address", note: "Last known address" });
    assert.equal(contacted.json().contactAttempts, 1);
    await ev({ kind: "INTEREST_ACCRUED", amount: "41.20", reference: "TD interest Sep 2026", note: "Interest to date" });

    const pkg = (await as(u.broker, "GET", `/api/trust/unclaimed/${f.id}/package`)).json();
    assert.equal(pkg.record.amountDue, "3241.20");
    assert.deepEqual(pkg.items.map((i: { item: string; ready: boolean }) => i.ready), [true, false, false, true, true]);
    assert.equal(pkg.ready, false);

    // Remittance is a broker-of-record record of a payment made elsewhere, and off by policy
    assert.equal((await ev({ kind: "REMITTED_TO_RECO", amount: "3241.20", reference: "x", note: "x" })).statusCode, 403);
    const off = await ev({ kind: "REMITTED_TO_RECO", amount: "3241.20", reference: "RECO-REMIT-1", note: "Paid" }, u.broker);
    assert.equal(off.json().error.code, "POLICY_NOT_APPROVED");
    assert.equal((await ev({ kind: "REMITTED_TO_RECO", amount: "3200.00", reference: "R", note: "x" }, u.broker)).json().error.code, "REMITTANCE_AMOUNT");
    assert.match((await ev({ kind: "CLOSED", note: "Done" }, u.broker)).json().error.message, /once the money is paid/);

    const list = (await as(u.broker, "GET", "/api/trust/unclaimed")).json();
    assert.ok(list.records.some((r: { id: string }) => r.id === f.id));
  });
});
