import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpApi, type ComplianceApi } from "../src/compliance/api.ts";
import { createComplianceController, createStore } from "../src/compliance/controller.ts";
import { selectChecklist, selectUnreadCount, slotActions, STATUS_DISPLAY } from "../src/compliance/state.ts";
import { ApiError, type DealDocuments, type NotificationView, type SlotView, type Viewer } from "../src/compliance/types.ts";

const AGENT: Viewer = { id: "agent-1", role: "AGENT" };
const BROKER: Viewer = { id: "broker-1", role: "MANAGING_BROKER" };
const DEAL = "deal-1";

function slot(id: string, over: Partial<SlotView> = {}): SlotView {
  return {
    id, dealId: DEAL, code: id.toUpperCase(), name: id, formNumber: null, metadataKind: "NONE", party: null,
    status: "MISSING", isRequired: true, reviewerId: null, reviewedAt: null, reviewComment: null, latestFile: null, ...over,
  };
}

const file = (id: string) => ({
  id, version: 1, fileName: "x.pdf", mimeType: "application/pdf", sizeBytes: 10, sha256: "h",
  uploadedById: "agent-1", uploadedAt: "2026-10-17T12:00:00.000000Z", metadataSummary: null,
});

function docs(slots: SlotView[]): DealDocuments {
  return {
    deal: { id: DEAL, dealNumber: "2026-0042", side: "BUYER", status: "FIRM", streetAddress: "45 Lakeshore Rd", city: "Oakville" },
    slots,
    summary: { required: 0, approved: 0, pendingReview: 0, needsRevision: 0, missing: 0, complete: false },
  };
}

const notification = (id: string, over: Partial<NotificationView> = {}): NotificationView => ({
  id, userId: "agent-1", type: "DOCUMENT_NEEDS_REVISION", title: "Needs revision: APS", body: "…",
  dealId: DEAL, slotId: "aps", createdAt: `2026-10-17T12:00:0${id.slice(-1)}.000000Z`, readAt: null, ...over,
});

/** A fake API that records calls; override any method per test. */
function fakeApi(over: Partial<ComplianceApi> = {}) {
  const calls: string[] = [];
  let push: ((n: NotificationView) => void) | null = null;
  const api: ComplianceApi = {
    getDealDocuments: async (id) => (calls.push(`load:${id}`), docs([])),
    uploadDocument: async () => { throw new Error("not stubbed"); },
    reviewDocument: async () => { throw new Error("not stubbed"); },
    listNotifications: async () => [],
    markNotificationRead: async (id) => notification(id, { readAt: "2026-10-17T13:00:00.000000Z" }),
    subscribeNotifications: ({ onNotification, onConnectionChange }) => {
      push = onNotification;
      onConnectionChange(true);
      return () => onConnectionChange(false);
    },
    ...over,
  };
  return { api, calls, push: (n: NotificationView) => push!(n) };
}

test("checklist: groups by deal / client, counts progress, and lists what's blocking (revisions first)", async () => {
  const { api } = fakeApi({
    getDealDocuments: async () => docs([
      slot("aps", { status: "APPROVED", latestFile: file("f1") }),
      slot("f320", { status: "PENDING_REVIEW", latestFile: file("f2") }),
      slot("fintrac", {
        metadataKind: "FINTRAC_INDIVIDUAL", status: "NEEDS_REVISION", reviewComment: "FINTRAC ID expired",
        party: { id: "p1", fullName: "Maria Santos", role: "BUYER", entityType: "INDIVIDUAL" }, latestFile: file("f3"),
      }),
      slot("optional", { isRequired: false }),
    ]),
  });
  const store = createStore();
  await createComplianceController({ api, store, viewer: AGENT }).loadDeal(DEAL);

  const c = selectChecklist(store.getState(), DEAL)!;
  assert.equal(c.status, "ready");
  assert.deepEqual(c.groups.map((g) => [g.title, g.slots.map((s) => s.id)]), [
    ["Deal documents", ["aps", "f320", "optional"]],
    ["FINTRAC — Maria Santos", ["fintrac"]],
  ]);
  assert.equal(c.summary.required, 3);
  assert.equal(c.summary.percentComplete, 33);
  assert.equal(c.summary.complete, false);
  assert.deepEqual(c.blocking.map((b) => b.text), [
    "fintrac (Maria Santos): FINTRAC ID expired",
    "f320 is waiting for review",
  ]);
  assert.equal(STATUS_DISPLAY.NEEDS_REVISION.label, "Needs revision");
});

