/** Shapes returned by the back office API (backend/src/compliance). */

export type DocumentStatus = "MISSING" | "PENDING_REVIEW" | "APPROVED" | "NEEDS_REVISION" | "WAIVED";
export type UserRole = "ADMIN" | "MANAGING_BROKER" | "COMPLIANCE_ADMIN" | "AGENT";
export type MetadataKind = "NONE" | "FINTRAC_INDIVIDUAL" | "FINTRAC_CORPORATE";

export interface FileView {
  id: string;
  version: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadedById: string;
  uploadedAt: string;
  metadataSummary: Record<string, unknown> | null;
}

export interface SlotView {
  id: string;
  dealId: string;
  code: string;
  name: string;
  formNumber: string | null;
  metadataKind: MetadataKind;
  party: { id: string; fullName: string; role: string; entityType: string } | null;
  status: DocumentStatus;
  isRequired: boolean;
  reviewerId: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  latestFile: FileView | null;
}

export interface DealSummary {
  required: number;
  approved: number;
  pendingReview: number;
  needsRevision: number;
  missing: number;
  complete: boolean;
}

export interface DealDocuments {
  deal: { id: string; dealNumber: string; side: string; status: string; streetAddress: string; city: string };
  slots: SlotView[];
  summary: DealSummary;
}

export interface UploadResult {
  slot: SlotView;
  fileId: string;
  version: number;
  warnings: string[];
}

export interface ReviewResult {
  slot: SlotView;
  review: { id: string; decision: "APPROVED" | "NEEDS_REVISION"; comment: string | null; fileId: string; reviewerId: string; createdAt: string };
  notified: string[];
}

export interface NotificationView {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  dealId: string | null;
  slotId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface FieldIssue {
  field: string;
  message: string;
}

/** Error body: { error: { code, message, details } } */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level problems from a 400, keyed by path ("metadata.expiryDate"). */
  get fieldErrors(): Record<string, string> {
    const issues = (this.details?.issues as FieldIssue[] | undefined) ?? [];
    return Object.fromEntries(issues.map((i) => [i.field, i.message]));
  }
}

export interface Viewer {
  id: string;
  role: UserRole;
}
