/**
 * Document compliance: mandatory slots, uploads with FINTRAC metadata, and the
 * broker / compliance review workflow.
 *
 * Status changes and review authority are re-checked by the database trigger
 * from migration 004; files and reviews are append-only there too.
 */

import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type UserRole } from "@prisma/client";
import { requireRole, type Actor } from "../auth.ts";
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  fromDatabaseError,
  NotFoundError,
  RuleViolationError,
  ValidationError,
} from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import { formatCents } from "../lib/money.ts";
import type { FieldCipher } from "../security/crypto.ts";
import { openFintrac, sealFintrac } from "./protect.ts";
import {
  maskIdNumber,
  validateFintracCorporate,
  validateFintracIndividual,
  type FintracCorporateRecord,
  type FintracIndividualRecord,
  type FintracRecord,
} from "./fintrac.ts";
import { insertNotifications, NOTIFICATION_COLUMNS, type NotificationHub, type NotificationView } from "./notifications.ts";
import { canUpload, DOCUMENT_REVIEWERS, requiredSlots } from "./rules.ts";
import {
  ALLOWED_MIME_TYPES,
  contentMatchesMime,
  extensionFor,
  MAX_UPLOAD_BYTES,
  type FileStore,
} from "./storage.ts";
import type { CreateDealInput, PartyInput, ReviewInput } from "./validation.ts";

type Tx = Prisma.TransactionClient;

const STAFF: readonly UserRole[] = ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"];
const DEAL_AGENT_ROLES: readonly UserRole[] = ["AGENT", "MANAGING_BROKER"];

export interface ComplianceDeps {
  prisma: PrismaClient;
  store: FileStore;
  hub: NotificationHub;
  fieldCipher: FieldCipher;
}

// ── Views ────────────────────────────────────────────────────────────────────

export interface FileView {
  id: string;
  version: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadedById: string;
  uploadedAt: string;
  /** FINTRAC fields with the ID number masked; full record via GET /api/documents/files/:id */
  metadataSummary: Record<string, unknown> | null;
}

export interface SlotView {
  id: string;
  dealId: string;
  code: string;
  name: string;
  formNumber: string | null;
  metadataKind: string;
  party: { id: string; fullName: string; role: string; entityType: string } | null;
  status: string;
  isRequired: boolean;
  reviewerId: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  latestFile: FileView | null;
}

export interface DealDocuments {
  deal: { id: string; dealNumber: string; side: string; status: string; streetAddress: string; city: string };
  slots: SlotView[];
  summary: {
    required: number;
    approved: number;
    pendingReview: number;
    needsRevision: number;
    missing: number;
    complete: boolean; // every required slot approved or waived
  };
}

interface SlotRow {
  id: string;
  dealId: string;
  code: string;
  name: string;
  formNumber: string | null;
  metadataKind: string;
  partyId: string | null;
  partyName: string | null;
  partyRole: string | null;
  partyEntityType: string | null;
  status: string;
  isRequired: boolean;
  reviewerId: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  fileId: string | null;
  fileVersion: number | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  uploadedById: string | null;
  uploadedAt: string | null;
  metadata: FintracRecord | null;
}

