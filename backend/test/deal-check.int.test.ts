/** The deal check through the API: the agent sees their own deal's problems; staff get the queue. Needs DATABASE_URL. */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-11-09";

describe("deal check", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { agent: "", other: "", compliance: "" };
  let deal = "";
  const as = (user: string, url: string) => app.inject({ method: "GET", url, headers: { "x-user-id": user } });

  before(async () => {
    const make = async (role: UserRole) => (await prisma.user.create({
      data: { email: `check-${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: "Check", lastName: role, role, phone: "905-555-0199" } })).id;
    u.agent = await make("AGENT"); u.other = await make("AGENT"); u.compliance = await make("COMPLIANCE_ADMIN");
    const res = await app.inject({ method: "POST", url: "/api/deals", headers: { "x-user-id": u.agent }, payload: {
      side: "LISTING", streetAddress: `${randomUUID().slice(0, 4)} Check Rd`, city: "Stoney Creek", salePrice: "849000", offerDate: "2026-11-01",
      conditionsDueDate: "2026-11-06", closeDate: "2027-01-16", depositAmount: "40000", depositDueDate: "2026-11-03", trustDepositHolder: "OUR_BROKERAGE",
      totalGci: "21225", agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80 }],
      parties: [{ role: "SELLER", fullName: "Ann Lee" }, { role: "BUYER", fullName: "Bo Kim" }, { role: "COOP_BROKERAGE", fullName: "Harbourfront Realty Inc." }] } });
    assert.equal(res.statusCode, 201, res.body);
    deal = res.json().deal.id;
    await prisma.dealCondition.create({ data: { transactionId: deal, kind: "FINANCING", description: "Financing", forBenefitOf: "BUYER",
      dueAt: new Date("2026-11-06T23:59:00Z"), createdById: u.agent } });
  });
  after(async () => { await app.close(); await prisma.$disconnect(); });

  test("the agent sees what's missing, what's wrong and which dates don't line up", async () => {
    const res = await as(u.agent, `/api/deals/${deal}/check`);
    assert.equal(res.statusCode, 200, res.body);
    const { issues, summary } = res.json();
    const said = issues.map((i: { message: string }) => i.message).join("\n");
    assert.match(said, /Closing is on 2027-01-16 \(a weekend\)/);
    assert.match(said, /"Financing" was due 2026-11-06 and nothing is recorded/);
    assert.match(said, /The deposit was due 2026-11-03 and isn't recorded in trust/);
    assert.match(said, /No seller's lawyer/);
    assert.match(said, /agent profile isn't filled in/);
    assert.match(said, /no approved commission plan for the closing date/);
    assert.ok(summary.mustFix > 0);
  });

  test("only people on the deal, or staff, can see its check; only staff get the queue", async () => {
    assert.equal((await as(u.other, `/api/deals/${deal}/check`)).statusCode, 403);
    assert.equal((await as(u.agent, "/api/deal-checks")).statusCode, 403);
    const q = await as(u.compliance, "/api/deal-checks");
    assert.equal(q.statusCode, 200, q.body);
    const row = q.json().deals.find((d: { dealId: string }) => d.dealId === deal);
    assert.ok(row && row.mustFix > 0 && row.top.length > 0);
  });
});
