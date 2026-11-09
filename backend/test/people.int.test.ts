/**
 * Agent profiles, standard plans and RECO renewal reminders (migration 023). Needs DATABASE_URL; skipped otherwise.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { MemoryStore } from "../src/compliance/storage.ts";
import { reminderKind } from "../src/people/reminders.ts";
import { TEST_BROKERAGE } from "./fixtures.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-11-09";
const day = (offset: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

describe("agent profiles, standard plans and renewal reminders", { skip }, () => {
  const prisma = new PrismaClient();
  const sent: { to: string[]; cc: string[]; subject: string; text: string }[] = [];
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => TODAY,
    mail: { from: "office@zareh.test", sender: { send: async (m) => { sent.push(m); } } } });
  const u = { admin: "", broker: "", compliance: "", agent: "", other: "" };
  const as = (user: string, method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user, "idempotency-key": randomUUID() }, ...(body ? { payload: body } : {}) });
  const profile = (extra: object = {}) => ({ startDate: "2024-03-01", recoExpiryDate: day(60), address: "12 King St W, Hamilton ON L8P 1A1",
    dateOfBirth: "1985-06-15", ...extra });

  before(async () => {
    const make = async (role: UserRole, first = "Pat") => (await prisma.user.create({
      data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: first, lastName: role, role },
    })).id;
    u.admin = await make("ADMIN");
    u.broker = await make("MANAGING_BROKER");
    u.compliance = await make("COMPLIANCE_ADMIN");
    u.agent = await make("AGENT", "Riley");
    u.other = await make("AGENT");
  });
  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("profile: start date, RECO expiry, address and date of birth are required; the rest is optional; personal details are encrypted", async () => {
    const empty = await as(u.admin, "POST", `/api/users/${u.agent}/agent-profile`, {});
    assert.equal(empty.statusCode, 400);
    const fields = empty.json().error.details.issues.map((i: { field: string }) => i.field).sort();
    assert.deepEqual(fields, ["address", "dateOfBirth", "recoExpiryDate", "startDate"]);
    assert.equal((await as(u.admin, "POST", `/api/users/${u.agent}/agent-profile`, profile({ payoutBanking: { accountHolder: "Riley Agent",
      institutionNumber: "004", transitNumber: "123", accountNumber: "1234567" } }))).statusCode, 400); // a 5-digit transit
    const saved = await as(u.admin, "POST", `/api/users/${u.agent}/agent-profile`, profile({
      emergencyContactName: "Sam Agent", emergencyContactPhone: "905-555-0100", eoInsurer: "RECO Insurance Program", eoExpiryDate: "2027-01-01",
      payoutBanking: { accountHolder: "Riley Agent", institutionNumber: "004", transitNumber: "12345", accountNumber: "1234567" },
      billingMethod: "PRE_AUTHORIZED_DEBIT", billingNote: "$250 desk fee on the 1st" }));
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().profile.address, "12 King St W, Hamilton ON L8P 1A1");
    assert.equal(saved.json().profile.payoutBanking.transitNumber, "12345");
    const row = await prisma.agentProfile.findUniqueOrThrow({ where: { userId: u.agent } });
    for (const v of [row.addressEnc, row.dateOfBirthEnc, row.payoutBankingEnc!]) {
      assert.match(v, /^v1\./);
      assert.ok(!v.includes("King") && !v.includes("1985") && !v.includes("1234567"));
    }
    // Who sees what
    assert.equal((await as(u.agent, "GET", `/api/users/${u.agent}/agent-profile`)).json().profile.dateOfBirth, "1985-06-15"); // their own
    const comp = (await as(u.compliance, "GET", `/api/users/${u.agent}/agent-profile`)).json();
    assert.deepEqual(Object.keys(comp.profile).sort(), ["eoExpiryDate", "recoExpiryDate", "startDate"]); // dates only
    assert.equal((await as(u.other, "GET", `/api/users/${u.agent}/agent-profile`)).statusCode, 403);
    assert.equal((await as(u.agent, "POST", `/api/users/${u.agent}/agent-profile`, profile())).statusCode, 403); // admins and brokers edit
    // The people list shows where each registration stands
    const people = (await as(u.admin, "GET", "/api/users")).json().users;
    assert.deepEqual(people.find((p: { id: string }) => p.id === u.agent).registration,
      { profileComplete: true, recoExpiryDate: day(60), status: "OK", daysLeft: 60 });
    assert.equal(people.find((p: { id: string }) => p.id === u.other).registration.status, "MISSING");
  });

  test("standard plans: picked from a list, the agent's own terms can override, a second broker still approves", async () => {
    const t = await as(u.admin, "POST", "/api/commission-plan-templates", { name: `80/20 capped ${randomUUID().slice(0, 4)}`, splitPct: 80, annualCap: "20000",
      fees: [{ name: "Desk fee", amount: "250" }] });
    assert.equal(t.statusCode, 201, t.body);
    const template = t.json().templates.find((x: { splitPct: number }) => x.splitPct === 80);
    assert.equal((await as(u.admin, "POST", "/api/commission-plan-templates", { name: template.name.toUpperCase(), splitPct: 70 })).json().error.code, "DUPLICATE");
    const plan = await as(u.admin, "POST", `/api/agents/${u.agent}/commission-plans`, { effectiveFrom: "2026-01-01", templateId: template.id, reason: "Joined on the standard plan" });
    assert.equal(plan.statusCode, 201, plan.body);
    const v = plan.json().versions.at(-1);
    assert.deepEqual([v.splitBps, v.annualCap, v.standardPlan, v.status, v.fees], [8000, "20000.00", template.name, "PROPOSED", [{ name: "Desk fee", amount: "250.00" }]]);
    const own = await as(u.admin, "POST", `/api/agents/${u.agent}/commission-plans`, { effectiveFrom: "2026-06-01", templateId: template.id, splitPct: 85, reason: "Top producer" });
    assert.equal(own.json().versions.at(-1).splitBps, 8500);
    // Retired plans drop out of the list for new agents; agents already on them keep their versions
    await as(u.admin, "POST", `/api/commission-plan-templates/${template.id}/retire`);
    assert.equal((await as(u.admin, "POST", `/api/agents/${u.other}/commission-plans`, { effectiveFrom: "2026-01-01", templateId: template.id, reason: "x" })).statusCode, 400);
    assert.equal((await as(u.admin, "GET", `/api/agents/${u.agent}/commission-plans`)).json().versions.length, 2);
  });

  test("renewal reminders: 30 days, 14 days and on expiry, once each, to the agent and the managing brokers, with the penalties", async () => {
    assert.deepEqual([31, 30, 15, 14, 1, 0, -3].map(reminderKind), [null, "DAYS_30", "DAYS_30", "DAYS_14", "DAYS_14", "EXPIRED", "EXPIRED"]);
    const reminders = async () => (await as(u.broker, "POST", "/api/registrations/reminders/run")).json();
    const agentEmail = (await prisma.user.findUniqueOrThrow({ where: { id: u.agent } })).email;
    const brokerEmail = (await prisma.user.findUniqueOrThrow({ where: { id: u.broker } })).email;
    const mine = () => sent.filter((m) => m.to.includes(agentEmail));

    await as(u.admin, "POST", `/api/users/${u.agent}/agent-profile`, profile({ recoExpiryDate: day(30) }));
    let r = await reminders();
    assert.ok(r.queued >= 1 && r.delivery.sent >= 1, JSON.stringify(r));
    assert.equal(mine().length, 1);
    assert.match(mine()[0]!.subject, /expires on .* \(30 days\)/);
    assert.ok(mine()[0]!.cc.includes(brokerEmail));
    assert.match(mine()[0]!.text, /up to \$50,000, jailed for up to two years less a day, or both, and a brokerage can be fined up to \$250,000 \(s\.40\)/);
    await reminders();
    assert.equal(mine().length, 1, "not sent twice for the same expiry date");

    await as(u.admin, "POST", `/api/users/${u.agent}/agent-profile`, profile({ recoExpiryDate: day(14) }));
    await reminders();
    assert.match(mine().at(-1)!.subject, /^Urgent: .*\(14 days\)/);
    await as(u.admin, "POST", `/api/users/${u.agent}/agent-profile`, profile({ recoExpiryDate: day(0) }));
    await reminders();
    assert.match(mine().at(-1)!.subject, /expired on .*: you can't trade/);
    assert.match(mine().at(-1)!.text, /stop all trading/);
    assert.equal(mine().length, 3);
    // In the agent's notifications too, and in the outbox for the office
    assert.ok((await prisma.notification.findMany({ where: { userId: u.agent } })).some((n) => n.type === "RECO_EXPIRED"));
    const outbox = (await as(u.admin, "GET", "/api/email-outbox")).json();
    assert.equal(outbox.emailConfigured, true);
    assert.ok(outbox.emails.some((e: { kind: string; status: string }) => e.kind === "RECO_EXPIRED" && e.status === "SENT"));
    // On the broker's oversight page
    const oversight = (await as(u.broker, "GET", "/api/dashboard/oversight?view=broker")).json();
    const metric = oversight.sections.flatMap((s: { metrics: { key: string }[] }) => s.metrics).find((m: { key: string }) => m.key === "reco.registrations");
    assert.ok(metric.items.some((i: string) => /can't trade/.test(i)));
    assert.equal(metric.status, "critical");
  });

  test("an agent whose registration had expired by the offer date can't be put on a new deal", async () => {
    await as(u.admin, "POST", `/api/users/${u.agent}/agent-profile`, profile({ recoExpiryDate: "2026-10-01" }));
    const deal = (offerDate: string) => as(u.admin, "POST", "/api/deals", {
      side: "BUYER", streetAddress: "4 Lake St", city: "Grimsby", salePrice: "700000", offerDate, closeDate: "2026-12-15",
      depositAmount: "20000", trustDepositHolder: "COOP_BROKERAGE", totalGci: "17500", coopBrokerageName: "Other Realty",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80 }], parties: [{ role: "BUYER", fullName: "Bea Buyer" }] });
    const refused = await deal("2026-10-15");
    assert.equal(refused.json().error.code, "REGISTRATION_EXPIRED", refused.body);
    assert.match(refused.json().error.message, /expired 2026-10-01: they can't trade/);
    assert.equal((await deal("2026-10-01")).json().error.code, "REGISTRATION_EXPIRED"); // the expiry date itself counts as expired
    assert.equal((await deal("2026-09-20")).statusCode, 201); // recording a trade made while registered is fine
  });
});
