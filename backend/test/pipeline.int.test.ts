/**
 * Pipeline integration test. "Today" is Thursday 2032-03-18 so the Closed
 * column is this test's month. Needs DATABASE_URL with migrations 001–005.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2032-03-18";

describe("pipeline API", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({
    prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY,
  });
  const u = { broker: "", agent: "", other: "" };
  const ids = { listing: "", conditional: "", firmLate: "", firmOverdue: "", closedThisMonth: "", closedLastMonth: "", othersDeal: "" };
  let account = "";

  const board = async (user: string) => {
    const res = await app.inject({ method: "GET", url: "/api/pipeline", headers: { "x-user-id": user } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };

  async function deal(agent: string, status: "CONDITIONAL" | "FIRM" | "CLOSED", extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST", url: "/api/deals", headers: { "x-user-id": agent },
      payload: {
        side: "LISTING", streetAddress: `${100 + Math.floor(Math.random() * 800)} King St W`, city: "Hamilton",
        mlsNumber: `X${Math.floor(Math.random() * 1e7)}`, salePrice: "899000", offerDate: "2032-02-01",
        closeDate: "2032-04-15", depositAmount: "45000", trustDepositHolder: "OUR_BROKERAGE", totalGci: "22475",
        agents: [{ userId: agent, role: "PRIMARY", splitPct: 80 }],
        parties: [{ role: "SELLER", fullName: "Ann Lee" }],
        ...extra,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().deal.id as string;
    await prisma.transaction.update({ where: { id }, data: { status } });
    return id;
  }

  async function deposit(dealId: string, received: string, deposited: string) {
    const res = await app.inject({
      method: "POST", url: "/api/trust/deposits", headers: { "x-user-id": u.broker, "idempotency-key": randomUUID() },
      payload: { dealId, trustAccountId: account, amount: "45000.00", method: "BANK_DRAFT",
        dateReceived: received, dateDeposited: deposited, payorName: "Bo Kim", bankReference: "D-1" },
    });
    assert.equal(res.statusCode, 201, res.body);
  }

  before(async () => {
    const make = async (role: UserRole, first: string) =>
      (await prisma.user.create({ data: { email: `${randomUUID()}@zareh.test`, firstName: first, lastName: "Pipeline", role } })).id;
    u.broker = await make("MANAGING_BROKER", "Brook");
    u.agent = await make("AGENT", "Ava");
    u.other = await make("AGENT", "Omar");
    account = (await prisma.trustAccount.create({ data: { name: "Pipeline trust", bankName: "TD", accountLast4: "7777" } })).id;

    ids.listing = (await prisma.listing.create({
      data: { mlsNumber: `W${Math.floor(Math.random() * 1e7)}`, streetAddress: "12 Lakeshore Rd", city: "Oakville",
        propertyType: "DETACHED", listPrice: "1299000", listingDate: new Date("2032-03-10"), listingAgentId: u.agent },
    })).id;

    // Conditional, deposit banked on time
    ids.conditional = await deal(u.agent, "CONDITIONAL", { conditionsDueDate: "2032-03-22" });
    await prisma.transaction.update({ where: { id: ids.conditional }, data: { status: "FIRM" } }); // deposits need an active deal
    await deposit(ids.conditional, "2032-03-08", "2032-03-12");
    await prisma.transaction.update({ where: { id: ids.conditional }, data: { status: "CONDITIONAL" } });

    // Firm, received Mon Mar 1 but banked Wed Mar 10: 7 business days
    ids.firmLate = await deal(u.agent, "FIRM", { closeDate: "2032-04-30" });
    await deposit(ids.firmLate, "2032-03-01", "2032-03-10");

    // Firm, deposit was due Mar 12 and never arrived
    ids.firmOverdue = await deal(u.agent, "FIRM", { closeDate: "2032-04-02", depositDueDate: "2032-03-12" });

    ids.closedThisMonth = await deal(u.agent, "CLOSED", { closeDate: "2032-03-05", trustDepositHolder: "COOP_BROKERAGE" });
    ids.closedLastMonth = await deal(u.agent, "CLOSED", { offerDate: "2032-01-10", closeDate: "2032-02-26", trustDepositHolder: "COOP_BROKERAGE" });
    ids.othersDeal = await deal(u.other, "FIRM", { trustDepositHolder: "COOP_BROKERAGE" });
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const ofIds = (cards: { id: string }[]) => cards.map((c) => c.id);

  test("agent sees only their own listings and deals, in the right columns", async () => {
    const b = await board(u.agent);
    assert.equal(b.scope, "MINE");
    assert.equal(b.month, "2032-03");
    assert.deepEqual(ofIds(b.columns.ACTIVE), [ids.listing]);
    assert.deepEqual(ofIds(b.columns.CONDITIONAL), [ids.conditional]);
    assert.deepEqual(ofIds(b.columns.FIRM), [ids.firmOverdue, ids.firmLate]); // soonest closing first
    assert.deepEqual(ofIds(b.columns.CLOSED), [ids.closedThisMonth]); // February's closing isn't shown
  });

  test("cards: address, MLS, agent, price, the right key date for the column", async () => {
    const b = await board(u.agent);
    const listing = b.columns.ACTIVE[0];
    assert.equal(listing.priceLabel, "List price");
    assert.equal(listing.priceCents, 129_900_000);
    assert.equal(listing.agentName, "Ava Pipeline");
    assert.equal(listing.deposit, null);

    const cond = b.columns.CONDITIONAL[0];
    assert.equal(cond.priceLabel, "Sale price");
    assert.equal(cond.priceCents, 89_900_000);
    assert.match(cond.mlsNumber, /^X\d+$/);
    assert.deepEqual(cond.keyDate, { label: "Conditions due", date: "2032-03-22", daysFromToday: 4 });

    const firm = b.columns.FIRM[0];
    assert.deepEqual(firm.keyDate, { label: "Closing", date: "2032-04-02", daysFromToday: 15 });
  });

  test("deposit badges follow the trust ledger and the 5-business-day rule", async () => {
    const b = await board(u.agent);
    const byId = Object.fromEntries([...b.columns.CONDITIONAL, ...b.columns.FIRM, ...b.columns.CLOSED].map((c) => [c.id, c.deposit]));
    assert.equal(byId[ids.conditional].state, "CLEARED");
    assert.equal(byId[ids.conditional].label, "Deposit Received & Cleared");
    assert.equal(byId[ids.firmLate].state, "LATE_TO_TRUST");
    assert.match(byId[ids.firmLate].detail, /7 business days/);
    assert.equal(byId[ids.firmOverdue].state, "OVERDUE");
    assert.equal(byId[ids.firmOverdue].label, "Deposit Missing / Overdue");
    assert.equal(byId[ids.closedThisMonth].state, "HELD_ELSEWHERE");
  });

  test("managing broker sees everyone's deals", async () => {
    const b = await board(u.broker);
    assert.equal(b.scope, "ALL");
    assert.ok(ofIds(b.columns.FIRM).includes(ids.othersDeal));
    assert.ok(ofIds(b.columns.FIRM).includes(ids.firmLate));
  });
});