const ts = (col: string) => Prisma.raw(`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

const SLOT_SELECT = Prisma.sql`
  SELECT s.id, s."transactionId" AS "dealId", t.code, t.name, t."formNumber", t."metadataKind"::text AS "metadataKind",
         s."partyId", p."fullName" AS "partyName", p.role::text AS "partyRole", p."entityType"::text AS "partyEntityType",
         s.status::text AS status, s."isRequired", s."reviewerId", ${ts('s."reviewedAt"')} AS "reviewedAt", s."reviewComment",
         f.id AS "fileId", f.version AS "fileVersion", f."fileName", f."mimeType", f."sizeBytes", f.sha256,
         f."uploadedById", ${ts('f."uploadedAt"')} AS "uploadedAt", f.metadata
    FROM "DocumentSlot" s
    JOIN "DocumentType" t ON t.id = s."documentTypeId"
    LEFT JOIN "TransactionParty" p ON p.id = s."partyId"
    LEFT JOIN LATERAL (
      SELECT * FROM "DocumentFile" df WHERE df."slotId" = s.id ORDER BY df.version DESC LIMIT 1
    ) f ON true`;

function summarize(metadata: FintracRecord | null): Record<string, unknown> | null {
  if (!metadata) return null;
  if (metadata.schema === "FINTRAC_INDIVIDUAL_V1") {
    return {
      fullLegalName: metadata.fullLegalName,
      idType: metadata.idType,
      idNumber: (metadata as { idNumberLast4?: string }).idNumberLast4
        ? `•••• ${(metadata as { idNumberLast4?: string }).idNumberLast4}`
        : maskIdNumber(metadata.idNumber),
      expiryDate: metadata.expiryDate,
      verificationDate: metadata.verificationDate,
      thirdPartyDetermination: metadata.thirdPartyDetermination,
    };
  }
  return {
    corporationLegalName: metadata.corporationLegalName,
    registrationNumber: metadata.registrationNumber,
    verificationDate: metadata.verificationDate,
    beneficialOwnerCount: metadata.beneficialOwners.length,
    thirdPartyDetermination: metadata.thirdPartyDetermination,
  };
}

function toSlotView(row: SlotRow): SlotView {
  return {
    id: row.id,
    dealId: row.dealId,
    code: row.code,
    name: row.name,
    formNumber: row.formNumber,
    metadataKind: row.metadataKind,
    party: row.partyId
      ? { id: row.partyId, fullName: row.partyName!, role: row.partyRole!, entityType: row.partyEntityType! }
      : null,
    status: row.status,
    isRequired: row.isRequired,
    reviewerId: row.reviewerId,
    reviewedAt: row.reviewedAt,
    reviewComment: row.reviewComment,
    latestFile: row.fileId
      ? {
          id: row.fileId,
          version: row.fileVersion!,
          fileName: row.fileName!,
          mimeType: row.mimeType!,
          sizeBytes: row.sizeBytes!,
          sha256: row.sha256!,
          uploadedById: row.uploadedById!,
          uploadedAt: row.uploadedAt!,
          metadataSummary: summarize(row.metadata),
        }
      : null,
  };
}

async function loadSlot(db: Tx | PrismaClient, slotId: string): Promise<SlotView> {
  const rows = await db.$queryRaw<SlotRow[]>`${SLOT_SELECT} WHERE s.id = ${slotId}::uuid`;
  if (!rows[0]) throw new NotFoundError("Document slot", slotId);
  return toSlotView(rows[0]);
}

// ── Access ───────────────────────────────────────────────────────────────────

async function assertDealAccess(db: Tx | PrismaClient, actor: Actor, dealId: string): Promise<void> {
  if (STAFF.includes(actor.role)) return;
  const onDeal = await db.transactionAgent.findFirst({ where: { transactionId: dealId, userId: actor.id } });
  if (!onDeal) throw new ForbiddenError("You can only work on documents for your own deals");
}

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  throw fromDatabaseError(err) ?? err;
}

// ── 1. Mandatory slots ───────────────────────────────────────────────────────

/**
 * Adds any missing mandatory slots for the deal. Safe to call repeatedly:
 * existing slots are left alone (and never removed).
 */
export async function ensureComplianceSlots(tx: Tx, dealId: string): Promise<number> {
  const deal = await tx.transaction.findUniqueOrThrow({
    where: { id: dealId },
    select: { side: true, parties: { select: { id: true, role: true, entityType: true, representation: true } } },
  });
  const types = await tx.documentType.findMany({
    select: { id: true, code: true, requiredFor: true, slotScope: true, isActive: true },
  });

  let created = 0;
  for (const spec of requiredSlots(deal.side, deal.parties, types)) {
    created += spec.partyId === null
      ? await tx.$executeRaw`
          INSERT INTO "DocumentSlot" (id, "documentTypeId", "transactionId", "updatedAt")
          VALUES (gen_random_uuid(), ${spec.documentTypeId}::uuid, ${dealId}::uuid, now())
          ON CONFLICT ("transactionId", "documentTypeId") WHERE "partyId" IS NULL AND "transactionId" IS NOT NULL
          DO NOTHING`
      : await tx.$executeRaw`
          INSERT INTO "DocumentSlot" (id, "documentTypeId", "transactionId", "partyId", "updatedAt")
          VALUES (gen_random_uuid(), ${spec.documentTypeId}::uuid, ${dealId}::uuid, ${spec.partyId}::uuid, now())
          ON CONFLICT ("transactionId", "documentTypeId", "partyId") WHERE "partyId" IS NOT NULL
          DO NOTHING`;
  }
  return created;
}

async function nextDealNumber(tx: Tx): Promise<string> {
  const year = todayInToronto().slice(0, 4);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('deal_number'))`;
  const [{ last }] = await tx.$queryRaw<{ last: number | null }[]>`
    SELECT MAX(substring("dealNumber" FROM 6)::int) AS last
      FROM "Transaction" WHERE "dealNumber" ~ ${`^${year}-[0-9]+$`}`;
  return `${year}-${String((last ?? 0) + 1).padStart(4, "0")}`;
}

