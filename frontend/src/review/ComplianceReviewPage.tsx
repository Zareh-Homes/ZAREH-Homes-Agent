/**
 * Compliance review: documents waiting for a reviewer, FINTRAC reports being
 * prepared, and the brokerage's FINTRAC compliance program record. Nothing here
 * files anything with FINTRAC; a report is filed in FINTRAC's own system and its
 * acknowledgement number recorded here.
 */

import { useState } from "react";
import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { Link } from "../app/router.tsx";
import { Button, Empty, Loading, Notice, Page, PageHeader, Section, SelectField, StatusBadge, TabLinks, Table, TextArea, TextField, type Tone } from "../ui/kit.tsx";
import { InlineForm } from "../ui/Disclosure.tsx";
import { dateText, dateTimeText, labelOf, todayIso } from "../ui/format.ts";

export function ComplianceReviewPage({ tab }: { tab: string }) {
  const current = ["documents", "fintrac", "program"].includes(tab) ? tab : "documents";
  return (
    <Page>
      <PageHeader title="Compliance review" />
      <TabLinks label="Compliance sections" current={current} tabs={[
        { key: "documents", label: "Documents to review", href: "/compliance" },
        { key: "fintrac", label: "FINTRAC reports", href: "/compliance/fintrac" },
        { key: "program", label: "FINTRAC program", href: "/compliance/program" },
      ]} />
      {current === "documents" && <ReviewQueue />}
      {current === "fintrac" && <FintracReports />}
      {current === "program" && <FintracProgram />}
    </Page>
  );
}

// ── Documents ────────────────────────────────────────────────────────────────

interface ReviewItem {
  slotId: string; document: string; fintrac: boolean; party: string | null; dealId: string; dealNumber: string; address: string;
  closeDate: string | null; uploadedAt: string | null; uploadedBy: string | null; fileId: string | null;
}

