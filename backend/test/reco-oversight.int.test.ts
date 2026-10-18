/**
 * RECO annual filing preparation and the oversight dashboards (migration 017).
 * Needs DATABASE_URL; skipped otherwise.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { filingDueDate, _test } from "../src/reco/filing.ts";
import { designateBroker, TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-10-18";

test("RECO due dates: the initial window files by 2026-10-30; later years 90 days after year end", () => {
  assert.equal(filingDueDate("2025-08-01"), "2026-10-30");
  assert.equal(filingDueDate("2025-12-31"), "2026-10-30");
  assert.equal(filingDueDate("2026-07-31"), "2026-10-30");
  assert.equal(filingDueDate("2026-08-31"), "2026-11-29");
  assert.equal(filingDueDate("2026-12-31"), "2027-03-31");
  assert.deepEqual(_test.monthEnds("2025-08-01", "2025-11-30"), ["2025-08-31", "2025-09-30", "2025-10-31", "2025-11-30"]);
});

describe("RECO filing and oversight dashboards", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { broker: "", admin: "", agent: "" };
  // A far-future fiscal year, so reruns on the same database don't collide
  const year = 2100 + Math.floor(Math.random() * 800);
  const fye = `${year}-06-30`;

  const as = (user: string, method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user }, ...(body ? { payload: body } : {}) });

  before(async () => {
    const make = async (role: UserRole) => (await prisma.user.create({
      data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: "Reco", lastName: role, role },
    })).id;
    u.broker = await make("MANAGING_BROKER");
    u.admin = await make("ADMIN");
    u.agent = await make("AGENT");
    await designateBroker(app, prisma, u.broker);
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("filing package: computed sections with sources, figures from the statements, broker review, then the filing is recorded", async () => {
    assert.equal((await as(u.agent, "POST", "/api/reco/filings", { fiscalYearStart: `${year - 1}-07-01`, fiscalYearEnd: fye })).statusCode, 403);
    const created = await as(u.admin, "POST", "/api/reco/filings", { fiscalYearStart: `${year - 1}-07-01`, fiscalYearEnd: fye });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().dueDate, filingDueDate(fye));
    assert.equal((await as(u.admin, "POST", "/api/reco/filings", { fiscalYearStart: `${year - 1}-07-01`, fiscalYearEnd: fye })).statusCode, 409);

    const url = `/api/reco/filings/${fye}`;
    const p = (await as(u.admin, "GET", url)).json();
    assert.equal(p.status, "IN_PREPARATION");
    assert.ok(p.missing.includes("Financial statements: cash"));
    assert.ok(p.missing.some((m: string) => m.startsWith("Broker of record review:")));
    assert.equal(p.financialStatements.CASH, null); // never filled in
    assert.match(p.activity.source, /close date from/);
    assert.ok(p.attestations.length === 6 && p.attestations.every((a: { basis: string }) => a.basis.length > 0));
    assert.match(p.note, /Nothing has been filed/);

    const fig = (body: object, user = u.admin) => as(user, "POST", `${url}/figures`, body);
    assert.equal((await fig({ field: "CASH", amount: "1", source: "x" }, u.agent)).statusCode, 403);
    assert.equal((await fig({ field: "MADE_UP", amount: "1", source: "x" })).statusCode, 400);
    for (const [field, amount] of [["CASH", "182000.00"], ["TOTAL_ASSETS", "250000.00"], ["TOTAL_LIABILITIES", "90000.00"], ["EQUITY", "150000.00"]]) {
      assert.equal((await fig({ field, amount, source: `FY${year} statements prepared by the accountant` })).statusCode, 201);
    }
    const checked = (await as(u.admin, "GET", url)).json();
    assert.deepEqual(checked.financialStatements.CASH, { value: "182000.00", source: `FY${year} statements prepared by the accountant` });
    assert.match(checked.checks[0], /assets don't equal liabilities plus equity/);
    await fig({ field: "EQUITY", amount: "160000.00", source: "Corrected: statements page 2" }); // a correction is a new entry
    assert.deepEqual((await as(u.admin, "GET", url)).json().checks, []);

    const csv = await as(u.admin, "GET", `${url}?format=csv`);
    assert.match(csv.headers["content-disposition"] as string, new RegExp(`reco-annual-filing-${fye}\\.csv`));
    assert.match(csv.body, /Financial: CASH,182000\.00,FY\d+ statements/);

    // Recording the filing needs the broker of record's review of every attestation
    const submit = () => as(u.broker, "POST", `${url}/submission`, { submittedOn: TODAY, reference: "MyWeb confirmation 55512" });
    assert.match((await submit()).json().error.message, /review the evidence for all six/);
    assert.equal((await as(u.admin, "POST", `${url}/attestation-reviews`, { item: "ACCURACY", note: "x" })).statusCode, 403);
    for (const item of ["TRUST_SUFFICIENCY", "SEPARATION_OF_FUNDS", "MONTHLY_RECONCILIATIONS", "SHORTFALLS_REPORTED", "NOTICE_OF_CHANGES", "ACCURACY"]) {
      assert.equal((await as(u.broker, "POST", `${url}/attestation-reviews`, { item, note: "Reviewed the evidence and the exceptions listed" })).statusCode, 201);
    }
    const filed = await submit();
    assert.equal(filed.statusCode, 201, filed.body);
    assert.deepEqual([filed.json().status, filed.json().submission.reference], ["SUBMITTED", "MyWeb confirmation 55512"]);
    assert.match((await fig({ field: "CASH", amount: "1.00", source: "late" })).json().error.message, /recorded as submitted/);
  });

  test("oversight dashboards: every number says what it is, where it's from and when", async () => {
    assert.equal((await as(u.agent, "GET", "/api/dashboard/oversight?view=broker")).statusCode, 403);
    assert.equal((await as(u.agent, "GET", "/api/dashboard/oversight?view=accounting")).statusCode, 403);
    for (const [user, view] of [[u.broker, "broker"], [u.admin, "accounting"], [u.agent, "agent"]] as const) {
      const res = await as(user, "GET", `/api/dashboard/oversight?view=${view}`);
      assert.equal(res.statusCode, 200, res.body);
      const metrics = res.json().sections.flatMap((s: { metrics: object[] }) => s.metrics);
      assert.ok(metrics.length >= 2, view);
      for (const m of metrics as { definition: string; source: string; asOf: string; status: string }[]) {
        assert.ok(m.definition.length > 10 && m.source.length > 3 && m.asOf.length >= 10, JSON.stringify(m));
        assert.ok(["ok", "attention", "critical"].includes(m.status));
      }
    }
    const broker = (await as(u.broker, "GET", "/api/dashboard/oversight?view=broker")).json();
    const reco = broker.sections.flatMap((s: { metrics: { key: string }[] }) => s.metrics).find((m: { key: string }) => m.key === "reco.filing");
    assert.ok(reco);
  });
});