export async function createDeal(deps: ComplianceDeps, actor: Actor, input: CreateDealInput): Promise<DealDocuments> {
  if (!STAFF.includes(actor.role) && !input.agents.some((a) => a.userId === actor.id)) {
    throw new ForbiddenError("Agents can only open deals they are on");
  }
  const agentUsers = await deps.prisma.user.findMany({
    where: { id: { in: input.agents.map((a) => a.userId) }, isActive: true, role: { in: [...DEAL_AGENT_ROLES] } },
    select: { id: true },
  });
  if (agentUsers.length !== input.agents.length) {
    throw new ValidationError([{ field: "agents", message: "every agent must be an active agent or broker" }]);
  }

  let dealId = "";
  try {
    await deps.prisma.$transaction(async (tx) => {
      const deal = await tx.transaction.create({
        data: {
          dealNumber: await nextDealNumber(tx),
          side: input.side,
          status: input.status,
          listingId: input.listingId,
          streetAddress: input.streetAddress,
          unit: input.unit,
          city: input.city,
          mlsNumber: input.mlsNumber,
          salePrice: formatCents(input.salePrice),
          offerDate: new Date(input.offerDate),
          conditionsDueDate: input.conditionsDueDate ? new Date(input.conditionsDueDate) : null,
          closeDate: new Date(input.closeDate),
          depositAmount: formatCents(input.depositAmount),
          depositDueDate: input.depositDueDate ? new Date(input.depositDueDate) : null,
          trustDepositHolder: input.trustDepositHolder,
          depositStatus: input.trustDepositHolder === "OUR_BROKERAGE" ? "AWAITING" : "HELD_ELSEWHERE",
          totalGci: formatCents(input.totalGci),
          coopBrokerageName: input.coopBrokerageName,
          coopCommission: formatCents(input.coopCommission),
          outsideReferralPayee: input.outsideReferralPayee,
          outsideReferralPct: input.outsideReferralPct === null ? null : input.outsideReferralPct.toFixed(2),
          // Amounts are worked out by the commission engine at closing
          agents: { create: input.agents.map((a) => ({ ...a, grossShare: "0", netPayout: "0" })) },
          parties: { create: input.parties },
        },
        select: { id: true },
      });
      dealId = deal.id;
      await ensureComplianceSlots(tx, deal.id);
    });
  } catch (err) {
    rethrow(err);
  }
  return getDealDocuments(deps.prisma, actor, dealId);
}

export async function addParty(
  deps: ComplianceDeps,
  actor: Actor,
  dealId: string,
  input: PartyInput,
): Promise<{ party: { id: string }; slotsAdded: number; documents: DealDocuments }> {
  await assertDealAccess(deps.prisma, actor, dealId);
  const result = await deps.prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Transaction" WHERE id = ${dealId}::uuid FOR UPDATE`;
    if (!locked[0]) throw new NotFoundError("Deal", dealId);
    const party = await tx.transactionParty.create({ data: { ...input, transactionId: dealId }, select: { id: true } });
    return { party, slotsAdded: await ensureComplianceSlots(tx, dealId) };
  }).catch(rethrow);
  return { ...result, documents: await getDealDocuments(deps.prisma, actor, dealId) };
}