function ReviewQueue() {
  const res = useApi<{ items: ReviewItem[] }>("/api/work/reviews");
  if (res.status === "error" && !res.data) return <Notice kind="error">{res.message}</Notice>;
  if (!res.data) return <Loading label="Loading the review queue" />;
  const items = res.data.items;
  return (
    <Section title={`Waiting for review (${items.length})`} description="Oldest upload first. Open the file and check it before deciding; approved records are locked.">
      {items.length === 0 ? <Empty>Nothing waiting for review.</Empty> : (
        <ul className="divide-y divide-line">
          {items.map((i) => (
            <li key={i.slotId} className="py-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{i.document}</span>{i.party ? ` · ${i.party}` : ""}
                  {i.fintrac && <> <StatusBadge tone="warning">FINTRAC</StatusBadge></>}
                  <span className="block text-ink-2"><Link href={`/deals/${i.dealId}/documents`} className="underline">Deal {i.dealNumber}</Link> · {i.address} · closes {dateText(i.closeDate)}</span>
                  <span className="block text-xs text-ink-3">Uploaded {dateTimeText(i.uploadedAt)}{i.uploadedBy ? ` by ${i.uploadedBy}` : ""}</span>
                </span>
                {i.fileId && <a href={`/api/documents/files/${i.fileId}/content`} target="_blank" rel="noopener noreferrer" className="text-sm underline">View file</a>}
              </div>
              {i.fileId && (
                <div className="mt-2">
                  <InlineForm label="Review">{(close) => <ReviewForm slotId={i.slotId} fileId={i.fileId!} onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function ReviewForm({ slotId, fileId, onDone, onCancel }: { slotId: string; fileId: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [comment, setComment] = useState("");
  const decide = async (decision: "APPROVED" | "NEEDS_REVISION") => {
    const ok = await act.run(() => api("POST", `/api/documents/slots/${slotId}/review`, { decision, fileId, ...(comment.trim() ? { comment } : {}) }));
    if (ok) onDone();
  };
  return (
    <div className="space-y-3">
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

// ── FINTRAC reports ──────────────────────────────────────────────────────────

interface Report {
  id: string; kind: string; dealNumber: string | null; summary: string; triggeredAt: string; dueAt: string;
  status: "OPEN" | "FILED" | "NOT_REQUIRED"; reference: string | null; overdue: boolean;
}

const REPORT_TONE: Record<Report["status"], Tone> = { OPEN: "warning", FILED: "good", NOT_REQUIRED: "neutral" };

function FintracReports() {
  const [openOnly, setOpenOnly] = useState(true);
  const res = useApi<{ reports: Report[] }>(`/api/fintrac/reports${openOnly ? "?open=true" : ""}`);
  return (
    <div className="space-y-5">
      <Notice kind="info" title="Nothing is filed with FINTRAC from here">
        File each report in FINTRAC's own reporting system, then record its acknowledgement number here. Large cash and virtual currency reports open automatically from trust deposits.
      </Notice>
      <Section title="Reports"
        actions={<div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setOpenOnly(!openOnly)}>{openOnly ? "Show all" : "Open only"}</Button>
          <InlineForm label="Open a report">{(close) => <NewReport onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm>
        </div>}>
        {res.status === "error" && !res.data ? <Notice kind="error">{res.message}</Notice> : !res.data ? <Loading /> : res.data.reports.length === 0 ? <Empty>No {openOnly ? "open " : ""}reports.</Empty> : (
          <ul className="divide-y divide-line">
            {res.data.reports.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{labelOf(r.kind)}</span>{r.dealNumber ? ` · deal ${r.dealNumber}` : ""}
                    <span className="block text-ink-2">{r.summary}</span>
                    <span className="block text-xs text-ink-3">Triggered {dateTimeText(r.triggeredAt)} · due {dateTimeText(r.dueAt)}{r.reference ? ` · FINTRAC ref ${r.reference}` : ""}</span>
                  </span>
                  <span className="flex flex-wrap gap-1">
                    {r.overdue && r.status === "OPEN" && <StatusBadge tone="critical">Overdue</StatusBadge>}
                    <StatusBadge tone={REPORT_TONE[r.status]}>{labelOf(r.status)}</StatusBadge>
                  </span>
                </div>
                {r.status === "OPEN" && <div className="mt-2"><InlineForm label="Record outcome">{(close) => <ReportOutcome id={r.id} onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm></div>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function NewReport({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const deals = useApi<{ deals: { id: string; dealNumber: string; streetAddress: string; city: string }[] }>("/api/deals");
  const [f, setF] = useState({ kind: "SUSPICIOUS_TRANSACTION", dealId: "", summary: "" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      if (await act.run(() => api("POST", "/api/fintrac/reports", { kind: f.kind, summary: f.summary, ...(f.dealId ? { dealId: f.dealId } : {}) }))) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}
        options={[{ value: "SUSPICIOUS_TRANSACTION", label: "Suspicious transaction" }, { value: "LISTED_PERSON_PROPERTY", label: "Listed person or entity property" }]} />
      <SelectField label="Deal" placeholder="No deal" value={f.dealId} onChange={(e) => setF({ ...f, dealId: e.target.value })} error={act.fields.dealId}
        options={(deals.data?.deals ?? []).map((d) => ({ value: d.id, label: `${d.dealNumber} · ${d.streetAddress}, ${d.city}` }))} />
      <div className="sm:col-span-2"><TextArea label="Summary" required rows={3} hint="Due immediately" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} error={act.fields.summary} /></div>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Open report</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function ReportOutcome({ id, onDone, onCancel }: { id: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ status: "FILED", reference: "", note: "" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const body = { status: f.status, note: f.note, ...(f.status === "FILED" ? { reference: f.reference } : f.reference.trim() ? { reference: f.reference } : {}) };
      if (await act.run(() => api("POST", `/api/fintrac/reports/${id}/events`, body))) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Outcome" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}
        options={[{ value: "FILED", label: "Filed with FINTRAC" }, { value: "NOT_REQUIRED", label: "Not required" }]} />
      <TextField label="FINTRAC acknowledgement number" required={f.status === "FILED"} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} />
      <div className="sm:col-span-2"><TextArea label="Note" required rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} error={act.fields.note} /></div>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Save</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

// ── FINTRAC compliance program ───────────────────────────────────────────────

interface Finding { rule: string; citation: string; severity: "BLOCKING" | "BREACH" | "WARNING"; message: string }
interface Program {
  asOf: string; findings: Finding[]; summary: { blocking: number; breaches: number; warnings: number };
  records: { kind: string; effectiveDate: string; title: string; subject: string | null }[];
}

const SEVERITY_TONE: Record<Finding["severity"], Tone> = { BLOCKING: "critical", BREACH: "serious", WARNING: "warning" };
const PROGRAM_KINDS = ["COMPLIANCE_OFFICER", "POLICIES_APPROVED", "RISK_ASSESSMENT", "TRAINING", "EFFECTIVENESS_REVIEW"];

function FintracProgram() {
  const res = useApi<Program>("/api/fintrac/program");
  const [view, setView] = useState<Program | null>(null);
  const p = view ?? res.data;
  if (res.status === "error" && !p) return <Notice kind="error">{res.message}</Notice>;
  if (!p) return <Loading label="Loading the compliance program" />;
  return (
    <div className="space-y-5">
      <Section title="Program status" description={`As of ${dateTimeText(p.asOf)}: ${p.summary.blocking} blocking, ${p.summary.breaches} breaches, ${p.summary.warnings} warnings`}>
        {p.findings.length === 0 ? <Empty>Every program element is on record and current.</Empty> : (
          <ul className="divide-y divide-line text-sm">
            {p.findings.map((f, i) => (
              <li key={`${f.rule}-${i}`} className="py-2">
                <StatusBadge tone={SEVERITY_TONE[f.severity]}>{labelOf(f.severity)}</StatusBadge> <span className="text-ink">{f.message}</span>
                <span className="block text-xs text-ink-3">{f.citation}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Records" actions={<InlineForm label="Add a record" variant="primary">{(close) => <NewProgramRecord onDone={(v) => { close(); setView(v); }} onCancel={close} />}</InlineForm>}>
        {p.records.length === 0 ? <Empty>No program records yet.</Empty> : (
          <Table head={["Effective", "Kind", "Title", "Person"]}>
            {p.records.map((r, i) => (
              <tr key={i}>
                <td className="px-3 py-2 whitespace-nowrap">{dateText(r.effectiveDate)}</td>
                <td className="px-3 py-2">{labelOf(r.kind)}</td>
                <td className="px-3 py-2">{r.title}</td>
                <td className="px-3 py-2">{r.subject ?? "—"}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

function NewProgramRecord({ onDone, onCancel }: { onDone: (p: Program) => void; onCancel: () => void }) {
  const act = useAction();
  const users = useApi<{ users: { id: string; firstName: string; lastName: string }[] }>("/api/users");
  const [f, setF] = useState({ kind: "COMPLIANCE_OFFICER", effectiveDate: todayIso(), subjectUserId: "", title: "", details: "" });
  const needsSubject = f.kind === "COMPLIANCE_OFFICER" || f.kind === "TRAINING";
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const v = await act.run(() => api<Program>("POST", "/api/fintrac/program", {
        kind: f.kind, effectiveDate: f.effectiveDate, title: f.title, details: f.details, ...(needsSubject && f.subjectUserId ? { subjectUserId: f.subjectUserId } : {}),
      }));
      if (v) onDone(v);
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Kind" value={f.kind} options={PROGRAM_KINDS.map((k) => ({ value: k, label: labelOf(k) }))} onChange={(e) => setF({ ...f, kind: e.target.value })} />
      <TextField label="Effective" type="date" required value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} error={act.fields.effectiveDate} />
      {needsSubject && (
        <SelectField label="Person" required placeholder="Choose" value={f.subjectUserId} onChange={(e) => setF({ ...f, subjectUserId: e.target.value })} error={act.fields.subjectUserId}
          options={(users.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.firstName} ${u.lastName}` }))} />
      )}
      <TextField label="Title" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} error={act.fields.title} />
      <div className="sm:col-span-2"><TextArea label="Details" required rows={3} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} error={act.fields.details} /></div>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Add record</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