test("upload: success swaps in the server's slot and keeps warnings; a 400 maps errors to form fields", async () => {
  let attempt = 0;
  const { api } = fakeApi({
    getDealDocuments: async () => docs([slot("fintrac", { metadataKind: "FINTRAC_INDIVIDUAL" })]),
    uploadDocument: async () => {
      if (attempt++ === 0) {
        throw new ApiError(400, "VALIDATION_FAILED", "metadata.expiryDate: ID was already expired", {
          issues: [{ field: "metadata.expiryDate", message: "ID was already expired on the verification date (2026-10-15)" }],
        });
      }
      return {
        slot: slot("fintrac", { metadataKind: "FINTRAC_INDIVIDUAL", status: "PENDING_REVIEW", latestFile: file("f9") }),
        fileId: "f9", version: 1, warnings: ["LEGAL_NAME_DIFFERS_FROM_PARTY"],
      };
    },
  });
  const store = createStore();
  const ctl = createComplianceController({ api, store, viewer: AGENT });
  await ctl.loadDeal(DEAL);
  assert.equal(slotActions(store.getState(), "fintrac", AGENT).needsMetadata, true);

  await ctl.upload("fintrac", new Blob(["x"]), "id.jpg", { expiryDate: "2026-01-01" });
  assert.equal(store.getState().uploads.fintrac!.status, "error");
  assert.deepEqual(store.getState().uploads.fintrac!.fieldErrors, {
    "metadata.expiryDate": "ID was already expired on the verification date (2026-10-15)",
  });
  assert.equal(store.getState().slots.fintrac!.status, "MISSING");

  await ctl.upload("fintrac", new Blob(["x"]), "id.jpg", {});
  assert.equal(store.getState().slots.fintrac!.status, "PENDING_REVIEW");
  assert.deepEqual(store.getState().uploads.fintrac!.warnings, ["LEGAL_NAME_DIFFERS_FROM_PARTY"]);
});

test("review: only reviewers see the action; 'needs revision' without a real comment never hits the API", async () => {
  const reviewed: unknown[] = [];
  const { api } = fakeApi({
    getDealDocuments: async () => docs([slot("aps", { status: "PENDING_REVIEW", latestFile: file("f1") })]),
    reviewDocument: async (slotId, body) => {
      reviewed.push(body);
      return {
        slot: slot(slotId, { status: "NEEDS_REVISION", reviewComment: body.comment ?? null, latestFile: file("f1") }),
        review: { id: "r1", decision: body.decision, comment: body.comment ?? null, fileId: body.fileId, reviewerId: BROKER.id, createdAt: "" },
        notified: ["agent-1"],
      };
    },
  });
  const store = createStore();
  const ctl = createComplianceController({ api, store, viewer: BROKER });
  await ctl.loadDeal(DEAL);
  assert.equal(slotActions(store.getState(), "aps", AGENT).canReview, false);
  assert.equal(slotActions(store.getState(), "aps", BROKER).canReview, true);

  assert.equal(await ctl.review("aps", "NEEDS_REVISION", "  bad "), null);
  assert.deepEqual(reviewed, []);
  assert.ok(store.getState().reviews.aps!.fieldErrors.comment);

  await ctl.review("aps", "NEEDS_REVISION", "APS missing Seller initials on page 3");
  assert.deepEqual(reviewed, [{ decision: "NEEDS_REVISION", fileId: "f1", comment: "APS missing Seller initials on page 3" }]);
  assert.equal(store.getState().slots.aps!.status, "NEEDS_REVISION");
  assert.equal(slotActions(store.getState(), "aps", BROKER).canReview, false);
  assert.equal(slotActions(store.getState(), "aps", AGENT).canUpload, true);
});

test("review: a stale version reloads the checklist so the reviewer sees the new upload", async () => {
  const { api, calls } = fakeApi({
    getDealDocuments: async () => (calls.push("load"), docs([slot("aps", { status: "PENDING_REVIEW", latestFile: file("f1") })])),
    reviewDocument: async () => { throw new ApiError(409, "STALE_REVIEW", "A newer version was uploaded"); },
  });
  const store = createStore();
  const ctl = createComplianceController({ api, store, viewer: BROKER });
  await ctl.loadDeal(DEAL);
  await ctl.review("aps", "APPROVED");
  await new Promise((r) => setImmediate(r));
  assert.equal(store.getState().reviews.aps!.code, "STALE_REVIEW");
  assert.equal(calls.filter((c) => c === "load").length, 2);
});

test("notifications: unread list, live events (deduped), refresh of an open deal, mark read", async () => {
  const { api, calls, push } = fakeApi({ listNotifications: async () => [notification("n1")] });
  const store = createStore();
  const ctl = createComplianceController({ api, store, viewer: AGENT });
  await ctl.loadDeal(DEAL);
  const stop = await ctl.startNotifications();
  assert.equal(store.getState().notifications.connected, true);
  assert.equal(selectUnreadCount(store.getState()), 1);

  push(notification("n2"));
  push(notification("n2")); // redelivered after a reconnect
  assert.deepEqual(store.getState().notifications.items.map((n) => n.id), ["n2", "n1"]);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((c) => c === `load:${DEAL}`).length, 2); // open checklist refreshed

  await ctl.markRead("n2");
  assert.equal(selectUnreadCount(store.getState()), 1);
  stop();
  assert.equal(store.getState().notifications.connected, false);
});

test("http client: error bodies become ApiError with field errors; metadata is sent before the file", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const api = createHttpApi({
    baseUrl: "https://office.zareh.test",
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({
        error: { code: "VALIDATION_FAILED", message: "bad", details: { issues: [{ field: "comment", message: "is required" }] } },
      }), { status: 400 });
    }) as typeof fetch,
  });

  await assert.rejects(api.reviewDocument("s1", { decision: "NEEDS_REVISION", fileId: "f1" }), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    assert.deepEqual(err.fieldErrors, { comment: "is required" });
    return true;
  });
  await api.uploadDocument("s1", new Blob(["%PDF-"]), "aps.pdf", { a: 1 }).catch(() => {});
  const form = requests[1]!.init.body as FormData;
  assert.deepEqual([...form.keys()], ["metadata", "file"]);
  assert.equal(requests[1]!.url, "https://office.zareh.test/api/documents/slots/s1/files");
});