export async function getDealDocuments(db: PrismaClient, actor: Actor, dealId: string): Promise<DealDocuments> {
  const deal = await db.transaction.findUnique({
    where: { id: dealId },
    select: { id: true, dealNumber: true, side: true, status: true, streetAddress: true, city: true },
  });
  if (!deal) throw new NotFoundError("Deal", dealId);
  await assertDealAccess(db, actor, dealId);

  const rows = await db.$queryRaw<SlotRow[]>`
    ${SLOT_SELECT}
    WHERE s."transactionId" = ${dealId}::uuid
    ORDER BY t."sortOrder", p."fullName" NULLS FIRST, s."createdAt"`;
  const slots = rows.map(toSlotView);
  const required = slots.filter((s) => s.isRequired);
  const count = (status: string) => required.filter((s) => s.status === status).length;

  return {
    deal,
    slots,
    summary: {
      required: required.length,
      approved: count("APPROVED"),
      pendingReview: count("PENDING_REVIEW"),
      needsRevision: count("NEEDS_REVISION"),
      missing: count("MISSING"),
      complete: required.every((s) => s.status === "APPROVED" || s.status === "WAIVED"),
    },
  };
}

// ── 2 + 3. Upload (Missing / Needs Revision -> Pending Review) ───────────────

export interface UploadInput {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  metadata: unknown; // parsed JSON, or undefined if not sent
}

export interface UploadResult {
  slot: SlotView;
  fileId: string;
  version: number;
  warnings: string[];
}

const sameName = (a: string, b: string) =>
  a.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase() ===
  b.normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();

export async function uploadDocument(
  deps: ComplianceDeps,
  actor: Actor,
  slotId: string,
  upload: UploadInput,
  today: string,
): Promise<UploadResult> {
  const slot = await deps.prisma.documentSlot.findUnique({
    where: { id: slotId },
    select: {
      status: true,
      transactionId: true,
      documentType: { select: { name: true, metadataKind: true } },
      party: { select: { fullName: true } },
    },
  });
  if (!slot) throw new NotFoundError("Document slot", slotId);
  if (!slot.transactionId) {
    throw new RuleViolationError("LISTING_SLOTS_NOT_SUPPORTED", "Uploads to listing checklists aren't supported yet");
  }
  const dealId = slot.transactionId;
  await assertDealAccess(deps.prisma, actor, dealId);
  if (!canUpload(slot.status)) {
    throw new ConflictError("DOCUMENT_LOCKED", `${slot.documentType.name} is ${slot.status}; it can't be replaced`);
  }

  // File checks
  const issues = [];
  if (!ALLOWED_MIME_TYPES.includes(upload.mimeType)) {
    issues.push({ field: "file", message: `must be one of ${ALLOWED_MIME_TYPES.join(", ")}` });
  } else if (!contentMatchesMime(upload.bytes, upload.mimeType)) {
    issues.push({ field: "file", message: `content is not a real ${upload.mimeType} file` });
  }
  if (upload.bytes.length === 0 || upload.bytes.length > MAX_UPLOAD_BYTES) {
    issues.push({ field: "file", message: `must be between 1 byte and ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` });
  }
  if (issues.length > 0) throw new ValidationError(issues);

  // Metadata: required for FINTRAC records, not accepted for anything else
  const kind = slot.documentType.metadataKind;
  let metadata: FintracRecord | null = null;
  const warnings: string[] = [];
  if (kind === "NONE") {
    if (upload.metadata !== undefined) {
      throw new ValidationError([{ field: "metadata", message: `is not used for ${slot.documentType.name}` }]);
    }
  } else {
    if (upload.metadata === undefined) {
      throw new ValidationError([{ field: "metadata", message: `is required for ${slot.documentType.name}` }]);
    }
    if (kind === "FINTRAC_INDIVIDUAL") {
      const record: FintracIndividualRecord = validateFintracIndividual(upload.metadata, today);
      if (slot.party && !sameName(record.fullLegalName, slot.party.fullName)) warnings.push("LEGAL_NAME_DIFFERS_FROM_PARTY");
      metadata = record;
    } else {
      const record: FintracCorporateRecord = validateFintracCorporate(upload.metadata, today);
      if (slot.party && !sameName(record.corporationLegalName, slot.party.fullName)) warnings.push("LEGAL_NAME_DIFFERS_FROM_PARTY");
      metadata = record;
    }
  }

  // Bytes first; a failed transaction leaves an orphaned blob, never a row without its file
  const sha256 = createHash("sha256").update(upload.bytes).digest("hex");
  const storageKey = `deals/${dealId}/${slotId}/${randomUUID()}${extensionFor(upload.mimeType)}`;
  await deps.store.put(storageKey, upload.bytes, upload.mimeType);

  try {
    const { fileId, version } = await deps.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM "DocumentSlot" WHERE id = ${slotId}::uuid FOR UPDATE`;
      if (!canUpload(locked!.status as never)) {
        throw new ConflictError("DOCUMENT_LOCKED", `This document became ${locked!.status} while uploading`);
      }
      const [{ next }] = await tx.$queryRaw<{ next: number }[]>`
        SELECT (COALESCE(MAX(version), 0) + 1)::int AS next FROM "DocumentFile" WHERE "slotId" = ${slotId}::uuid`;
      const [file] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "DocumentFile" (id, "slotId", version, "fileName", "storageKey", "mimeType", "sizeBytes", sha256,
                                    "metadataKind", metadata, "uploadedById")
        VALUES (gen_random_uuid(), ${slotId}::uuid, ${next}::int, ${upload.fileName}, ${storageKey}, ${upload.mimeType},
                ${upload.bytes.length}::int, ${sha256}, ${kind}::"DocumentMetadataKind",
                ${metadata === null ? null : JSON.stringify(sealFintrac(metadata, deps.fieldCipher))}::jsonb, ${actor.id}::uuid)
        RETURNING id`;
      await tx.$executeRaw`
        UPDATE "DocumentSlot" SET status = 'PENDING_REVIEW', "updatedAt" = now() WHERE id = ${slotId}::uuid`;
      return { fileId: file!.id, version: next };
    });
    return { slot: await loadSlot(deps.prisma, slotId), fileId, version, warnings };
  } catch (err) {
    rethrow(err);
  }
}

