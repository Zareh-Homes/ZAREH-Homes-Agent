/**
 * The deal's document checklist: upload, see what's waiting, and (for
 * reviewers) approve or send back. FINTRAC identification records carry the
 * verification details with the file; the server validates them.
 */

import { useState, type FormEvent } from "react";
import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { hasRole, useSession } from "../app/session.tsx";
import { Button, Checkbox, Empty, Loading, Notice, Section, SelectField, StatusBadge, TextArea, TextField, type Tone } from "../ui/kit.tsx";
import { InlineForm } from "../ui/Disclosure.tsx";
import { dateText, dateTimeText, labelOf } from "../ui/format.ts";
import type { TabProps } from "./DealWorkspace.tsx";

export interface FileView {
  id: string; version: number; fileName: string; mimeType: string; sizeBytes: number; uploadedAt: string;
  metadataSummary: Record<string, unknown> | null;
}
export interface SlotView {
  id: string; code: string; name: string; formNumber: string | null; metadataKind: "NONE" | "FINTRAC_INDIVIDUAL" | "FINTRAC_CORPORATE";
  party: { id: string; fullName: string; role: string; entityType: string } | null;
  status: "MISSING" | "PENDING_REVIEW" | "APPROVED" | "NEEDS_REVISION" | "WAIVED";
  isRequired: boolean; reviewedAt: string | null; reviewComment: string | null; latestFile: FileView | null;
}
interface DealDocuments { slots: SlotView[]; summary: { required: number; approved: number; pendingReview: number; needsRevision: number; missing: number; complete: boolean } }

export const SLOT_TONE: Record<SlotView["status"], Tone> = { MISSING: "critical", PENDING_REVIEW: "warning", APPROVED: "good", NEEDS_REVISION: "serious", WAIVED: "neutral" };
const ACCEPT = "application/pdf,image/jpeg,image/png,image/heic";

