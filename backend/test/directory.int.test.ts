/**
 * Lists and look-ups for the staff screens (src/directory/routes.ts): who may
 * see what, and the two work queues. Needs DATABASE_URL; skipped otherwise.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { JPEG, multipart, TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-11-20";

describe("directory and work queues", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { admin: "", broker: "", compliance: "", agent: "", other: "" };
  const tag = randomUUID().slice(0, 6);
  let dealId = "";
  let slots: { id: string; code: string }[] = [];

  const as = (user: string, method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user, "idempotency-key": randomUUID() }, ...(body ? { payload: body } : {}) });

  before(async () => {
    const make = async (role: UserRole, first: string) => (await prisma.user.create({
      data: { email: `dir-${first.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: first, lastName: `Dir${tag}`, role },
    })).id;
    u.admin = await make("ADMIN", "Alex");
    u.broker = await make("MANAGING_BROKER", "Daniel");
    u.compliance = await make("COMPLIANCE_ADMIN", "Chris");
    u.agent = await make("AGENT", "Priya");
    u.other = await make("AGENT", "Omar");
    const res = await as(u.agent, "POST", "/api/deals", {
      side: "BUYER", streetAddress: `${tag} Lakeshore Rd`, city: "Oakville", salePrice: "900000", offerDate: "2026-11-01", closeDate: "2026-12-15",
      depositAmount: "40000", trustDepositHolder: "COOP_BROKERAGE", totalGci: "22500",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80 }],
      parties: [{ role: "BUYER", fullName: `Jordan ${tag}` }, { role: "SELLER", fullName: "Lake Holdings Inc.", entityType: "CORPORATION" }],
    });
    assert.equal(res.statusCode, 201, res.body);
    dealId = res.json().deal.id;
    slots = res.json().slots;
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("users: staff see the full list with sign-in status; agents only names and roles of active colleagues", async () => {
    const full = (await as(u.admin, "GET", `/api/users?role=AGENT`)).json().users;
    const priya = full.find((x: { id: string }) => x.id === u.agent);
    assert.deepEqual([priya.passwordSet, priya.mfaEnabled, priya.isActive], [false, false, true]);
    assert.ok("email" in priya);
    const short = (await as(u.agent, "GET", "/api/users")).json().users;
    assert.ok(short.some((x: { id: string }) => x.id === u.other));
    assert.ok(short.every((x: object) => Object.keys(x).sort().join() === "firstName,id,lastName,role"));
    assert.ok(!short.some((x: { id: string }) => x.id === u.compliance)); // agents and brokers only
  });

  test("profile edits: admin only, never your own role; PREC details are validated", async () => {
    assert.equal((await as(u.broker, "POST", `/api/users/${u.agent}/profile`, { hstNumber: "1" })).statusCode, 403);
    assert.equal((await as(u.admin, "POST", `/api/users/${u.admin}/profile`, { role: "AGENT" })).json().error.code, "VALIDATION_FAILED");
    const ok = await as(u.admin, "POST", `/api/users/${u.agent}/profile`, {
      isPrec: true, precLegalName: "Priya Real Estate Professional Corporation", hstNumber: "123456789RT0001" });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().user.precLegalName, "Priya Real Estate Professional Corporation");
  });

  test("deals: agents list and open only their own; staff search everything", async () => {
    assert.ok((await as(u.agent, "GET", `/api/deals?q=${tag}`)).json().deals.some((d: { id: string }) => d.id === dealId));
    assert.equal((await as(u.other, "GET", `/api/deals?q=${tag}`)).json().deals.length, 0);
    assert.equal((await as(u.other, "GET", `/api/deals/${dealId}`)).statusCode, 403);
    const found = (await as(u.compliance, "GET", `/api/deals?q=Jordan ${tag}`)).json().deals; // by party name
    assert.deepEqual(found.map((d: { id: string }) => d.id), [dealId]);
    const deal = (await as(u.agent, "GET", `/api/deals/${dealId}`)).json().deal;
    assert.equal(deal.totalGci, "22500.00");
    assert.deepEqual(deal.parties.map((p: { role: string }) => p.role).sort(), ["BUYER", "SELLER"]);
    assert.equal(deal.cda, null);
  });

  test("trust accounts: a managing broker opens the record; staff list them with the ledger balance; agents can't", async () => {
    assert.equal((await as(u.admin, "POST", "/api/trust/accounts", { name: "x", bankName: "TD", accountLast4: "1234" })).statusCode, 403);
    const bad = await as(u.broker, "POST", "/api/trust/accounts", { name: "Trust", bankName: "TD", accountLast4: "12a4" });
    assert.equal(bad.json().error.code, "VALIDATION_FAILED");
    const made = await as(u.broker, "POST", "/api/trust/accounts", { name: `Trust ${tag}`, bankName: "TD", accountLast4: "4821" });
    assert.equal(made.statusCode, 201, made.body);
    const list = (await as(u.compliance, "GET", "/api/trust/accounts")).json().accounts;
    assert.equal(list.find((a: { id: string }) => a.id === made.json().account.id).balance, "0.00");
    assert.equal((await as(u.agent, "GET", "/api/trust/accounts")).statusCode, 403);
  });

  test("work queues: an uploaded document waits for review; an imported statement waits for a second person", async () => {
    const slot = slots.find((s) => s.code === "APS")!;
    const { payload, contentType } = multipart({ name: "aps.jpg", type: "image/jpeg", bytes: JPEG });
    const up = await app.inject({ method: "POST", url: `/api/documents/slots/${slot.id}/files`, payload, headers: { "x-user-id": u.agent, "content-type": contentType } });
    assert.equal(up.statusCode, 201, up.body);
    const reviews = (await as(u.compliance, "GET", "/api/work/reviews")).json().items;
    assert.ok(reviews.some((i: { slotId: string; dealId: string }) => i.slotId === slot.id && i.dealId === dealId));
    assert.equal((await as(u.agent, "GET", "/api/work/reviews")).statusCode, 403);

    const account = (await prisma.operatingAccount.create({ data: { name: `Op ${tag}`, bankName: "TD", accountLast4: "2200" } })).id;
    const s = await as(u.admin, "POST", "/api/bank/statements", {
      kind: "INTERIM", accountType: "OPERATING", accountId: account, periodStart: TODAY, periodEnd: TODAY, closingBalance: "100.00",
      receivedDate: TODAY, source: "BANK_PORTAL_DOWNLOAD", fileName: `q-${tag}.csv`, csv: "Date,Description,Amount\n2026-11-20,FEE,-1.00\n",
    });
    assert.equal(s.statusCode, 201, s.body);
    const queue = (await as(u.broker, "GET", "/api/work/approvals")).json();
    assert.ok(queue.statements.some((x: { id: string; importedById: string }) => x.id === s.json().id && x.importedById === u.admin));
    assert.ok(Array.isArray(queue.payouts) && Array.isArray(queue.plans) && Array.isArray(queue.reconciliationsToSign));
    assert.equal((await as(u.compliance, "GET", "/api/work/approvals")).statusCode, 403);
    const listed = (await as(u.broker, "GET", `/api/bank/statements?accountId=${account}`)).json().statements;
    assert.deepEqual(listed.map((x: { id: string; verified: unknown }) => [x.id, x.verified]), [[s.json().id, null]]);
  });

  test("an agent can't sign another agent's trade record sheet", async () => {
    assert.equal((await as(u.agent, "POST", `/api/deals/${dealId}/trade-record`)).statusCode, 201);
    assert.equal((await as(u.other, "POST", `/api/deals/${dealId}/trade-record/sign`, {})).statusCode, 403);
  });
});