// ── 4. Review (Pending Review -> Approved | Needs Revision) ──────────────────

export interface ReviewResult {
  slot: SlotView;
  review: { id: string; decision: string; comment: string | null; fileId: string; reviewerId: string; createdAt: string };
  notified: string[];
}

export async function reviewDocument(
  deps: ComplianceDeps,
  actor: Actor,
  slotId: string,
  input: ReviewInput,
): Promise<ReviewResult> {
  requireRole(actor, DOCUMENT_REVIEWERS, "Reviewing documents");

  let notifications: NotificationView[] = [];
  try {
    const review = await deps.prisma.$transaction(async (tx) => {
      const [slot] = await tx.$queryRaw<{
        status: string; dealId: string | null; partyId: string | null; name: string; metadataKind: string;
      }[]>`
        SELECT s.status::text AS status, s."transactionId" AS "dealId", s."partyId", t.name,
               t."metadataKind"::text AS "metadataKind"
          FROM "DocumentSlot" s JOIN "DocumentType" t ON t.id = s."documentTypeId"
         WHERE s.id = ${slotId}::uuid
           FOR UPDATE OF s`;
      if (!slot) throw new NotFoundError("Document slot", slotId);
      if (slot.status !== "PENDING_REVIEW") {
        throw new ConflictError("NOT_PENDING_REVIEW", `${slot.name} is ${slot.status}, not waiting for review`);
      }

      // The reviewer must be looking at the latest upload
      const [latest] = await tx.$queryRaw<{ id: string; uploadedById: string; metadata: FintracRecord | null }[]>`
        SELECT id, "uploadedById", metadata FROM "DocumentFile"
         WHERE "slotId" = ${slotId}::uuid ORDER BY version DESC LIMIT 1`;
      if (!latest || latest.id !== input.fileId) {
        throw new ConflictError("STALE_REVIEW", "A newer version was uploaded; review the latest file", {
          latestFileId: latest?.id ?? null,
        });
      }

      const [review] = await tx.$queryRaw<ReviewResult["review"][]>`
        INSERT INTO "DocumentReview" (id, "slotId", "fileId", decision, comment, "reviewerId")
        VALUES (gen_random_uuid(), ${slotId}::uuid, ${input.fileId}::uuid, ${input.decision}::"ReviewDecision",
                ${input.comment}, ${actor.id}::uuid)
        RETURNING id, decision::text AS decision, comment, "fileId", "reviewerId", ${ts('"createdAt"')} AS "createdAt"`;

      await tx.$executeRaw`
        UPDATE "DocumentSlot"
           SET status = ${input.decision}::"DocumentStatus", "reviewerId" = ${actor.id}::uuid,
               "reviewComment" = ${input.comment}, "reviewedAt" = clock_timestamp(), "updatedAt" = now()
         WHERE id = ${slotId}::uuid`;

      // An approved FINTRAC ID record marks the client as identified
      if (input.decision === "APPROVED" && slot.partyId && latest.metadata?.schema === "FINTRAC_INDIVIDUAL_V1") {
        await tx.transactionParty.update({
          where: { id: slot.partyId },
          data: {
            fintracIdVerifiedAt: new Date(`${latest.metadata.verificationDate}T12:00:00Z`),
            fintracIdMethod: `Government-issued photo ID (${latest.metadata.idType})`,
          },
        });
      }

      // Notify the deal's agents and whoever uploaded the file, but not the reviewer
      const deal = await tx.transaction.findUniqueOrThrow({
        where: { id: slot.dealId! },
        select: { dealNumber: true, streetAddress: true, agents: { select: { userId: true } } },
      });
      const recipients = [...deal.agents.map((a) => a.userId), latest.uploadedById].filter((id) => id !== actor.id);
      const where = `${deal.dealNumber} · ${deal.streetAddress}`;
      notifications = await insertNotifications(tx, {
        userIds: recipients,
        type: input.decision === "NEEDS_REVISION" ? "DOCUMENT_NEEDS_REVISION" : "DOCUMENT_APPROVED",
        title: input.decision === "NEEDS_REVISION" ? `Needs revision: ${slot.name}` : `Approved: ${slot.name}`,
        body: input.decision === "NEEDS_REVISION" ? `${where} — ${input.comment}` : where,
        dealId: slot.dealId,
        slotId,
      });
      return review!;
    });

    // Only after commit, so nobody is told about a decision that rolled back
    for (const n of notifications) deps.hub.publish(n);
    return { slot: await loadSlot(deps.prisma, slotId), review, notified: notifications.map((n) => n.userId) };
  } catch (err) {
    rethrow(err);
  }
}

