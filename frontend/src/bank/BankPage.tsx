/**
 * Bank files and monthly trust reconciliation (O. Reg. 579/05 s.13).
 * Statements are imported from the bank's own CSV, verified by a second
 * person against the bank, matched to the ledger, then reconciled and signed
 * by the broker of record. The app never connects to a bank.
 */

import { useState } from "react";
import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { hasRole, useSession } from "../app/session.tsx";
import { Link, navigate } from "../app/router.tsx";
import { Button, Checkbox, Empty, Facts, Loading, Notice, Page, PageHeader, Section, SelectField, StatusBadge, Table, TabLinks, TextArea, TextField, type Tone } from "../ui/kit.tsx";
import { ConfirmButton, InlineForm } from "../ui/Disclosure.tsx";
import { centsText, dateText, dateTimeText, labelOf, moneyText, todayIso } from "../ui/format.ts";

interface StatementRow {
  id: string; kind: string; account: { type: string; id: string; name: string }; periodStart: string; periodEnd: string; closingBalance: string;
  fileName: string; importedAt: string; importedBy: string; verified: { at: string; by: string } | null;
}
interface StatementView {
  id: string; kind: string; account: { type: "TRUST" | "OPERATING"; id: string }; periodStart: string; periodEnd: string; openingBalance: string | null; closingBalance: string;
  receivedDate: string | null; source: string | null; fileName: string; importedBy: string;
  verification: { verifiedBy: string; method: string; verifiedAt: string; segregationException: string | null; exceptionsReviewed: string | null } | null;
  integrityExceptions: string[];
  lines: { id: string; lineNumber: number; postedDate: string; amount: string; description: string; reference: string | null;
    match: { id: string; trustEntryId: string | null; commissionReceiptId: string | null; payoutEventId: string | null; receiptReversalId: string | null; dealNumber: string | null } | null }[];
  matched: number; unmatched: number;
}
interface Outstanding { entryId: string; dealNumber: string; entryType: string; amount: number; effectiveDate: string; referenceNo: string | null; counterparty: string | null; businessDaysOutstanding: number }
interface ReconDetails {
  outstanding: Outstanding[]; unrecorded: { bankTransactionId: string; postedDate: string; amount: number; description: string }[];
  staleDeposits: Outstanding[]; lateDeposits: { entryId: string; dealNumber: string; amount: number; receivedDate: string; postedDate: string; businessDays: number }[];
  shortfalls: { dealId: string; dealNumber: string; balance: number }[]; exceptions: string[];
}
interface LiveRecon {
  periodEnd: string; statementReceived: string | null; dueBy: string; statutoryDueBy: string;
  bankClosingBalance: number; outstandingDeposits: number; outstandingDisbursements: number; unrecordedBankItems: number; adjustedBankBalance: number;
  ledgerBalance: number; clientLiabilities: number; difference: number; isBalanced: boolean; details: ReconDetails;
}
interface ReconRow { id: string; trustAccountId: string; trustAccountName: string; statementId: string; periodEnd: string; isBalanced: boolean; difference: string; status: string; preparedAt: string; preparedBy: string; signedAt: string | null; signedBy: string | null }
interface ReconView {
  id: string; trustAccountId: string; statementId: string; periodEnd: string; statementReceived: string | null; dueBy: string; statutoryDueBy: string;
  status: string; supersedes: { id: string; reason: string } | null; supersededBy: unknown; signedOnTime: boolean | null; statementVerified: boolean;
  incidents: { id: string; kind: string; open: boolean }[];
  figures: Record<"bankClosingBalance" | "outstandingDeposits" | "outstandingDisbursements" | "unrecordedBankItems" | "adjustedBankBalance" | "ledgerBalance" | "clientLiabilities" | "difference", string>;
  isBalanced: boolean; details: ReconDetails; explanation: string | null; preparedBy: string; preparedAt: string; signedBy: string | null; signedAt: string | null; signatureNote: string | null;
}

const RECON_TONE: Record<string, Tone> = { PREPARED: "warning", SIGNED: "good", SIGNED_WITH_DISCREPANCY: "serious", SUPERSEDED: "neutral" };

