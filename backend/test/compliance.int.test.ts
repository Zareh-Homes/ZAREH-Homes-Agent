/**
 * Document compliance integration tests. Needs DATABASE_URL pointing at a
 * database with migrations 001–004 applied; skipped otherwise.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient, type UserRole } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { devHeaderResolver } from "../src/auth.ts";
import { TEST_BROKERAGE } from "./fixtures.ts";
import { fromDatabaseError } from "../src/errors.ts";
import { NotificationHub } from "../src/compliance/notifications.ts";
import { MemoryStore } from "../src/compliance/storage.ts";

const skip = process.env.DATABASE_URL ? false : "DATABASE_URL not set";
const TODAY = "2026-10-17";
const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const FINTRAC_ID = {
  verificationDate: "2026-10-15",
  fullLegalName: "Maria Elena Santos",
  dateOfBirth: "1988-04-02",
  address: "12 King St W, Hamilton ON",
  occupation: "Registered nurse",
  idType: "DRIVERS_LICENCE",
  idNumber: "S1234-56789-80402",
  issuingJurisdiction: "Ontario, Canada",
  expiryDate: "2029-04-02",
  thirdPartyDetermination: false,
};

/** Builds a multipart/form-data body without any extra dependency. */
function multipart(file: { name: string; type: string; bytes: Buffer } | null, metadata?: unknown) {
  const boundary = `----zareh${randomUUID()}`;
  const chunks: Buffer[] = [];
  if (metadata !== undefined) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${typeof metadata === "string" ? metadata : JSON.stringify(metadata)}\r\n`,
    ));
  }
  if (file) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ));
    chunks.push(file.bytes, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

describe("document compliance API", { skip }, () => {
  const prisma = new PrismaClient();
  const hub = new NotificationHub();
  const store = new MemoryStore();
  const app = buildApp({ prisma, resolveUserId: devHeaderResolver, fileStore: store, notificationHub: hub, brokerage: TEST_BROKERAGE, today: () => TODAY });
  const u = { broker: "", compliance: "", admin: "", agent: "", otherAgent: "" };
  let baseUrl = "";

  before(async () => {
    const make = async (role: UserRole) =>
      (await prisma.user.create({
        data: { email: `${role.toLowerCase()}-${randomUUID()}@zareh.test`, firstName: role, lastName: "Test", role },
      })).id;
    u.broker = await make("MANAGING_BROKER");
    u.compliance = await make("COMPLIANCE_ADMIN");
    u.admin = await make("ADMIN");
    u.agent = await make("AGENT");
    u.otherAgent = await make("AGENT");
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const json = (method: "GET" | "POST", url: string, user: string, body?: unknown) =>
    app.inject({ method, url, headers: { "x-user-id": user }, ...(body === undefined ? {} : { payload: body as object }) });

  const upload = (slotId: string, user: string, file: Parameters<typeof multipart>[0], metadata?: unknown) => {
    const { payload, contentType } = multipart(file, metadata);
    return app.inject({
      method: "POST", url: `/api/documents/slots/${slotId}/files`, payload,
      headers: { "x-user-id": user, "content-type": contentType },
    });
  };

  const review = (slotId: string, user: string, body: object) =>
    json("POST", `/api/documents/slots/${slotId}/review`, user, body);

  function dealBody(side: string, parties: object[], extra: object = {}) {
    return {
      side,
      streetAddress: "45 Lakeshore Rd",
      city: "Oakville",
      salePrice: "1250000",
      offerDate: "2026-10-10",
      closeDate: "2026-12-15",
      depositAmount: "50000",
      trustDepositHolder: side === "BUYER" ? "COOP_BROKERAGE" : "OUR_BROKERAGE",
      totalGci: "31250",
      agents: [{ userId: u.agent, role: "PRIMARY", splitPct: 80 }],
      parties,
      ...extra,
    };
  }

  type Slot = { id: string; code: string; status: string; party: { fullName: string } | null; latestFile: { id: string } | null };
  const slotCodes = (slots: Slot[]) => slots.map((s) => (s.party ? `${s.code}:${s.party.fullName}` : s.code)).sort();

  // ── 1. Mandatory slots on deal creation ────────────────────────────────────

  test("buyer deal opens with APS, Form 320 and a FINTRAC ID record per buyer", async () => {
    const res = await json("POST", "/api/deals", u.agent, dealBody("BUYER", [
      { role: "BUYER", fullName: "Maria Elena Santos" },
      { role: "BUYER", fullName: "Daniel Santos" },
      { role: "SELLER", fullName: "Other Side" },
    ]));
    assert.equal(res.statusCode, 201, res.body);
    const docs = res.json();
    assert.match(docs.deal.dealNumber, /^2026-\d{4}$/);
    assert.deepEqual(slotCodes(docs.slots), [
      "APS", "FINTRAC_INDIVIDUAL:Daniel Santos", "FINTRAC_INDIVIDUAL:Maria Elena Santos", "FORM_320",
    ]);
    assert.ok(docs.slots.every((s: Slot) => s.status === "MISSING"));
    assert.deepEqual(docs.summary, { required: 4, approved: 0, pendingReview: 0, needsRevision: 0, missing: 4, complete: false });
  });

  test("seller deal with a corporate seller gets the corporate / beneficial ownership record", async () => {
    const res = await json("POST", "/api/deals", u.agent, dealBody("LISTING", [
      { role: "SELLER", fullName: "Paul Chen" },
      { role: "SELLER", entityType: "CORPORATION", fullName: "2468013 Ontario Inc." },
    ]));
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(slotCodes(res.json().slots), [
      "FINTRAC_CORPORATE:2468013 Ontario Inc.", "FINTRAC_INDIVIDUAL:Paul Chen", "FORM_200",
    ]);
  });

  test("adding a client later adds their FINTRAC slot, once", async () => {
    const dealId = (await json("POST", "/api/deals", u.agent, dealBody("LISTING", [{ role: "SELLER", fullName: "Ann Lee" }]))).json().deal.id;
    const add = await json("POST", `/api/deals/${dealId}/parties`, u.agent, {
      role: "SELLER", entityType: "CORPORATION", fullName: "Lee Holdings Ltd.",
    });
    assert.equal(add.statusCode, 201, add.body);
    assert.equal(add.json().slotsAdded, 1);
    const lawyer = await json("POST", `/api/deals/${dealId}/parties`, u.agent, { role: "SELLER_LAWYER", fullName: "Smith LLP" });
    assert.equal(lawyer.json().slotsAdded, 0); // lawyers aren't our clients
    assert.equal(lawyer.json().documents.slots.length, 3);
  });

  test("deal creation is validated and agents can only open their own deals", async () => {
    const notMine = await json("POST", "/api/deals", u.otherAgent, dealBody("BUYER", [{ role: "BUYER", fullName: "X Y" }]));
    assert.equal(notMine.statusCode, 403);
    const noClient = await json("POST", "/api/deals", u.agent, dealBody("BUYER", [{ role: "SELLER", fullName: "X Y" }]));
    assert.equal(noClient.statusCode, 400);
    assert.equal(noClient.json().error.details.issues[0].field, "parties");
  });

  // ── 2 + 3 + 4. Upload, review, notify ──────────────────────────────────────

  async function buyerDeal() {
    const docs = (await json("POST", "/api/deals", u.agent, dealBody("BUYER", [{ role: "BUYER", fullName: "Maria Elena Santos" }]))).json();
    const slot = (code: string) => docs.slots.find((s: Slot) => s.code === code) as Slot;
    return { dealId: docs.deal.id as string, aps: slot("APS"), f320: slot("FORM_320"), fintrac: slot("FINTRAC_INDIVIDUAL") };
  }

  test("uploads: file type is checked by content, and metadata only goes on FINTRAC records", async () => {
    const { aps, fintrac } = await buyerDeal();
    const fake = await upload(aps.id, u.agent, { name: "aps.pdf", type: "application/pdf", bytes: Buffer.from("MZ not really a pdf") });
    assert.equal(fake.statusCode, 400);
    const exe = await upload(aps.id, u.agent, { name: "aps.exe", type: "application/x-msdownload", bytes: PDF });
    assert.equal(exe.statusCode, 400);
    const extra = await upload(aps.id, u.agent, { name: "aps.pdf", type: "application/pdf", bytes: PDF }, { note: "x" });
    assert.equal(extra.statusCode, 400);
    assert.equal(extra.json().error.details.issues[0].field, "metadata");
    const noFile = await upload(aps.id, u.agent, null);
    assert.equal(noFile.statusCode, 400);

    const missingMeta = await upload(fintrac.id, u.agent, { name: "id.jpg", type: "image/jpeg", bytes: JPEG });
    assert.equal(missingMeta.statusCode, 400);
    const badJson = await upload(fintrac.id, u.agent, { name: "id.jpg", type: "image/jpeg", bytes: JPEG }, "{oops");
    assert.equal(badJson.statusCode, 400);
    const expired = await upload(fintrac.id, u.agent, { name: "id.jpg", type: "image/jpeg", bytes: JPEG }, { ...FINTRAC_ID, expiryDate: "2026-01-01" });
    assert.equal(expired.statusCode, 400);
    assert.deepEqual(expired.json().error.details.issues.map((i: { field: string }) => i.field), ["metadata.expiryDate"]);

    const ok = await upload(fintrac.id, u.agent, { name: "id.jpg", type: "image/jpeg", bytes: JPEG }, FINTRAC_ID);
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal(ok.json().slot.status, "PENDING_REVIEW");
    assert.equal(ok.json().version, 1);
    assert.deepEqual(ok.json().warnings, []);
    assert.equal(ok.json().slot.latestFile.metadataSummary.idNumber, "•••• 0402"); // masked in list views
  });

  test("FINTRAC upload warns when the legal name doesn't match the client on the deal", async () => {
    const { fintrac } = await buyerDeal();
    const res = await upload(fintrac.id, u.agent, { name: "id.jpg", type: "image/jpeg", bytes: JPEG }, { ...FINTRAC_ID, fullLegalName: "Someone Else" });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json().warnings, ["LEGAL_NAME_DIFFERS_FROM_PARTY"]);
  });

  test("full lifecycle: Needs Revision with a comment notifies the agent live; re-upload; Approved locks it", async () => {
    const { dealId, aps } = await buyerDeal();
    const first = (await upload(aps.id, u.agent, { name: "aps.pdf", type: "application/pdf", bytes: PDF })).json();

    // Agent connects to the live notification stream
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/notifications/stream`, { headers: { "x-user-id": u.agent }, signal: controller.signal });
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const reader = stream.body!.getReader();
    const received = (async () => {
      let text = "";
      while (!text.includes("event: notification")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      return text;
    })();
    while (hub.connectedUsers() === 0) await new Promise((r) => setTimeout(r, 10));

    // Only brokers / compliance admins review, and "needs revision" must say why
    assert.equal((await review(aps.id, u.agent, { decision: "APPROVED", fileId: first.fileId })).statusCode, 403);
    assert.equal((await review(aps.id, u.admin, { decision: "APPROVED", fileId: first.fileId })).statusCode, 403);
    assert.equal((await review(aps.id, u.compliance, { decision: "NEEDS_REVISION", fileId: first.fileId })).statusCode, 400);

    const comment = "APS missing Seller initials on page 3";
    const sentBack = await review(aps.id, u.compliance, { decision: "NEEDS_REVISION", comment, fileId: first.fileId });
    assert.equal(sentBack.statusCode, 200, sentBack.body);
    assert.equal(sentBack.json().slot.status, "NEEDS_REVISION");
    assert.equal(sentBack.json().slot.reviewComment, comment);
    assert.deepEqual(sentBack.json().notified, [u.agent]);

    const event = await received;
    controller.abort();
    const data = JSON.parse(event.split("event: notification\ndata: ")[1]!.split("\n")[0]!);
    assert.equal(data.type, "DOCUMENT_NEEDS_REVISION");
    assert.equal(data.dealId, dealId);
    assert.match(data.body, /APS missing Seller initials on page 3/);

    // Stored too, for when the agent wasn't connected
    const inbox = await json("GET", "/api/notifications?unread=true", u.agent);
    const mine = inbox.json().find((n: { slotId: string }) => n.slotId === aps.id);
    assert.equal(mine.title, "Needs revision: Agreement of Purchase and Sale (APS)");
    const read = await json("POST", `/api/notifications/${mine.id}/read`, u.agent);
    assert.ok(read.json().readAt);
    assert.equal((await json("POST", `/api/notifications/${mine.id}/read`, u.otherAgent)).statusCode, 404);

    // Can't approve the old version once a new one is uploaded
    const second = (await upload(aps.id, u.agent, { name: "aps-v2.pdf", type: "application/pdf", bytes: PDF })).json();
    assert.equal(second.version, 2);
    assert.equal(second.slot.status, "PENDING_REVIEW");
    assert.equal(second.slot.reviewComment, null);
    const stale = await review(aps.id, u.broker, { decision: "APPROVED", fileId: first.fileId });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "STALE_REVIEW");

    const approved = await review(aps.id, u.broker, { decision: "APPROVED", fileId: second.fileId });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().slot.status, "APPROVED");
    assert.equal(approved.json().slot.reviewerId, u.broker);

    // Approved is final
    const locked = await upload(aps.id, u.agent, { name: "aps-v3.pdf", type: "application/pdf", bytes: PDF });
    assert.equal(locked.statusCode, 409);
    assert.equal(locked.json().error.code, "DOCUMENT_LOCKED");
    assert.equal((await review(aps.id, u.broker, { decision: "APPROVED", fileId: second.fileId })).json().error.code, "NOT_PENDING_REVIEW");

    const history = await prisma.documentReview.findMany({ where: { slotId: aps.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(history.map((h) => h.decision), ["NEEDS_REVISION", "APPROVED"]);
  });

  test("approving a FINTRAC ID record marks the client identified; full ID number is staff-only", async () => {
    const { dealId, fintrac } = await buyerDeal();
    const up = (await upload(fintrac.id, u.agent, { name: "id.jpg", type: "image/jpeg", bytes: JPEG }, FINTRAC_ID)).json();
    assert.equal((await review(fintrac.id, u.compliance, { decision: "APPROVED", fileId: up.fileId })).statusCode, 200);

    const party = await prisma.transactionParty.findFirstOrThrow({ where: { transactionId: dealId, role: "BUYER" } });
    assert.equal(party.fintracIdVerifiedAt?.toISOString().slice(0, 10), "2026-10-15");
    assert.equal(party.fintracIdMethod, "Government-issued photo ID (DRIVERS_LICENCE)");

    const asStaff = (await json("GET", `/api/documents/files/${up.fileId}`, u.compliance)).json();
    assert.equal(asStaff.metadata.idNumber, "S1234-56789-80402");
    const asAgent = (await json("GET", `/api/documents/files/${up.fileId}`, u.agent)).json();
    assert.equal(asAgent.metadata, null);
    assert.equal(asAgent.metadataSummary.idNumber, "•••• 0402");
    assert.equal((await json("GET", `/api/documents/files/${up.fileId}`, u.otherAgent)).statusCode, 403);

    const content = await json("GET", `/api/documents/files/${up.fileId}/content`, u.agent);
    assert.equal(content.headers["content-type"], "image/jpeg");
    assert.deepEqual(content.rawPayload, JPEG);
  });

  test("checklist is complete only when every required slot is approved", async () => {
    const { dealId, aps, f320, fintrac } = await buyerDeal();
    for (const [slot, file, meta] of [
      [aps, { name: "aps.pdf", type: "application/pdf", bytes: PDF }, undefined],
      [f320, { name: "320.pdf", type: "application/pdf", bytes: PDF }, undefined],
      [fintrac, { name: "id.jpg", type: "image/jpeg", bytes: JPEG }, FINTRAC_ID],
    ] as const) {
      const up = (await upload(slot.id, u.agent, file, meta)).json();
      await review(slot.id, u.broker, { decision: "APPROVED", fileId: up.fileId });
    }
    const docs = (await json("GET", `/api/deals/${dealId}/documents`, u.agent)).json();
    assert.equal(docs.summary.complete, true);
    assert.equal((await json("GET", `/api/deals/${dealId}/documents`, u.otherAgent)).statusCode, 403);
  });

  // ── Database-level guards ──────────────────────────────────────────────────

  test("the database refuses illegal status jumps, non-reviewer approvals and edits to history", async () => {
    const { aps, f320 } = await buyerDeal();
    const up = (await upload(aps.id, u.agent, { name: "aps.pdf", type: "application/pdf", bytes: PDF })).json();
    const dbCode = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (err) {
        return fromDatabaseError(err)?.code;
      }
      return "no error";
    };
    assert.equal(
      await dbCode(() => prisma.$executeRaw`UPDATE "DocumentSlot" SET status = 'APPROVED', "reviewerId" = ${u.broker}::uuid, "reviewedAt" = now() WHERE id = ${f320.id}::uuid`),
      "ILLEGAL_STATUS_CHANGE", // Missing -> Approved
    );
    assert.equal(
      await dbCode(() => prisma.$executeRaw`UPDATE "DocumentSlot" SET status = 'APPROVED', "reviewerId" = ${u.agent}::uuid, "reviewedAt" = now() WHERE id = ${aps.id}::uuid`),
      "FORBIDDEN", // an agent can't approve, even straight in SQL
    );
    assert.equal(
      await dbCode(() => prisma.$executeRaw`UPDATE "DocumentFile" SET "fileName" = 'x.pdf' WHERE id = ${up.fileId}::uuid`),
      "APPEND_ONLY",
    );
    assert.equal(await dbCode(() => prisma.$executeRaw`DELETE FROM "DocumentFile" WHERE id = ${up.fileId}::uuid`), "APPEND_ONLY");
  });
});