// ── Files ────────────────────────────────────────────────────────────────────

export async function getFile(
  deps: ComplianceDeps,
  actor: Actor,
  fileId: string,
): Promise<{ file: FileView & { slotId: string; metadata: FintracRecord | null }; bytes: () => Promise<Buffer> }> {
  const file = await deps.prisma.documentFile.findUnique({
    where: { id: fileId },
    include: { slot: { select: { transactionId: true } } },
  });
  if (!file || !file.slot.transactionId) throw new NotFoundError("File", fileId);
  await assertDealAccess(deps.prisma, actor, file.slot.transactionId);
  const metadata = file.metadata as unknown as FintracRecord | null;
  return {
    file: {
      id: file.id,
      slotId: file.slotId,
      version: file.version,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      uploadedById: file.uploadedById,
      uploadedAt: file.uploadedAt.toISOString(),
      metadataSummary: summarize(metadata),
      // Full FINTRAC record (whole ID number) only for staff; agents see the masked summary
      metadata: STAFF.includes(actor.role) ? openFintrac(metadata as unknown as Record<string, unknown> | null, deps.fieldCipher) : null,
    },
    bytes: () => deps.store.get(file.storageKey),
  };
}

// ── Notifications ────────────────────────────────────────────────────────────

export async function listNotifications(db: PrismaClient, actor: Actor, unreadOnly: boolean): Promise<NotificationView[]> {
  return db.$queryRaw<NotificationView[]>`
    SELECT ${NOTIFICATION_COLUMNS} FROM "Notification" n
     WHERE n."userId" = ${actor.id}::uuid AND (${!unreadOnly} OR n."readAt" IS NULL)
     ORDER BY n."createdAt" DESC
     LIMIT 100`;
}

export async function markNotificationRead(db: PrismaClient, actor: Actor, id: string): Promise<NotificationView> {
  const [row] = await db.$queryRaw<NotificationView[]>`
    UPDATE "Notification" AS n SET "readAt" = COALESCE(n."readAt", clock_timestamp())
     WHERE n.id = ${id}::uuid AND n."userId" = ${actor.id}::uuid
    RETURNING ${NOTIFICATION_COLUMNS}`;
  if (!row) throw new NotFoundError("Notification", id);
  return row;
}