export function BankPage({ tab, id }: { tab: string; id?: string }) {
  return (
    <Page wide>
      <PageHeader title="Bank & reconciliation" eyebrow="Monthly trust reconciliation">
        Import the bank's file, have someone else verify it against the bank, match it to the ledger, then prepare the reconciliation for the broker of record to sign.
      </PageHeader>
      <TabLinks label="Bank sections" current={tab} tabs={[
        { key: "statements", label: "Statements", href: "/bank" },
        { key: "reconciliations", label: "Reconciliations", href: "/bank/reconciliations" },
        { key: "funds", label: "Available funds", href: "/bank/funds" },
      ]} />
      {tab === "funds" ? <AvailableFunds /> : tab === "reconciliations" ? (id ? <ReconciliationDetail id={id} /> : <Reconciliations />) : id ? <StatementDetail id={id} /> : <Statements />}
    </Page>
  );
}

// ── Statements ───────────────────────────────────────────────────────────────

function Statements() {
  const res = useApi<{ statements: StatementRow[] }>("/api/bank/statements");
  return (
    <div className="space-y-5">
      <InlineForm label="Import a bank file" variant="primary">{(close) => <ImportStatement onCancel={close} />}</InlineForm>
      <Section title="Imported files">
        {!res.data ? (res.status === "error" ? <Notice kind="error">{res.message}</Notice> : <Loading />) : res.data.statements.length === 0 ? <Empty>No bank files imported yet.</Empty> : (
          <Table head={["Period", "Account", "Closing balance", "Imported", "Verified"]}>
            {res.data.statements.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2 whitespace-nowrap"><Link className="font-medium underline" href={`/bank/statements/${s.id}`}>{dateText(s.periodStart)} – {dateText(s.periodEnd)}</Link>{s.kind === "INTERIM" && <span className="block text-xs text-ink-3">Interim</span>}</td>
                <td className="px-3 py-2">{s.account.name}<span className="block text-xs text-ink-3">{labelOf(s.account.type)}</span></td>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums">{moneyText(s.closingBalance)}</td>
                <td className="px-3 py-2">{s.importedBy}<span className="block text-xs text-ink-3">{dateTimeText(s.importedAt)}</span></td>
                <td className="px-3 py-2">{s.verified ? <StatusBadge tone="good">{s.verified.by}</StatusBadge> : <StatusBadge tone="warning">Not verified</StatusBadge>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}

function ImportStatement({ onCancel }: { onCancel: () => void }) {
  const act = useAction();
  const trust = useApi<{ accounts: { id: string; name: string; accountLast4: string; isActive: boolean }[] }>("/api/trust/accounts");
  const ops = useApi<{ accounts: { id: string; name: string; accountLast4: string; isActive: boolean }[] }>("/api/operating-accounts");
  const accounts = [
    ...(trust.data?.accounts ?? []).filter((a) => a.isActive).map((a) => ({ value: `TRUST:${a.id}`, label: `${a.name} ••${a.accountLast4} (trust)` })),
    ...(ops.data?.accounts ?? []).filter((a) => a.isActive).map((a) => ({ value: `OPERATING:${a.id}`, label: `${a.name} ••${a.accountLast4} (operating)` })),
  ];
  const [f, setF] = useState({ account: "", kind: "MONTHLY", periodStart: "", periodEnd: "", openingBalance: "", closingBalance: "", receivedDate: todayIso(), source: "BANK_PORTAL_DOWNLOAD", sourceNote: "", dateOrder: "MDY", autoMatch: true });
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const account = f.account || accounts[0]?.value || "";
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const [accountType, accountId] = account.split(":");
      const r = await act.run(() => api<StatementView & { autoMatched: number }>("POST", "/api/bank/statements", {
        kind: f.kind, accountType, accountId, periodStart: f.periodStart, periodEnd: f.periodEnd,
        ...(f.kind === "MONTHLY" ? { openingBalance: f.openingBalance } : {}), closingBalance: f.closingBalance, receivedDate: f.receivedDate,
        source: f.source, ...(f.source === "OTHER" ? { sourceNote: f.sourceNote } : {}), fileName: file?.name ?? "", csv: file?.text ?? "", dateOrder: f.dateOrder, autoMatch: f.autoMatch,
      }));
      if (r) navigate(`/bank/statements/${r.id}`);
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}{act.fields.csv && <span className="block">{act.fields.csv}</span>}</Notice></div>}
      <SelectField label="Account" value={account} options={accounts} onChange={(e) => setF({ ...f, account: e.target.value })} error={act.fields.accountId} />
      <SelectField label="File" value={f.kind} options={[{ value: "MONTHLY", label: "Monthly statement" }, { value: "INTERIM", label: "Interim (part of a month)" }]} onChange={(e) => setF({ ...f, kind: e.target.value })} />
      <TextField label="Period from" type="date" required value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} error={act.fields.periodStart} />
      <TextField label="Period to" type="date" required value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} error={act.fields.periodEnd} />
      {f.kind === "MONTHLY" && <TextField label="Opening balance" required inputMode="decimal" value={f.openingBalance} onChange={(e) => setF({ ...f, openingBalance: e.target.value })} error={act.fields.openingBalance} />}
      <TextField label="Closing balance" required inputMode="decimal" value={f.closingBalance} onChange={(e) => setF({ ...f, closingBalance: e.target.value })} error={act.fields.closingBalance} />
      <TextField label="Received from the bank" type="date" required value={f.receivedDate} onChange={(e) => setF({ ...f, receivedDate: e.target.value })} error={act.fields.receivedDate} />
      <SelectField label="Where it came from" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}
        options={["BANK_PORTAL_DOWNLOAD", "BANK_EMAIL", "BANK_PAPER_STATEMENT", "OTHER"].map((k) => ({ value: k, label: labelOf(k) }))} />
      {f.source === "OTHER" && <TextField label="Describe the source" required value={f.sourceNote} onChange={(e) => setF({ ...f, sourceNote: e.target.value })} error={act.fields.sourceNote} />}
      <SelectField label="Date format in the file" value={f.dateOrder} onChange={(e) => setF({ ...f, dateOrder: e.target.value })}
        options={[{ value: "MDY", label: "Month/day/year" }, { value: "DMY", label: "Day/month/year" }, { value: "YMD", label: "Year-month-day" }]} />
      <label className="block text-sm sm:col-span-2">
        <span className="font-medium text-ink">CSV file from the bank</span>
        <input type="file" accept=".csv,text/csv" required className="mt-1 block w-full text-sm" onChange={async (e) => {
          const fl = e.target.files?.[0];
          setFile(fl ? { name: fl.name, text: await fl.text() } : null);
        }} />
        {act.fields.fileName && <span className="mt-1 block text-critical">{act.fields.fileName}</span>}
      </label>
      <Checkbox label="Match lines to the ledger automatically" checked={f.autoMatch} onChange={(e) => setF({ ...f, autoMatch: e.target.checked })} />
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Import</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function StatementDetail({ id }: { id: string }) {
  const { user } = useSession();
  const broker = hasRole(user, ["MANAGING_BROKER"]);
  const res = useApi<StatementView>(`/api/bank/statements/${id}`);
  const s = res.data;
  const monthlyTrust = s?.kind === "MONTHLY" && s.account.type === "TRUST";
  const live = useApi<LiveRecon>(monthlyTrust ? `/api/bank/statements/${id}/reconciliation` : null);
  const act = useAction();
  if (res.status === "error" && !s) return <Notice kind="error">{res.message}</Notice>;
  if (!s) return <Loading />;
  const reload = () => { res.reload(); live.reload(); };
  const candidates = live.data?.details.outstanding ?? [];

  return (
    <div className="space-y-5">
      <Link href="/bank" className="text-sm underline">All statements</Link>
      <Section title={`${dateText(s.periodStart)} – ${dateText(s.periodEnd)}`} description={`${s.fileName} · imported by ${s.importedBy}`}
        actions={s.verification ? <StatusBadge tone="good">Verified by {s.verification.verifiedBy}</StatusBadge> : <StatusBadge tone="warning">Not verified</StatusBadge>}>
        <Facts items={[
          ["Kind", labelOf(s.kind)], ["Account", labelOf(s.account.type)],
          ...(s.openingBalance !== null ? [["Opening balance", moneyText(s.openingBalance)] as [string, string]] : []),
          ["Closing balance", moneyText(s.closingBalance)], ["Received", dateText(s.receivedDate)], ["Source", s.source ? labelOf(s.source) : "—"],
          ["Lines matched", `${s.matched} of ${s.matched + s.unmatched}`],
          ...(s.verification ? [["How it was verified", `${s.verification.method} (${dateTimeText(s.verification.verifiedAt)})`] as [string, string]] : []),
        ]} />
        {s.integrityExceptions.length > 0 && <div className="mt-3"><Notice kind="error" title="This file doesn't agree with another file for the same dates"><ul className="list-disc pl-5">{s.integrityExceptions.map((x) => <li key={x}>{x}</li>)}</ul></Notice></div>}
        {!s.verification && <div className="mt-3"><InlineForm label="Verify against the bank" variant="primary">{(close) => <Verify id={s.id} needsReview={s.integrityExceptions.length > 0} onDone={() => { close(); reload(); }} onCancel={close} />}</InlineForm></div>}
      </Section>

      {monthlyTrust && live.data && (
        <Section title="Reconciliation (live)" description={`Due ${dateText(live.data.dueBy)} · statutory deadline ${dateText(live.data.statutoryDueBy)}`}
          actions={<StatusBadge tone={live.data.isBalanced ? "good" : "critical"}>{live.data.isBalanced ? "Balances" : `Off by ${centsText(live.data.difference)}`}</StatusBadge>}>
          <ReconFigures f={{
            bankClosingBalance: centsText(live.data.bankClosingBalance), outstandingDeposits: centsText(live.data.outstandingDeposits), outstandingDisbursements: centsText(live.data.outstandingDisbursements),
            unrecordedBankItems: centsText(live.data.unrecordedBankItems), adjustedBankBalance: centsText(live.data.adjustedBankBalance), ledgerBalance: centsText(live.data.ledgerBalance),
            clientLiabilities: centsText(live.data.clientLiabilities), difference: centsText(live.data.difference),
          }} />
          <ReconExceptions d={live.data.details} />
          <div className="mt-4"><InlineForm label="Prepare the reconciliation" variant="primary">{(close) => <Prepare statementId={s.id} needsExplanation={!live.data!.isBalanced || live.data!.details.exceptions.length > 0} onCancel={close} />}</InlineForm></div>
        </Section>
      )}

      <Section title="Lines">
        {act.error && <div className="mb-3"><Notice kind="error">{act.error}</Notice></div>}
        <Table head={["#", "Date", "Description", "Amount", "Matched to"]}>
          {s.lines.map((l) => (
            <tr key={l.id} className="align-top">
              <td className="px-3 py-2 text-ink-3">{l.lineNumber}</td>
              <td className="px-3 py-2 whitespace-nowrap">{dateText(l.postedDate)}</td>
              <td className="px-3 py-2">{l.description}{l.reference && <span className="block text-xs text-ink-3">{l.reference}</span>}</td>
              <td className={`px-3 py-2 whitespace-nowrap tabular-nums ${l.amount.startsWith("-") ? "text-critical" : ""}`}>{moneyText(l.amount)}</td>
              <td className="px-3 py-2">
                {l.match ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone="good">{l.match.dealNumber ? `Deal ${l.match.dealNumber}` : l.match.commissionReceiptId ? "Commission receipt" : l.match.payoutEventId ? "Payout" : "Matched"}</StatusBadge>
                    {broker || hasRole(user, ["ADMIN"]) ? <ConfirmButton label="Unmatch" variant="secondary" question="Remove this match?" busy={act.busy}
                      onConfirm={() => void act.run(() => api("DELETE", `/api/bank/matches/${l.match!.id}`)).then((r) => r && reload())} /> : null}
                  </span>
                ) : <InlineForm label="Match">{(close) => <Match lineId={l.id} candidates={candidates} onDone={() => { close(); reload(); }} onCancel={close} />}</InlineForm>}
              </td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}

function Verify({ id, needsReview, onDone, onCancel }: { id: string; needsReview: boolean; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ method: "", exceptionReason: "", exceptionsReviewed: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      if (await act.run(() => api("POST", `/api/bank/statements/${id}/verify`, { method: f.method, exceptionReason: f.exceptionReason.trim() || undefined, exceptionsReviewed: f.exceptionsReviewed.trim() || undefined }))) onDone();
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <p className="text-sm text-ink-2">Someone other than the person who imported it checks the file against the bank itself.</p>
      <TextField label="How you checked it" required hint="e.g. compared the balance and every line with the TD portal, Oct 3" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} error={act.fields.method} />
      {needsReview && <TextArea label="What you found about the mismatch" required rows={2} value={f.exceptionsReviewed} onChange={(e) => setF({ ...f, exceptionsReviewed: e.target.value })} error={act.fields.exceptionsReviewed} />}
      <TextField label="Sole-operator exception" hint="Only if you imported it yourself and the policy allows it" value={f.exceptionReason} onChange={(e) => setF({ ...f, exceptionReason: e.target.value })} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Verified</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Match({ lineId, candidates, onDone, onCancel }: { lineId: string; candidates: Outstanding[]; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ kind: candidates.length ? "trustEntryId" : "commissionReceiptId", targetId: candidates[0]?.entryId ?? "", note: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      if (await act.run(() => api("POST", "/api/bank/matches", { bankTransactionId: lineId, [f.kind]: f.targetId, note: f.note.trim() || undefined }))) onDone();
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <SelectField label="Match to" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, targetId: e.target.value === "trustEntryId" ? candidates[0]?.entryId ?? "" : "" })}
        options={[{ value: "trustEntryId", label: "A trust ledger entry" }, { value: "commissionReceiptId", label: "A commission receipt" }, { value: "payoutEventId", label: "A recorded payout" }, { value: "receiptReversalId", label: "A reversed commission receipt" }]} />
      {f.kind === "trustEntryId" && candidates.length > 0
        ? <SelectField label="Entry" value={f.targetId} onChange={(e) => setF({ ...f, targetId: e.target.value })}
            options={candidates.map((c) => ({ value: c.entryId, label: `Deal ${c.dealNumber}: ${labelOf(c.entryType)} ${centsText(c.amount)}, ${dateText(c.effectiveDate)}${c.counterparty ? ` (${c.counterparty})` : ""}` }))} />
        : <TextField label="Record ID" required hint="Shown on the deal's closing tab" value={f.targetId} onChange={(e) => setF({ ...f, targetId: e.target.value })} error={act.fields[f.kind]} />}
      <TextField label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Match</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Prepare({ statementId, needsExplanation, supersedesId, onCancel }: { statementId: string; needsExplanation: boolean; supersedesId?: string; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ explanation: "", amendmentReason: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const r = await act.run(() => api<ReconView>("POST", "/api/trust/reconciliations", {
        statementId, explanation: f.explanation.trim() || undefined, ...(supersedesId ? { supersedesId, amendmentReason: f.amendmentReason } : {}),
      }));
      if (r) navigate(`/bank/reconciliations/${r.id}`);
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {supersedesId && <TextArea label="Why the signed one is being corrected" required rows={2} value={f.amendmentReason} onChange={(e) => setF({ ...f, amendmentReason: e.target.value })} error={act.fields.amendmentReason} />}
      <TextArea label="Explanation" required={needsExplanation} rows={3} hint={needsExplanation ? "Explain the difference and each exception. Shortfalls open an incident for the broker of record." : "Optional"}
        value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} error={act.fields.explanation} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Prepare</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

// ── Reconciliations ─────────────────────────────────────────────────────────

function Reconciliations() {
  const res = useApi<{ reconciliations: ReconRow[] }>("/api/trust/reconciliations");
  return (
    <Section title="Monthly reconciliations" description="Prepare one from a verified monthly trust statement.">
      {!res.data ? (res.status === "error" ? <Notice kind="error">{res.message}</Notice> : <Loading />) : res.data.reconciliations.length === 0 ? <Empty>None prepared yet.</Empty> : (
        <Table head={["Month ending", "Account", "Difference", "Status", "Prepared", "Signed"]}>
          {res.data.reconciliations.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-2 whitespace-nowrap"><Link className="font-medium underline" href={`/bank/reconciliations/${r.id}`}>{dateText(r.periodEnd)}</Link></td>
              <td className="px-3 py-2">{r.trustAccountName}</td>
              <td className="px-3 py-2 whitespace-nowrap tabular-nums">{moneyText(r.difference)}</td>
              <td className="px-3 py-2"><StatusBadge tone={RECON_TONE[r.status] ?? "neutral"}>{labelOf(r.status)}</StatusBadge></td>
              <td className="px-3 py-2">{r.preparedBy}<span className="block text-xs text-ink-3">{dateTimeText(r.preparedAt)}</span></td>
              <td className="px-3 py-2">{r.signedBy ?? "—"}{r.signedAt && <span className="block text-xs text-ink-3">{dateTimeText(r.signedAt)}</span>}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function ReconciliationDetail({ id }: { id: string }) {
  const { user } = useSession();
  const broker = hasRole(user, ["MANAGING_BROKER"]);
  const res = useApi<ReconView>(`/api/trust/reconciliations/${id}`);
  const [view, setView] = useState<ReconView | null>(null);
  const r = view ?? res.data;
  if (res.status === "error" && !r) return <Notice kind="error">{res.message}</Notice>;
  if (!r) return <Loading />;
  return (
    <div className="space-y-5">
      <Link href="/bank/reconciliations" className="text-sm underline">All reconciliations</Link>
      <Section title={`Month ending ${dateText(r.periodEnd)}`} description={`Prepared by ${r.preparedBy}, ${dateTimeText(r.preparedAt)} · due ${dateText(r.dueBy)}`}
        actions={<StatusBadge tone={RECON_TONE[r.status] ?? "neutral"}>{labelOf(r.status)}</StatusBadge>}>
        {!r.statementVerified && <div className="mb-3"><Notice kind="warning">The statement hasn't been verified against the bank yet.</Notice></div>}
        {r.supersedes && <div className="mb-3"><Notice kind="info">Corrects an earlier signed reconciliation: {r.supersedes.reason}</Notice></div>}
        <ReconFigures f={Object.fromEntries(Object.entries(r.figures).map(([k, v]) => [k, moneyText(v)])) as Record<keyof ReconView["figures"], string>} />
        <ReconExceptions d={r.details} />
        {r.explanation && <p className="mt-3 text-sm"><span className="font-medium">Explanation:</span> {r.explanation}</p>}
        {r.incidents.length > 0 && <ul className="mt-3 text-sm">{r.incidents.map((i) => <li key={i.id}><Link className="underline" href={`/trust/incidents/${i.id}`}>{labelOf(i.kind)}</Link>{i.open ? " (open)" : ""}</li>)}</ul>}
        {r.signedAt && <p className="mt-3 text-sm">Signed by {r.signedBy}, {dateTimeText(r.signedAt)}{r.signedOnTime === false ? " (late)" : ""}{r.signatureNote ? `: ${r.signatureNote}` : ""}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          {broker && r.status === "PREPARED" && <InlineForm label="Sign as broker of record" variant="primary">{(close) => <Sign id={r.id} balanced={r.isBalanced} onDone={(v) => { close(); setView(v); }} onCancel={close} />}</InlineForm>}
          {(r.status === "SIGNED" || r.status === "SIGNED_WITH_DISCREPANCY") && hasRole(user, ["ADMIN", "MANAGING_BROKER"]) &&
            <InlineForm label="Correct it">{(close) => <Prepare statementId={r.statementId} supersedesId={r.id} needsExplanation={false} onCancel={close} />}</InlineForm>}
        </div>
      </Section>
    </div>
  );
}

function Sign({ id, balanced, onDone, onCancel }: { id: string; balanced: boolean; onDone: (v: ReconView) => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ note: "", exceptionReason: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const v = await act.run(() => api<ReconView>("POST", `/api/trust/reconciliations/${id}/sign`, { note: f.note.trim() || undefined, exceptionReason: f.exceptionReason.trim() || undefined }));
      if (v) onDone(v);
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {!balanced && <Notice kind="warning">It doesn't balance. Signing records it as signed with a discrepancy; the incident stays open until it's resolved.</Notice>}
      <TextField label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      <TextField label="Sole-operator exception" hint="Only if you prepared it yourself and the policy allows it" value={f.exceptionReason} onChange={(e) => setF({ ...f, exceptionReason: e.target.value })} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Sign</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function ReconFigures({ f }: { f: Record<"bankClosingBalance" | "outstandingDeposits" | "outstandingDisbursements" | "unrecordedBankItems" | "adjustedBankBalance" | "ledgerBalance" | "clientLiabilities" | "difference", string> }) {
  return (
    <Facts items={[
      ["Bank closing balance", f.bankClosingBalance], ["+ Deposits not yet at the bank", f.outstandingDeposits], ["− Payments not yet cleared", f.outstandingDisbursements],
      ["Bank items not in the ledger", f.unrecordedBankItems], ["Adjusted bank balance", f.adjustedBankBalance], ["Trust ledger", f.ledgerBalance],
      ["Owed to clients (by deal)", f.clientLiabilities], ["Difference", f.difference],
    ]} />
  );
}

function ReconExceptions({ d }: { d: ReconDetails }) {
  if (d.exceptions.length === 0 && d.shortfalls.length === 0) return null;
  return (
    <div className="mt-3 space-y-3">
      {d.shortfalls.length > 0 && <Notice kind="error" title="Shortfall"><ul className="list-disc pl-5">{d.shortfalls.map((s) => <li key={s.dealId}>Deal {s.dealNumber}: {centsText(s.balance)}</li>)}</ul></Notice>}
      {d.exceptions.length > 0 && <Notice kind="warning" title="Exceptions"><ul className="list-disc pl-5">{d.exceptions.map((x) => <li key={x}>{x}</li>)}</ul></Notice>}
    </div>
  );
}

// ── Available funds (operating accounts) ─────────────────────────────────────

interface Availability {
  asOf: string | null; bankBalance: string | null; unpresentedPayments: string; approvedNotSent: string; returnedStillOwed: string;
  obligations: { amount: string; asOf: string; source: string; reference: string } | null; available: string | null; blockedBecause: string[]; definition: string;
}
interface Obligations {
  id: string; asOf: string; amount: string; source: string; sourceReference: string; preparedBy: string;
  lines: { description: string; amount: string; sourceDocument: string }[]; attestation: { by: string; note: string; at: string } | null;
}

/**
 * What an operating account can pay out right now, as the database works it out
 * before approving a payout. Other bills come from an obligations figure that a
 * second person attests (entered by hand only under the accountant's procedure).
 */
function AvailableFunds() {
  const accounts = useApi<{ accounts: { id: string; name: string; bankName: string; accountLast4: string; isActive: boolean }[] }>("/api/operating-accounts");
  const [picked, setPicked] = useState("");
  const active = (accounts.data?.accounts ?? []).filter((a) => a.isActive);
  const accountId = picked || active[0]?.id || "";
  if (accounts.status === "error" && !accounts.data) return <Notice kind="error">{accounts.message}</Notice>;
  if (!accounts.data) return <Loading />;
  if (active.length === 0) return <Empty>No operating account yet. Add one under Admin → Broker of record &amp; accounts.</Empty>;
  return (
    <div className="space-y-5">
      {active.length > 1 && (
        <div className="max-w-sm"><SelectField label="Account" value={accountId} onChange={(e) => setPicked(e.target.value)}
          options={active.map((a) => ({ value: a.id, label: `${a.name} (${a.bankName} ••${a.accountLast4})` }))} /></div>
      )}
      <FundsFor key={accountId} accountId={accountId} />
    </div>
  );
}

function FundsFor({ accountId }: { accountId: string }) {
  const { user } = useSession();
  const bank = hasRole(user, ["ADMIN", "MANAGING_BROKER"]);
  const funds = useApi<Availability>(`/api/funds/availability?accountType=OPERATING&accountId=${accountId}`);
  const list = useApi<{ obligations: Obligations[] }>(`/api/funds/obligations?operatingAccountId=${accountId}`);
  const reload = () => { funds.reload(); list.reload(); };
  const f = funds.data;
  return (
    <>
      <Section title="Available to pay out" description={f?.definition}
        actions={f && <StatusBadge tone={f.blockedBecause.length ? "warning" : "good"}>{f.blockedBecause.length ? "Payouts blocked" : "Payouts can be approved"}</StatusBadge>}>
        {!f ? (funds.status === "error" ? <Notice kind="error">{funds.message}</Notice> : <Loading />) : (
          <>
            <Facts items={[
              ["Verified bank balance", f.bankBalance ? `${moneyText(f.bankBalance)} (${dateText(f.asOf)})` : "No verified bank file yet"],
              ["− Payments sent, not yet through the bank", moneyText(f.unpresentedPayments)],
              ["− Approved, not sent", moneyText(f.approvedNotSent)],
              ["− Returned payments still owed", moneyText(f.returnedStillOwed)],
              ["− Other obligations", f.obligations ? `${moneyText(f.obligations.amount)} (attested, ${dateText(f.obligations.asOf)})` : "No attested figure"],
              ["Available", f.available ? moneyText(f.available) : "—"],
            ]} />
            {f.blockedBecause.length > 0 && <div className="mt-3"><Notice kind="warning" title="Why payouts are blocked"><ul className="list-disc pl-5">{f.blockedBecause.map((b) => <li key={b}>{b}</li>)}</ul></Notice></div>}
          </>
        )}
      </Section>
      <Section title="Other obligations" description="Unpaid bills from the books (payroll, HST, rent). Entered by one person, attested by another; a figure is good for 7 days."
        actions={bank && <InlineForm label="Enter obligations">{(close) => <NewObligations accountId={accountId} onDone={() => { close(); reload(); }} onCancel={close} />}</InlineForm>}>
        {!list.data ? (list.status === "error" ? <Notice kind="error">{list.message}</Notice> : <Loading />) : list.data.obligations.length === 0 ? <Empty>None entered yet.</Empty> : (
          <ul className="divide-y divide-line text-sm">
            {list.data.obligations.map((o) => (
              <li key={o.id} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span>
                    <span className="font-medium">{moneyText(o.amount)}</span> as of {dateText(o.asOf)} · {labelOf(o.source)}
                    <span className="block text-xs text-ink-2">{o.sourceReference} · entered by {o.preparedBy}</span>
                    {o.lines.length === 0 ? <span className="block text-xs text-ink-3">No unpaid obligations listed</span>
                      : <ul className="mt-1 text-xs text-ink-2">{o.lines.map((l, i) => <li key={i}>{l.description}: {moneyText(l.amount)} ({l.sourceDocument})</li>)}</ul>}
                  </span>
                  {o.attestation ? <StatusBadge tone="good">Attested by {o.attestation.by}</StatusBadge> : <StatusBadge tone="warning">Not attested</StatusBadge>}
                </div>
                {!o.attestation && bank && <div className="mt-2"><InlineForm label="Attest">{(close) => <Attest id={o.id} onDone={() => { close(); reload(); }} onCancel={close} />}</InlineForm></div>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function NewObligations({ accountId, onDone, onCancel }: { accountId: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ asOf: todayIso(), procedureReference: "" });
  const [lines, setLines] = useState<{ description: string; amount: string; sourceDocument: string }[]>([]);
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      if (await act.run(() => api("POST", "/api/funds/obligations", { operatingAccountId: accountId, ...f, lines }))) onDone();
    }}>
      <p className="text-sm text-ink-2 sm:col-span-2">Needs the broker of record's MANUAL_OBLIGATIONS_PROCEDURE decision (the accountant's written procedure). List every unpaid obligation with its source document; leave the list empty if there are none.</p>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <TextField label="As of" type="date" required value={f.asOf} onChange={(e) => setF({ ...f, asOf: e.target.value })} error={act.fields.asOf} />
      <TextField label="Procedure reference" required hint="The accountant's procedure, with date" value={f.procedureReference} onChange={(e) => setF({ ...f, procedureReference: e.target.value })} error={act.fields.procedureReference} />
      {lines.map((l, i) => (
        <fieldset key={i} className="grid gap-2 rounded-lg border border-line p-3 sm:col-span-2 sm:grid-cols-[1fr_8rem_1fr_auto] sm:items-end">
          <legend className="sr-only">Obligation {i + 1}</legend>
          <TextField label="Description" value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} error={act.fields[`lines[${i}].description`]} />
          <TextField label="Amount" inputMode="decimal" value={l.amount} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} error={act.fields[`lines[${i}].amount`]} />
          <TextField label="Source document" value={l.sourceDocument} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, sourceDocument: e.target.value } : x)))} error={act.fields[`lines[${i}].sourceDocument`]} />
          <Button variant="ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</Button>
        </fieldset>
      ))}
      <div className="sm:col-span-2"><Button onClick={() => setLines([...lines, { description: "", amount: "", sourceDocument: "" }])}>Add an obligation</Button></div>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Save</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Attest({ id, onDone, onCancel }: { id: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [note, setNote] = useState("");
  return (
    <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api("POST", `/api/funds/obligations/${id}/attest`, { note }))) onDone(); }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <TextField label="What you checked" required hint="e.g. compared with payroll and the payables list" value={note} onChange={(e) => setNote(e.target.value)} error={act.fields.note} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Attest</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
