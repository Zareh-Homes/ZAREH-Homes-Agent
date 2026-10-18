/**
 * Dashboard integration test. "Today" is pinned to 2031-06-15 so year-to-date
 * totals only see this file's data. Needs DATABASE_URL with migrations 001–005.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { approvedPlan, multipart, TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2031-06-15";
const PDF = Buffer.from("%PDF-1.7\n%%EOF\n");

describe("dashboard API", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({
    prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY,
  });
  const u = { broker: "", compliance: "", agent: "" };
  const deals = { closed: "", soon: "", later: "", pastWithFunds: "" };
  let trustAccountId = "";
  let financialsBefore: Record<string, number> = {};

  const dashboard = async (user: string) => {
    const res = await app.inject({ method: "GET", url: "/api/dashboard", headers: { "x-user-id": user } });
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };

  async function openDeal(closeDate: string, extra: object = {}) {
    const res = await app.inject({
      method: "POST", url: "/api/deals", headers: { "x-user-id": u.agent },
      payload: {
        side: "BUYER", streetAddress: `${Math.floor(Math.random() * 900) + 100} Main St E`, city: "Hamilton",
        salePrice: "1000000", offerDate: "2031-01-15", closeDate, depositAmount: "50000",
        trustDepositHolder: "COOP_BROKERAGE", totalGci: "25000",
        agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80 }],
        parties: [{ role: "BUYER", fullName: "Maria Santos" }],
        ...extra,
      },
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  }

  before(async () => {
    const make = async (role: UserRole, extra: object = {}) =>
      (await prisma.user.create({
        data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: "Jane", lastName: role, role, ...extra },
      })).id;
    u.broker = await make("MANAGING_BROKER");
    u.compliance = await make("COMPLIANCE_ADMIN");
    u.agent = await make("AGENT", { isPrec: true, precLegalName: "Jane Agent Real Estate Professional Corporation", hstNumber: "123456789RT0001" });
    await approvedPlan(prisma, u.agent, { annualCap: "15000" });
    // Compare deltas: the database is shared and never cleaned (ledgers are append-only)
    const start = (await dashboard(u.compliance)).brokerage;
    financialsBefore = start.financials;

    // A finalized closing this year: $1M sale, $27,500 GCI, agent 80/20
    deals.closed = (await openDeal("2031-03-01")).deal.id;
    await prisma.transaction.update({ where: { id: deals.closed }, data: { status: "FIRM" } });
    await prisma.transaction.update({ where: { id: deals.closed }, data: { status: "CLOSED" } });
    const computation = {
      incoming: { commission: { base: 2_750_000, hst: 357_500, total: 3_107_500 } },
      brokerage: { netEarnedShare: { base: 570_000, hst: 74_100, total: 644_100 }, referral: null, netHstEstimate: 74_100 },
    };
    const [closing] = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "ClosingStatement" (id, "transactionId", "cdaNumber", computation, "computationSha", "lawyerHtml",
                                      "internalHtml", "idempotencyKey", "finalizedById")
      VALUES (gen_random_uuid(), ${deals.closed}::uuid, ${`CDA-${randomUUID()}`}, ${JSON.stringify(computation)}::jsonb,
              'sha', '<html>', '<html>', gen_random_uuid(), ${u.broker}::uuid)
      RETURNING id`;
    await prisma.closingAgentPayout.create({
      data: {
        closingId: closing!.id, userId: u.agent, closeDate: new Date("2031-03-01"), payeeName: "Jane Agent Real Estate Professional Corporation",
        allocatedBaseGci: "27500", houseSplitBase: "5500", agentSplitBase: "22000", agentSplitHst: "2860",
        feesBase: "200", feesHst: "26", netPayout: "24634", wiredByLawyer: "0", paidByBrokerage: "24634",
      },
    });

    // Firm, closing in 5 days, FINTRAC not approved, APS sent back
    const soon = await openDeal("2031-06-20");
    deals.soon = soon.deal.id;
    await prisma.transaction.update({ where: { id: deals.soon }, data: { status: "FIRM" } });
    const aps = soon.slots.find((s: { code: string }) => s.code === "APS");
    const { payload, contentType } = multipart({ name: "aps.pdf", type: "application/pdf", bytes: PDF });
    const up = await app.inject({
      method: "POST", url: `/api/documents/slots/${aps.id}/files`, payload,
      headers: { "x-user-id": u.agent, "content-type": contentType },
    });
    await app.inject({
      method: "POST", url: `/api/documents/slots/${aps.id}/review`, headers: { "x-user-id": u.compliance },
      payload: { decision: "NEEDS_REVISION", comment: "APS missing Seller initials on page 3", fileId: up.json().fileId },
    });

    // Firm but closing in 45 days: outside the 14-day window
    deals.later = (await openDeal("2031-07-30")).deal.id;
    await prisma.transaction.update({ where: { id: deals.later }, data: { status: "FIRM" } });

    // Closed two weeks ago on paper, but $10,000 still in trust
    deals.pastWithFunds = (await openDeal("2031-06-01", { side: "LISTING", trustDepositHolder: "OUR_BROKERAGE",
      parties: [{ role: "SELLER", fullName: "Ann Lee" }] })).deal.id;
    await prisma.transaction.update({ where: { id: deals.pastWithFunds }, data: { status: "FIRM" } });
    const account = await prisma.trustAccount.create({ data: { name: "Dashboard trust", bankName: "TD", accountLast4: "0001" } });
    trustAccountId = account.id;
    const dep = await app.inject({
      method: "POST", url: "/api/trust/deposits", headers: { "x-user-id": u.broker, "idempotency-key": randomUUID() },
      payload: { dealId: deals.pastWithFunds, trustAccountId: account.id, amount: "10000.00", method: "WIRE",
        dateReceived: "2031-05-02", dateDeposited: "2031-05-02", payorName: "Bo Kim", bankReference: "W-1" },
    });
    assert.equal(dep.statusCode, 201, dep.body);
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("compliance admin: brokerage view only, figures from finalized closings", async () => {
    const d = await dashboard(u.compliance);
    assert.equal(d.personal, null);
    assert.deepEqual(d.period, { year: 2031, today: TODAY });
    const delta = Object.fromEntries(
      Object.entries(d.brokerage.financials as Record<string, number>).map(([k, v]) => [k, v - financialsBefore[k]!]),
    );
    assert.deepEqual(delta, {
      companyDollarCents: 570_000, closedVolumeCents: 100_000_000, closedDeals: 1,
      hstCollectedCents: 357_500, netHstEstimateCents: 74_100, finalizedClosings: 1,
    });
  });

  test("trust widget: total in trust and deals past closing still holding funds", async () => {
    const { trust } = (await dashboard(u.broker)).brokerage;
    // Other test files move trust money in parallel, so check this test's own account
    const mine = trust.accounts.find((a: { id: string }) => a.id === trustAccountId);
    assert.equal(mine.balanceCents, 1_000_000);
    assert.equal(trust.totalCents, trust.accounts.reduce((s: number, a: { balanceCents: number }) => s + a.balanceCents, 0));
    const late = trust.pastClosing.find((x: { id: string }) => x.id === deals.pastWithFunds);
    assert.equal(late.balanceCents, 1_000_000);
    assert.equal(late.daysPastClose, 14);
    assert.equal(late.onHold, false);
  });

  test("compliance queue: firm deals closing within 14 days without FINTRAC approval", async () => {
    const queue = (await dashboard(u.broker)).brokerage.complianceQueue;
    const soon = queue.find((x: { id: string }) => x.id === deals.soon);
    assert.equal(soon.daysToClose, 5);
    assert.equal(soon.primaryAgent, "Jane AGENT");
    assert.deepEqual(soon.missing, [{ document: "FINTRAC Individual Identification Record", party: "Maria Santos", status: "MISSING" }]);
    assert.equal(queue.some((x: { id: string }) => x.id === deals.later), false);
    assert.equal(queue.some((x: { id: string }) => x.id === deals.closed), false);
  });

  test("agent: personal analytics, PREC HST, cap progress and documents sent back", async () => {
    const d = await dashboard(u.agent);
    assert.equal(d.brokerage, null);
    assert.equal(d.viewer.isPrec, true);
    const p = d.personal;
    assert.equal(p.volumeCents, 100_000_000);
    assert.equal(p.grossGciCents, 2_750_000);
    assert.equal(p.netPayoutsCents, 2_463_400);
    assert.deepEqual(p.prec, {
      legalName: "Jane Agent Real Estate Professional Corporation", hstNumber: "123456789RT0001",
      hstReceivedCents: 283_400, commissionIncomeCents: 2_180_000,
    });
    assert.deepEqual(p.cap, { capCents: 1_500_000, paidCents: 550_000, yearStart: "2031-01-01", yearEnd: "2032-01-01" });
    assert.equal(p.needsRevision.length, 1);
    assert.equal(p.needsRevision[0].document, "Agreement of Purchase and Sale (APS)");
    assert.equal(p.needsRevision[0].comment, "APS missing Seller initials on page 3");
    assert.equal(p.needsRevision[0].reviewer, "Jane COMPLIANCE_ADMIN");
  });

  test("managing broker sees both the brokerage and their own business", async () => {
    const d = await dashboard(u.broker);
    assert.ok(d.brokerage);
    assert.ok(d.personal);
    assert.equal(d.personal.cap, null);
  });
});
