/**
 * Exports (CSV per dataset, full JSON backup) and imports (agents, deals) with a dry run first. Needs DATABASE_URL.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { parseCsv } from "../src/bank/csv.ts";
import { toCsv } from "../src/portability/export.ts";
import { TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-11-09";

describe("import and export", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { admin: "", broker: "", agent: "" };
  const tag = randomUUID().slice(0, 6);
  const as = (user: string, method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user, "idempotency-key": randomUUID() }, ...(body ? { payload: body } : {}) });
  const table = (csv: string) => {
    const [head, ...rows] = parseCsv(csv.replace(/^﻿/, "")).filter((r) => r.some((c) => c));
    return rows.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ""])));
  };

  before(async () => {
    const make = async (role: UserRole) => (await prisma.user.create({
      data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: "Imp", lastName: role, role },
    })).id;
    u.admin = await make("ADMIN");
    u.broker = await make("MANAGING_BROKER");
    u.agent = await make("AGENT");
  });
  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("spreadsheet cells can't run as formulas; commas, quotes and line breaks survive", () => {
    const csv = toCsv([{ a: "=HYPERLINK(\"x\")", b: "-12.50", c: "Smith, \"Bob\"\nJr" }]);
    assert.equal(table(csv)[0]!.a, "'=HYPERLINK(\"x\")");
    assert.equal(table(csv)[0]!.b, "-12.50"); // a negative amount stays a number
    assert.equal(table(csv)[0]!.c, "Smith, \"Bob\"\nJr");
  });

  test("agents import: preview first, then add; re-running updates instead of duplicating; a standard plan is proposed", async () => {
    await as(u.admin, "POST", "/api/commission-plan-templates", { name: `70/30 ${tag}`, splitPct: 70 });
    const file = [
      "First Name,Last Name,Email,Phone,Role,RECO Registration No,Start Date,RECO Expiry Date,Address,Date of Birth,Standard Plan,Billing Method",
      `Nadia,Haddad,nadia.${tag}@zareh.test,905-555-0101,AGENT,R-${tag},2023-05-01,2027-05-01,"5 Main St E, Grimsby ON",1988-02-11,70/30 ${tag},pre_authorized_debit`,
      `Omar,Shah,omar.${tag}@zareh.test,,AGENT,,2024-01-15,,"7 Queen St, Hamilton",1990-07-07,,`,
      `,,not-an-email,,,,,,,,,`,
    ].join("\n");
    const preview = (await as(u.admin, "POST", "/api/imports/agents", { csv: file })).json();
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.counts, { create: 1, update: 0, skip: 0, error: 2 });
    assert.match(preview.rows[1].detail, /recoExpiryDate is required/);
    assert.equal(await prisma.user.count({ where: { email: `nadia.${tag}@zareh.test` } }), 0, "a preview saves nothing");

    const done = (await as(u.admin, "POST", "/api/imports/agents", { csv: file, dryRun: false })).json();
    assert.equal(done.counts.create, 1, JSON.stringify(done.rows));
    const nadia = await prisma.user.findUniqueOrThrow({ where: { email: `nadia.${tag}@zareh.test` }, include: { agentProfile: true, planVersions: { include: { template: true } } } });
    assert.match(nadia.agentProfile!.addressEnc, /^v1\./);
    assert.equal(nadia.agentProfile!.billingMethod, "PRE_AUTHORIZED_DEBIT");
    assert.deepEqual(nadia.planVersions.map((v) => [v.splitBps, v.template?.name, v.approvedAt]), [[7000, `70/30 ${tag}`, null]]); // proposed, not approved
    const again = (await as(u.admin, "POST", "/api/imports/agents", { csv: file, dryRun: false })).json();
    assert.equal(again.counts.update, 1);
    assert.equal(await prisma.user.count({ where: { email: `nadia.${tag}@zareh.test` } }), 1);
    assert.equal((await as(u.broker, "POST", "/api/imports/agents", { csv: file })).statusCode, 403); // admins import
  });

  test("deals import: open deals only, agents by email, duplicates skipped, closed history refused", async () => {
    const agentEmail = (await prisma.user.findUniqueOrThrow({ where: { id: u.agent } })).email;
    const file = [
      "side,status,street address,city,sale price,offer date,close date,deposit amount,deposit holder,total gci,coop brokerage name,agent email,agent split pct,sellers,buyers,seller lawyer",
      `LISTING,CONDITIONAL,${tag} Lakeshore Rd,Oakville,899000,2026-11-01,2027-01-15,50000,Our brokerage,22475,Other Realty,${agentEmail},70,Lee Chan,Pat Buyer,Oak Law LLP`,
      `BUYER,CLOSED,${tag} Navy St,Oakville,750000,2026-06-01,2026-08-01,30000,COOP_BROKERAGE,18750,Lakeshore Realty,${agentEmail},70,,Bo Kim,`,
      `BUYER,FIRM,${tag} Ridge Rd,Grimsby,700000,2026-10-20,2026-12-20,20000,LAWYER,17500,Other Realty,nobody@zareh.test,80,,Bea Buyer,`,
    ].join("\n");
    const preview = (await as(u.admin, "POST", "/api/imports/deals", { csv: file })).json();
    assert.deepEqual(preview.counts, { create: 1, update: 0, skip: 0, error: 2 });
    assert.match(preview.rows[1].detail, /closed deals and their trust history come over with the Lone Wolf cutover tool/);
    assert.match(preview.rows[2].detail, /no active person with the email nobody@zareh.test/);
    const done = (await as(u.admin, "POST", "/api/imports/deals", { csv: file, dryRun: false })).json();
    assert.equal(done.counts.create, 1);
    assert.match(done.rows[0].detail, /^deal \d{4}-\d{4}$/);
    const deal = await prisma.transaction.findFirstOrThrow({ where: { streetAddress: `${tag} Lakeshore Rd` }, include: { parties: true, agents: true } });
    assert.deepEqual(deal.parties.map((p) => p.role).sort(), ["BUYER", "SELLER", "SELLER_LAWYER"]);
    assert.equal(deal.trustDepositHolder, "OUR_BROKERAGE");
    assert.equal((await as(u.admin, "POST", "/api/imports/deals", { csv: file, dryRun: false })).json().counts.skip, 1); // not added twice
  });

  test("exports: one spreadsheet per dataset, personal details only when asked, a full backup without sign-in secrets; admins and brokers only", async () => {
    const list = (await as(u.broker, "GET", "/api/exports")).json();
    assert.deepEqual(list.datasets, ["agents", "deals", "parties", "trust-ledger", "cdas", "payouts", "commission-receipts", "documents"]);
    for (const name of list.datasets) {
      const res = await as(u.broker, "GET", `/api/exports/${name}.csv`);
      assert.equal(res.statusCode, 200, `${name}: ${res.body.slice(0, 200)}`);
      assert.match(res.headers["content-disposition"] as string, new RegExp(`zareh-${name}-${TODAY}\\.csv`));
    }
    const agents = table((await as(u.admin, "GET", "/api/exports/agents.csv")).body);
    const nadia = agents.find((a) => a.email === `nadia.${tag}@zareh.test`)!;
    assert.equal(nadia.recoExpiryDate, "2027-05-01");
    assert.equal(nadia.standardPlan ?? "", ""); // proposed, not yet in force
    assert.ok(!("address" in nadia) && !("dateOfBirth" in nadia), "personal details left out by default");
    const full = table((await as(u.admin, "GET", "/api/exports/agents.csv?includePersonal=true")).body).find((a) => a.email === `nadia.${tag}@zareh.test`)!;
    assert.equal(full.address, "5 Main St E, Grimsby ON");
    assert.ok(await prisma.auditLog.findFirst({ where: { action: "DATA_EXPORTED", entityId: "agents", userId: u.admin } }));
    const deals = table((await as(u.admin, "GET", "/api/exports/deals.csv")).body);
    assert.ok(deals.some((d) => d.streetAddress === `${tag} Lakeshore Rd` && /Imp AGENT \(PRIMARY, split 70\.00%/.test(d.agents!)));
    // Round trip: the agents export goes straight back in as updates
    const back = (await as(u.admin, "POST", "/api/imports/agents", { csv: (await as(u.admin, "GET", "/api/exports/agents.csv?includePersonal=true")).body })).json();
    const nadiaBack = back.rows.find((r: { label: string }) => r.label === "Nadia Haddad");
    assert.equal(nadiaBack.action, "UPDATE", nadiaBack.detail);

    const backup = (await as(u.admin, "GET", "/api/exports/full.json")).json();
    assert.ok(backup.tables.Transaction.length > 0 && backup.tables.TrustLedgerEntry && backup.tables.AgentProfile);
    for (const secret of ["UserCredential", "Session", "AuthToken"]) assert.equal(backup.tables[secret], undefined, secret);
    assert.ok(backup.tables.AgentProfile.every((p: { addressEnc: string }) => p.addressEnc.startsWith("v1.")), "encrypted fields stay encrypted");
    assert.equal((await as(u.agent, "GET", "/api/exports/deals.csv")).statusCode, 403);
  });
});