export function DocumentsTab({ deal }: TabProps) {
  const { user } = useSession();
  const docs = useApi<DealDocuments>(`/api/deals/${deal.id}/documents`);
  const reviewer = hasRole(user, ["MANAGING_BROKER", "COMPLIANCE_ADMIN"]);
  if (docs.status === "error" && !docs.data) return <Notice kind="error">{docs.message}</Notice>;
  if (!docs.data) return <Loading label="Loading documents" />;
  const s = docs.data.summary;

  return (
    <div className="space-y-5">
      <Notice kind={s.complete ? "success" : "info"} title={s.complete ? "Every required document is approved" : `${s.approved} of ${s.required} required documents approved`}>
        {!s.complete && `${s.missing} missing · ${s.pendingReview} waiting for review · ${s.needsRevision} sent back`}
      </Notice>
      <Section title="Checklist">
        {docs.data.slots.length === 0 ? <Empty>No documents are required for this deal.</Empty> : (
          <ul className="divide-y divide-line">
            {docs.data.slots.map((slot) => (
              <li key={slot.id} className="py-4" data-testid={`slot-${slot.code}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{slot.name}{slot.party ? ` · ${slot.party.fullName}` : ""}</p>
                    {slot.latestFile && (
                      <p className="text-xs text-ink-3">
                        Version {slot.latestFile.version}: {slot.latestFile.fileName} · uploaded {dateTimeText(slot.latestFile.uploadedAt)} ·{" "}
                        <a className="underline" href={`/api/documents/files/${slot.latestFile.id}/content`} target="_blank" rel="noreferrer">Open</a>
                      </p>
                    )}
                    {slot.latestFile?.metadataSummary && <FintracSummary summary={slot.latestFile.metadataSummary} />}
                    {slot.status === "NEEDS_REVISION" && slot.reviewComment && <p className="mt-1 text-sm text-serious">Sent back: {slot.reviewComment}</p>}
                  </div>
                  <StatusBadge tone={SLOT_TONE[slot.status]}>{labelOf(slot.status)}</StatusBadge>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {(slot.status === "MISSING" || slot.status === "NEEDS_REVISION" || slot.status === "PENDING_REVIEW") && (
                    <InlineForm label={slot.latestFile ? "Upload a new version" : "Upload"}>
                      {(close) => <Upload slot={slot} onDone={() => { close(); docs.reload(); }} onCancel={close} />}
                    </InlineForm>
                  )}
                  {reviewer && slot.status === "PENDING_REVIEW" && slot.latestFile && (
                    <InlineForm label="Review" variant="primary">
                      {(close) => <Review slot={slot} onDone={() => { close(); docs.reload(); }} onCancel={close} />}
                    </InlineForm>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function FintracSummary({ summary }: { summary: Record<string, unknown> }) {
  const parts = Object.entries(summary).filter(([, v]) => v !== null && v !== "").map(([k, v]) =>
    `${labelOf(k.replace(/([A-Z])/g, "_$1"))}: ${typeof v === "boolean" ? (v ? "yes" : "no") : /Date$/.test(k) ? dateText(String(v)) : String(v)}`);
  return <p className="mt-1 text-xs text-ink-2">{parts.join(" · ")}</p>;
}

export function Review({ slot, onDone, onCancel }: { slot: SlotView; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [comment, setComment] = useState("");
  const decide = async (decision: "APPROVED" | "NEEDS_REVISION") => {
    const ok = await act.run(() => api("POST", `/api/documents/slots/${slot.id}/review`, { decision, fileId: slot.latestFile!.id, ...(comment.trim() ? { comment } : {}) }));
    if (ok) onDone();
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-2">
        Open the file and check it{slot.metadataKind !== "NONE" ? " against the identification details" : ""} before deciding.
        Approved records are locked.
      </p>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <TextArea label="Comment" hint="Required when sending it back: say what to fix (at least 10 characters)" value={comment}
        onChange={(e) => setComment(e.target.value)} error={act.fields.comment} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" busy={act.busy} onClick={() => void decide("APPROVED")}>Approve</Button>
        <Button busy={act.busy} disabled={comment.trim().length < 10} onClick={() => void decide("NEEDS_REVISION")}>Send back</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

const ID_TYPES = ["DRIVERS_LICENCE", "PASSPORT", "PERMANENT_RESIDENT_CARD", "PROVINCIAL_PHOTO_ID_CARD", "SECURE_CERTIFICATE_OF_INDIAN_STATUS", "OTHER_GOVERNMENT_PHOTO_ID"];

function Upload({ slot, onDone, onCancel }: { slot: SlotView; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [ind, setInd] = useState({
    verificationDate: "", verificationMode: "IN_PERSON", fullLegalName: slot.party?.fullName ?? "", dateOfBirth: "", address: "", occupation: "",
    idType: "DRIVERS_LICENCE", idNumber: "", issuingJurisdiction: "Ontario", expiryDate: "",
  });
  const [corp, setCorp] = useState({
    verificationDate: "", corporationLegalName: slot.party?.fullName ?? "", registrationNumber: "", jurisdictionOfIncorporation: "Ontario",
    registeredAddress: "", natureOfBusiness: "", verificationSource: "CERTIFICATE_OF_CORPORATE_STATUS", verificationSourceReference: "",
    directors: "", controlStructure: "", noBeneficialOwnerReason: "", seniorManagingOfficer: "",
  });
  const [owners, setOwners] = useState<{ fullName: string; address: string; ownershipPercent: string }[]>([]);
  const [third, setThird] = useState({ yes: false, name: "", address: "", relationship: "" });
  const m = (k: string) => act.fields[`metadata.${k}`];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const form = new FormData();
    if (slot.metadataKind !== "NONE") {
      const thirdParty = third.yes ? { thirdPartyDetermination: true, thirdParty: { name: third.name, address: third.address, relationship: third.relationship } } : { thirdPartyDetermination: false };
      const metadata = slot.metadataKind === "FINTRAC_INDIVIDUAL" ? { ...ind, ...thirdParty } : {
        ...corp,
        directors: corp.directors.split("\n").map((d) => d.trim()).filter(Boolean),
        beneficialOwners: owners.map((o) => ({ ...o, ownershipPercent: Number(o.ownershipPercent) })),
        noBeneficialOwnerReason: owners.length ? undefined : corp.noBeneficialOwnerReason || undefined,
        seniorManagingOfficer: owners.length ? undefined : corp.seniorManagingOfficer || undefined,
        ...thirdParty,
      };
      form.append("metadata", JSON.stringify(metadata));
    }
    form.append("file", file);
    const res = await act.run(() => api<{ warnings: string[] }>("POST", `/api/documents/slots/${slot.id}/files`, form));
    if (res) {
      if (res.warnings.length) { setWarnings(res.warnings); return; }
      onDone();
    }
  };

  if (warnings.length) {
    return (
      <div className="space-y-3">
        <Notice kind="warning" title="Uploaded, with something to check">
          {warnings.includes("LEGAL_NAME_DIFFERS_FROM_PARTY") ? "The legal name on the ID record doesn't match the client's name on the deal. The reviewer will see this." : warnings.join(", ")}
        </Notice>
        <Button variant="primary" onClick={onDone}>OK</Button>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <div className="space-y-1">
        <label htmlFor={`file-${slot.id}`} className="block text-sm font-medium text-ink">File <span className="text-critical" aria-hidden>*</span></label>
        <input id={`file-${slot.id}`} type="file" accept={ACCEPT} required onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-ink file:mr-3 file:rounded-lg file:border file:border-line file:bg-card file:px-3 file:py-2 file:text-sm file:font-medium" />
        <p className="text-xs text-ink-3">PDF, JPEG, PNG or HEIC, up to 25 MB.</p>
        {act.fields.file && <p className="text-xs font-medium text-critical">{act.fields.file}</p>}
      </div>

      {slot.metadataKind === "FINTRAC_INDIVIDUAL" && (
        <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <legend className="mb-2 text-sm font-semibold text-ink">Identification (FINTRAC)</legend>
          <TextField label="Full legal name" required value={ind.fullLegalName} onChange={(e) => setInd({ ...ind, fullLegalName: e.target.value })} error={m("fullLegalName")} />
          <TextField label="Date of birth" type="date" required value={ind.dateOfBirth} onChange={(e) => setInd({ ...ind, dateOfBirth: e.target.value })} error={m("dateOfBirth")} />
          <TextField label="Address" required value={ind.address} onChange={(e) => setInd({ ...ind, address: e.target.value })} error={m("address")} />
          <TextField label="Occupation" required value={ind.occupation} onChange={(e) => setInd({ ...ind, occupation: e.target.value })} error={m("occupation")} />
          <SelectField label="ID type" value={ind.idType} onChange={(e) => setInd({ ...ind, idType: e.target.value })} options={ID_TYPES.map((t) => ({ value: t, label: labelOf(t) }))} />
          <TextField label="ID number" required autoComplete="off" value={ind.idNumber} onChange={(e) => setInd({ ...ind, idNumber: e.target.value })} error={m("idNumber")} hint="Stored encrypted" />
          <TextField label="Issued by" required value={ind.issuingJurisdiction} onChange={(e) => setInd({ ...ind, issuingJurisdiction: e.target.value })} error={m("issuingJurisdiction")} />
          <TextField label="ID expiry" type="date" required value={ind.expiryDate} onChange={(e) => setInd({ ...ind, expiryDate: e.target.value })} error={m("expiryDate")} />
          <TextField label="Verified on" type="date" required value={ind.verificationDate} onChange={(e) => setInd({ ...ind, verificationDate: e.target.value })} error={m("verificationDate")} />
          <SelectField label="How it was verified" value={ind.verificationMode} onChange={(e) => setInd({ ...ind, verificationMode: e.target.value })}
            options={[{ value: "IN_PERSON", label: "In person, original document" }, { value: "REMOTE_AUTHENTICATED", label: "Remotely, document authenticated" }]} />
        </fieldset>
      )}

      {slot.metadataKind === "FINTRAC_CORPORATE" && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-semibold text-ink">Corporation (FINTRAC)</legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <TextField label="Legal name" required value={corp.corporationLegalName} onChange={(e) => setCorp({ ...corp, corporationLegalName: e.target.value })} error={m("corporationLegalName")} />
            <TextField label="Registration number" required value={corp.registrationNumber} onChange={(e) => setCorp({ ...corp, registrationNumber: e.target.value })} error={m("registrationNumber")} />
            <TextField label="Incorporated in" required value={corp.jurisdictionOfIncorporation} onChange={(e) => setCorp({ ...corp, jurisdictionOfIncorporation: e.target.value })} error={m("jurisdictionOfIncorporation")} />
            <TextField label="Registered address" required value={corp.registeredAddress} onChange={(e) => setCorp({ ...corp, registeredAddress: e.target.value })} error={m("registeredAddress")} />
            <TextField label="Nature of business" required value={corp.natureOfBusiness} onChange={(e) => setCorp({ ...corp, natureOfBusiness: e.target.value })} error={m("natureOfBusiness")} />
            <TextField label="Verified on" type="date" required value={corp.verificationDate} onChange={(e) => setCorp({ ...corp, verificationDate: e.target.value })} error={m("verificationDate")} />
            <SelectField label="Verified from" value={corp.verificationSource} onChange={(e) => setCorp({ ...corp, verificationSource: e.target.value })}
              options={["CERTIFICATE_OF_CORPORATE_STATUS", "GOVERNMENT_REGISTRY_RECORD", "OTHER_AUTHORITATIVE_RECORD"].map((t) => ({ value: t, label: labelOf(t) }))} />
            <TextField label="Source reference" required value={corp.verificationSourceReference} onChange={(e) => setCorp({ ...corp, verificationSourceReference: e.target.value })} error={m("verificationSourceReference")} />
          </div>
          <TextArea label="Directors" hint="One per line" required value={corp.directors} onChange={(e) => setCorp({ ...corp, directors: e.target.value })} error={m("directors")} />
          <TextArea label="Ownership and control structure" required value={corp.controlStructure} onChange={(e) => setCorp({ ...corp, controlStructure: e.target.value })} error={m("controlStructure")} />
          <div className="space-y-2">
            <p className="text-sm font-medium text-ink">Beneficial owners (25% or more)</p>
            {owners.map((o, i) => (
              <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_7rem_auto]">
                <TextField label="Name" value={o.fullName} onChange={(e) => setOwners((xs) => xs.map((x, j) => (j === i ? { ...x, fullName: e.target.value } : x)))} error={m(`beneficialOwners[${i}].fullName`)} />
                <TextField label="Address" value={o.address} onChange={(e) => setOwners((xs) => xs.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))} error={m(`beneficialOwners[${i}].address`)} />
                <TextField label="Owns %" inputMode="decimal" value={o.ownershipPercent} onChange={(e) => setOwners((xs) => xs.map((x, j) => (j === i ? { ...x, ownershipPercent: e.target.value } : x)))} error={m(`beneficialOwners[${i}].ownershipPercent`)} />
                <Button variant="ghost" onClick={() => setOwners((xs) => xs.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            {owners.length < 4 && <Button onClick={() => setOwners((xs) => [...xs, { fullName: "", address: "", ownershipPercent: "" }])}>Add a beneficial owner</Button>}
          </div>
          {owners.length === 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextArea label="Why no beneficial owner was found" required value={corp.noBeneficialOwnerReason} onChange={(e) => setCorp({ ...corp, noBeneficialOwnerReason: e.target.value })} error={m("noBeneficialOwnerReason")} />
              <TextField label="Most senior managing officer" required value={corp.seniorManagingOfficer} onChange={(e) => setCorp({ ...corp, seniorManagingOfficer: e.target.value })} error={m("seniorManagingOfficer")} />
            </div>
          )}
        </fieldset>
      )}

      {slot.metadataKind !== "NONE" && (
        <div className="space-y-3">
          <Checkbox label="Someone else is directing this client (third party)" checked={third.yes} onChange={(e) => setThird({ ...third, yes: e.target.checked })} />
          {third.yes && (
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField label="Third party's name" required value={third.name} onChange={(e) => setThird({ ...third, name: e.target.value })} error={m("thirdParty.name")} />
              <TextField label="Their address" required value={third.address} onChange={(e) => setThird({ ...third, address: e.target.value })} error={m("thirdParty.address")} />
              <TextField label="Relationship to the client" required value={third.relationship} onChange={(e) => setThird({ ...third, relationship: e.target.value })} error={m("thirdParty.relationship")} />
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" variant="primary" busy={act.busy} disabled={!file}>Upload</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
