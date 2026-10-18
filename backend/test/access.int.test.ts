/**
 * Cross-user and cross-deal access: an agent can't read or change another
 * agent's deal through any route. Plus the privacy breach and legal hold
 * workflows. Needs DATABASE_URL; skipped otherwise.
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

describe("access control and privacy", { skip }, () => {
  const prisma = new PrismaClient();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: new MemoryStore(), brokerage: TEST_BROKERAGE, today: () => "2026-10-18" });
  const u = { mine: "", other: "", compliance: "", broker: "" };
  let otherDeal = "";
  let otherSlot = "";
  let otherFile = "";

  const as = (user: string, method: "GET" | "POST", url: string, body?: object) =>
    app.inject({ method, url, headers: { "x-user-id": user, "idempotency-key": randomUUID() }, ...(body ? { payload: body } : {}) });

  before(async () => {
    const make = async (role: UserRole) =>
      (await prisma.user.create({ data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: "Acc", lastName: role, role } })).id;
    u.mine = await make("AGENT");
    u.other = await make("AGENT");
    u.compliance = await make("COMPLIANCE_ADMIN");
    u.broker = await make("MANAGING_BROKER");
    const created = await as(u.other, "POST", "/api/deals", {
      side: "BUYER", streetAddress: "9 Ridge Rd", city: "Stoney Creek", salePrice: "750000", offerDate: "2026-10-01",
      closeDate: "2026-12-01", depositAmount: "30000", trustDepositHolder: "COOP_BROKERAGE", totalGci: "18750",
      agents: [{ userId: u.other, role: "PRIMARY", splitPct: 80 }], parties: [{ role: "BUYER", fullName: "Lee Chan" }],
    });
    assert.equal(created.statusCode, 201, created.body);
    otherDeal = created.json().deal.id;
    otherSlot = created.json().slots.find((s: { code: string }) => s.code === "FINTRAC_INDIVIDUAL").id;
    const { payload, contentType } = multipart({ name: "id.jpg", type: "image/jpeg", bytes: JPEG }, {
      verificationDate: "2026-10-01", fullLegalName: "Lee Chan", dateOfBirth: "1980-02-02", address: "9 Ridge Rd, Stoney Creek",
      occupation: "Nurse", idType: "PASSPORT", idNumber: "GA998877", issuingJurisdiction: "Canada", expiryDate: "2031-01-01",
      thirdPartyDetermination: false,
    });
    const up = await app.inject({ method: "POST", url: `/api/documents/slots/${otherSlot}/files`, payload,
      headers: { "x-user-id": u.other, "content-type": contentType } });
    assert.equal(up.statusCode, 201, up.body);
    otherFile = up.json().fileId;
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("another agent's deal is invisible and untouchable through every route", async () => {
    const reads = [
      `/api/deals/${otherDeal}/documents`, `/api/deals/${otherDeal}/trust`, `/api/deals/${otherDeal}/closing`,
      `/api/deals/${otherDeal}/closing/cda?audience=internal`, `/api/deals/${otherDeal}/closing/payouts`,
      `/api/documents/files/${otherFile}`, `/api/documents/files/${otherFile}/content`,
    ];
    for (const url of reads) {
      const res = await as(u.mine, "GET", url);
      assert.ok([403, 404].includes(res.statusCode), `${url} returned ${res.statusCode}`);
    }
    const parties = await as(u.mine, "POST", `/api/deals/${otherDeal}/parties`, { role: "BUYER", fullName: "Intruder" });
    assert.ok([403, 404].includes(parties.statusCode));
    const { payload, contentType } = multipart({ name: "x.jpg", type: "image/jpeg", bytes: JPEG }, {});
    const up = await app.inject({ method: "POST", url: `/api/documents/slots/${otherSlot}/files`, payload, headers: { "x-user-id": u.mine, "content-type": contentType } });
    assert.ok([403, 404].includes(up.statusCode));
    const pipeline = (await as(u.mine, "GET", "/api/pipeline")).json();
    assert.ok(!JSON.stringify(pipeline).includes(otherDeal));
    // And the attempts are on the audit trail
    assert.ok((await prisma.auditLog.count({ where: { userId: u.mine, outcome: "DENIED" } })) >= 1);
  });

  test("ID numbers are encrypted at rest; staff see them, and every view is audited", async () => {
    const stored = await prisma.documentFile.findUniqueOrThrow({ where: { id: otherFile } });
    const meta = stored.metadata as Record<string, unknown>;
    assert.ok(!JSON.stringify(meta).includes("GA998877"));
    assert.ok(!JSON.stringify(meta).includes("1980-02-02"));
    assert.equal(meta.idNumberLast4, "8877");
    const agentView = (await as(u.other, "GET", `/api/documents/files/${otherFile}`)).json();
    assert.equal(agentView.metadata, null);
    assert.equal(agentView.metadataSummary.idNumber, "•••• 8877");
    const staffView = (await as(u.compliance, "GET", `/api/documents/files/${otherFile}`)).json();
    assert.equal(staffView.metadata.idNumber, "GA998877");
    assert.equal(await prisma.auditLog.count({ where: { userId: u.compliance, entityId: `/api/documents/files/${otherFile}` } }), 1);
  });

  test("privacy breach: can't close a real-risk breach until the OPC is told and individuals are notified", async () => {
    assert.equal((await as(u.mine, "POST", "/api/privacy/breaches", { discoveredAt: "2026-10-17", description: "x", informationInvolved: "x" })).statusCode, 403);
    const b = (await as(u.compliance, "POST", "/api/privacy/breaches", {
      discoveredAt: "2026-10-17", description: "Laptop with FINTRAC scans stolen from a car",
      informationInvolved: "Names, ID numbers, dates of birth", individualsAffected: 12,
    })).json();
    const event = (body: object) => as(u.compliance, "POST", `/api/privacy/breaches/${b.id}/events`, body);
    assert.match((await event({ kind: "CLOSED", note: "done" })).json().error.message, /assess whether/);
    await event({ kind: "CONTAINED", note: "Device remotely wiped" });
    await event({ kind: "RISK_ASSESSED", realRiskOfSignificantHarm: true, note: "Government ID numbers: high sensitivity" });
    assert.match((await event({ kind: "CLOSED", note: "done" })).json().error.message, /reported to the OPC/);
    assert.equal((await event({ kind: "OPC_REPORTED", note: "Filed online" })).statusCode, 400); // evidence reference required
    await event({ kind: "OPC_REPORTED", reference: "OPC-2026-1234", note: "Filed online" });
    await event({ kind: "INDIVIDUALS_NOTIFIED", reference: "Letters 2026-10-18", note: "Registered mail" });
    const closed = await event({ kind: "CLOSED", note: "All steps complete" });
    assert.equal(closed.statusCode, 201, closed.body);
    assert.deepEqual([closed.json().closed, closed.json().outstanding], [true, []]);
  });

  test("legal holds keep a deal out of the retention review", async () => {
    const old = await prisma.transaction.create({
      data: { dealNumber: `OLD-${randomUUID().slice(0, 6)}`, side: "BUYER", status: "CLOSED", streetAddress: "1 Old St", city: "Hamilton",
        salePrice: "300000", offerDate: new Date("2015-01-01"), closeDate: new Date("2015-03-01"), depositAmount: "0",
        trustDepositHolder: "COOP_BROKERAGE", totalGci: "7500" },
    });
    const listed = async () => (await as(u.compliance, "GET", "/api/privacy/retention-report")).json().eligibleForDisposalReview
      .some((d: { id: string }) => d.id === old.id);
    assert.equal(await listed(), true);
    const hold = (await as(u.compliance, "POST", "/api/privacy/legal-holds", { dealId: old.id, reason: "RECO inquiry 2026-44" })).json();
    assert.equal(await listed(), false);
    await as(u.broker, "POST", `/api/privacy/legal-holds/${hold.id}/release`, { note: "Inquiry closed" });
    assert.equal(await listed(), true);
  });
});
