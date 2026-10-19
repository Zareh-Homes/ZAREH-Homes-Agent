/**
 * Trust, brokerage-wide: each account's reconciliation status, shortfall and
 * discrepancy incidents (O. Reg. 579/05 ss.13–14), and unclaimed money.
 * Everything here records what was done; nothing notifies RECO or moves funds.
 */

import { useState } from "react";
import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { hasRole, useSession } from "../app/session.tsx";
import { Link } from "../app/router.tsx";
import { Button, Empty, Facts, Loading, Notice, Page, PageHeader, Section, SelectField, StatusBadge, Table, TabLinks, TextArea, TextField } from "../ui/kit.tsx";
import { InlineForm } from "../ui/Disclosure.tsx";
import { dateText, dateTimeText, labelOf, moneyText, todayIso } from "../ui/format.ts";

interface AccountStatus {
  trustAccountId: string; name: string; kind: string; lastStatementEnd: string | null; lastSignedPeriodEnd: string | null;
  awaitingSignature: { periodEnd: string; received: string | null; dueBy: string; overdue: boolean }[];
  missingStatements: { month: string; dueBy: string; overdue: boolean }[];
  openIncidents: { id: string; kind: string; amount: string; detectedAt: string }[];
}
interface Incident {
  id: string; trustAccountId: string; kind: "SHORTFALL" | "DISCREPANCY"; summary: string; amount: string; detectedAt: string; open: boolean;
  registrarNotified: boolean; replenished: boolean; cause: string | null; serviceFeeException: { feesIdentified: string; replenishBy: string; available: boolean } | null;
  outstanding: string[]; events: { kind: string; eventDate: string; amount: string | null; reference: string | null; note: string | null; cause: string | null; by: string; at: string }[];
}
interface Unclaimed {
  id: string; dealId: string; dealNumber: string; trustAccountId: string; entitlement: string; entitledParty: string | null; heldSince: string; remitDue: string;
  monthsHeld: number; escalation: number; amountDue: string; currentTrustBalance: string; belowRemittanceMinimum: boolean; contactAttempts: number;
  lastContactAttempt: string | null; status: string; outstanding: string[];
  events: { kind: string; eventDate: string; method: string | null; outcome: string | null; amount: string | null; reference: string | null; note: string; by: string }[];
}

export function TrustPage({ tab, id }: { tab: string; id?: string }) {
  return (
    <Page wide>
      <PageHeader title="Trust" eyebrow="Real estate and commission trust accounts">
        Monthly reconciliations are prepared under Bank &amp; reconciliation. This page tracks what's outstanding.
      </PageHeader>
      <TabLinks label="Trust sections" current={tab} tabs={[
        { key: "status", label: "Accounts", href: "/trust" },
        { key: "incidents", label: "Shortfalls & discrepancies", href: "/trust/incidents" },
        { key: "unclaimed", label: "Unclaimed money", href: "/trust/unclaimed" },
      ]} />
      {tab === "incidents" ? (id ? <IncidentDetail id={id} /> : <Incidents />) : tab === "unclaimed" ? <UnclaimedList /> : <AccountsStatus />}
    </Page>
  );
}

function AccountsStatus() {
  const res = useApi<{ accounts: AccountStatus[] }>("/api/trust/reconciliation-status");
  const balances = useApi<{ accounts: { id: string; balance: string; bankName: string; accountLast4: string }[] }>("/api/trust/accounts");
  if (res.status === "error" && !res.data) return <Notice kind="error">{res.message}</Notice>;
  if (!res.data) return <Loading />;
  if (res.data.accounts.length === 0) return <Empty>No active trust accounts. A managing broker adds them under Admin → Governance.</Empty>;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {res.data.accounts.map((a) => {
        const b = balances.data?.accounts.find((x) => x.id === a.trustAccountId);
        const overdue = a.awaitingSignature.some((x) => x.overdue) || a.missingStatements.some((x) => x.overdue);
        return (
          <Section key={a.trustAccountId} title={a.name} description={`${labelOf(a.kind)}${b ? ` · ${b.bankName} ••${b.accountLast4}` : ""}`}
            actions={<StatusBadge tone={a.openIncidents.length ? "critical" : overdue ? "serious" : "good"}>{a.openIncidents.length ? "Open incident" : overdue ? "Overdue" : "Up to date"}</StatusBadge>}>
            <Facts items={[
              ["Ledger balance", b ? moneyText(b.balance) : "—"],
              ["Last statement", dateText(a.lastStatementEnd)],
              ["Last signed reconciliation", dateText(a.lastSignedPeriodEnd)],
            ]} />
            {a.missingStatements.length > 0 && (
              <div className="mt-3"><Notice kind={a.missingStatements.some((m) => m.overdue) ? "error" : "warning"} title="Statements not imported">
                <ul className="list-disc pl-5">{a.missingStatements.map((m) => <li key={m.month}>{m.month}: reconciliation due {dateText(m.dueBy)}{m.overdue ? " (overdue)" : ""}</li>)}</ul>
              </Notice></div>
            )}
            {a.awaitingSignature.length > 0 && (
              <div className="mt-3"><Notice kind={a.awaitingSignature.some((m) => m.overdue) ? "error" : "warning"} title="Waiting for the broker of record's signature">
                <ul className="list-disc pl-5">{a.awaitingSignature.map((m) => <li key={m.periodEnd}>{dateText(m.periodEnd)}: due {dateText(m.dueBy)}{m.overdue ? " (overdue)" : ""}</li>)}</ul>
              </Notice></div>
            )}
            {a.openIncidents.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {a.openIncidents.map((i) => <li key={i.id}><Link className="underline" href={`/trust/incidents/${i.id}`}>{labelOf(i.kind)} of {moneyText(i.amount)}</Link>, found {dateText(i.detectedAt)}</li>)}
              </ul>
            )}
          </Section>
        );
      })}
    </div>
  );
}

function Incidents() {
  const [all, setAll] = useState(false);
  const res = useApi<{ incidents: Incident[] }>(`/api/trust/incidents${all ? "" : "?open=true"}`);
  return (
    <Section title={all ? "All incidents" : "Open incidents"} actions={<Button variant="ghost" onClick={() => setAll(!all)}>{all ? "Open only" : "Show all"}</Button>}>
      {!res.data ? (res.status === "error" ? <Notice kind="error">{res.message}</Notice> : <Loading />) : res.data.incidents.length === 0 ? <Empty>None.</Empty> : (
        <Table head={["Found", "Incident", "Amount", "Status"]}>
          {res.data.incidents.map((i) => (
            <tr key={i.id}>
              <td className="px-3 py-2 whitespace-nowrap">{dateText(i.detectedAt)}</td>
              <td className="px-3 py-2"><Link className="font-medium underline" href={`/trust/incidents/${i.id}`}>{labelOf(i.kind)}</Link><span className="block text-xs text-ink-2">{i.summary}</span></td>
              <td className="px-3 py-2 whitespace-nowrap">{moneyText(i.amount)}</td>
              <td className="px-3 py-2"><StatusBadge tone={i.open ? "critical" : "neutral"}>{i.open ? "Open" : "Resolved"}</StatusBadge></td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function IncidentDetail({ id }: { id: string }) {
  const { user } = useSession();
  const bank = hasRole(user, ["ADMIN", "MANAGING_BROKER"]);
  const res = useApi<Incident>(`/api/trust/incidents/${id}`);
  const [view, setView] = useState<Incident | null>(null);
  const i = view ?? res.data;
  if (res.status === "error" && !i) return <Notice kind="error">{res.message}</Notice>;
  if (!i) return <Loading />;
  return (
    <div className="space-y-5">
      <Link href="/trust/incidents" className="text-sm underline">All incidents</Link>
      <Section title={`${labelOf(i.kind)} of ${moneyText(i.amount)}`} description={i.summary}
        actions={<StatusBadge tone={i.open ? "critical" : "neutral"}>{i.open ? "Open" : "Resolved"}</StatusBadge>}>
        <Facts items={[
          ["Found", dateTimeText(i.detectedAt)],
          ["Registrar notified", i.registrarNotified ? "Yes" : "No"],
          ["Replenished", i.replenished ? "Yes" : "No"],
          ["Cause", i.cause ? labelOf(i.cause) : "Not determined"],
          ...(i.serviceFeeException ? [["Bank service fee exception", `${moneyText(i.serviceFeeException.feesIdentified)}, replenish by ${dateText(i.serviceFeeException.replenishBy)}${i.serviceFeeException.available ? "" : " (not available)"}`] as [string, string]] : []),
        ]} />
        {i.kind === "SHORTFALL" && i.open && !i.registrarNotified && (
          <div className="mt-3"><Notice kind="warning" title="The registrar must be told">
            A trust shortfall is reported to RECO's registrar under s.14 unless the bank service fee exception applies. Report it through RECO, then record the reference here.
          </Notice></div>
        )}
        {i.outstanding.length > 0 && <div className="mt-3"><Notice kind="info" title="Before it can be resolved"><ul className="list-disc pl-5">{i.outstanding.map((o) => <li key={o}>{o}</li>)}</ul></Notice></div>}
        {bank && i.open && <div className="mt-3"><InlineForm label="Record a step" variant="primary">{(close) => <IncidentEvent id={i.id} onDone={(v) => { close(); setView(v); }} onCancel={close} />}</InlineForm></div>}
      </Section>
      <Section title="History">
        {i.events.length === 0 ? <Empty>Nothing recorded yet.</Empty> : (
          <ol className="space-y-2 text-sm">
            {i.events.map((e, n) => (
              <li key={n}><span className="font-medium">{labelOf(e.kind)}</span> · {dateText(e.eventDate)}{e.amount ? ` · ${moneyText(e.amount)}` : ""}{e.reference ? ` · ${e.reference}` : ""}{e.cause ? ` · ${labelOf(e.cause)}` : ""}
                {e.note && <span className="block text-ink-2">{e.note}</span>}<span className="block text-xs text-ink-3">{e.by}, {dateTimeText(e.at)}</span></li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}

function IncidentEvent({ id, onDone, onCancel }: { id: string; onDone: (v: Incident) => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ kind: "NOTE", cause: "OTHER", eventDate: todayIso(), amount: "", reference: "", note: "", bankTransactionId: "" });
  const needsRef = f.kind === "REGISTRAR_NOTIFIED" || f.kind === "REPLENISHED";
  const needsNote = ["NOTE", "RESOLVED", "CAUSE_DETERMINED"].includes(f.kind);
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const v = await act.run(() => api<Incident>("POST", `/api/trust/incidents/${id}/events`, {
        kind: f.kind, eventDate: f.eventDate,
        ...(f.kind === "CAUSE_DETERMINED" ? { cause: f.cause, ...(f.cause === "BANK_SERVICE_FEE" ? { bankTransactionId: f.bankTransactionId } : {}) } : {}),
        ...(f.kind === "REPLENISHED" ? { amount: f.amount } : {}),
        ...(f.reference.trim() ? { reference: f.reference } : {}), ...(f.note.trim() ? { note: f.note } : {}),
      }));
      if (v) onDone(v);
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Step" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}
        options={["NOTE", "CAUSE_DETERMINED", "REGISTRAR_NOTIFIED", "REPLENISHED", "RESOLVED"].map((k) => ({ value: k, label: labelOf(k) }))} />
      <TextField label="Date" type="date" value={f.eventDate} onChange={(e) => setF({ ...f, eventDate: e.target.value })} error={act.fields.eventDate} />
      {f.kind === "CAUSE_DETERMINED" && <SelectField label="Cause" value={f.cause} options={[{ value: "OTHER", label: "Other" }, { value: "BANK_SERVICE_FEE", label: "Bank service fee" }]} onChange={(e) => setF({ ...f, cause: e.target.value })} />}
      {f.kind === "CAUSE_DETERMINED" && f.cause === "BANK_SERVICE_FEE" && <TextField label="Bank line (ID)" required hint="The fee line on the imported statement" value={f.bankTransactionId} onChange={(e) => setF({ ...f, bankTransactionId: e.target.value })} error={act.fields.bankTransactionId} />}
      {f.kind === "REPLENISHED" && <TextField label="Amount replenished" required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} error={act.fields.amount} />}
      {(needsRef || f.reference) && <TextField label={f.kind === "REGISTRAR_NOTIFIED" ? "RECO reference" : "Reference"} required={needsRef} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} />}
      <div className="sm:col-span-2"><TextArea label="Note" required={needsNote} rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} error={act.fields.note} /></div>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Save</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function UnclaimedList() {
  const { user } = useSession();
  const bank = hasRole(user, ["ADMIN", "MANAGING_BROKER"]);
  const res = useApi<{ asOf: string; records: Unclaimed[]; totals: { open: number; held: string; dueToReco: number } }>("/api/trust/unclaimed");
  const candidates = useApi<{ candidates: { dealId: string; dealNumber: string; status: string; trustAccountId: string; balance: string; lastActivity: string }[] }>("/api/trust/unclaimed/candidates");
  const reload = () => { res.reload(); candidates.reload(); };
  return (
    <div className="space-y-5">
      <Section title="Registered" description={res.data ? `${res.data.totals.open} open · ${moneyText(res.data.totals.held)} held · ${res.data.totals.dueToReco} ready to remit to RECO` : undefined}>
        {!res.data ? (res.status === "error" ? <Notice kind="error">{res.message}</Notice> : <Loading />) : res.data.records.length === 0 ? <Empty>No unclaimed money registered.</Empty> : (
          <ul className="divide-y divide-line">
            {res.data.records.map((r) => (
              <li key={r.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span><Link className="font-medium underline" href={`/deals/${r.dealId}/trust`}>Deal {r.dealNumber}</Link> · {moneyText(r.amountDue)} · held {r.monthsHeld} months
                    <span className="block text-xs text-ink-2">{labelOf(r.entitlement)}{r.entitledParty ? `: ${r.entitledParty}` : ""} · {r.contactAttempts} contact attempt{r.contactAttempts === 1 ? "" : "s"} · remit by {dateText(r.remitDue)}</span></span>
                  <StatusBadge tone={r.escalation >= 23 ? "critical" : r.escalation >= 18 ? "serious" : "neutral"}>{labelOf(r.status)}</StatusBadge>
                </div>
                {r.outstanding.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-ink-2">{r.outstanding.map((o) => <li key={o}>{o}</li>)}</ul>}
                {bank && !["REMITTED", "CLOSED", "PAID_OUT"].includes(r.status) && <div className="mt-2"><InlineForm label="Record a step">{(close) => <UnclaimedEvent id={r.id} onDone={() => { close(); reload(); }} onCancel={close} />}</InlineForm></div>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Possibly unclaimed" description="Collapsed or cancelled deals, or deals closed over 90 days ago, still holding trust money.">
        {!candidates.data ? (candidates.status === "error" ? <Notice kind="error">{candidates.message}</Notice> : <Loading />) : candidates.data.candidates.length === 0 ? <Empty>None.</Empty> : (
          <ul className="divide-y divide-line text-sm">
            {candidates.data.candidates.map((c) => (
              <li key={c.dealId} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <span><Link className="underline" href={`/deals/${c.dealId}/trust`}>Deal {c.dealNumber}</Link> · {labelOf(c.status)} · {moneyText(c.balance)} · last activity {dateText(c.lastActivity)}</span>
                {bank && <InlineForm label="Register">{(close) => <RegisterUnclaimed dealId={c.dealId} trustAccountId={c.trustAccountId} onDone={() => { close(); reload(); }} onCancel={close} />}</InlineForm>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function RegisterUnclaimed({ dealId, trustAccountId, onDone, onCancel }: { dealId: string; trustAccountId: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ heldSince: "", entitlement: "ENTITLED_PARTY_NOT_LOCATED", entitledParty: "", reason: "" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      if (await act.run(() => api("POST", "/api/trust/unclaimed", { dealId, trustAccountId, ...f, entitledParty: f.entitledParty.trim() || undefined }))) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <TextField label="Held since" type="date" required value={f.heldSince} onChange={(e) => setF({ ...f, heldSince: e.target.value })} error={act.fields.heldSince} />
      <SelectField label="Why it's unclaimed" value={f.entitlement} onChange={(e) => setF({ ...f, entitlement: e.target.value })}
        options={["ENTITLED_PARTY_NOT_LOCATED", "ENTITLEMENT_UNCLEAR", "DISPUTED"].map((k) => ({ value: k, label: labelOf(k) }))} />
      {f.entitlement === "ENTITLED_PARTY_NOT_LOCATED" && <TextField label="Who it belongs to" required value={f.entitledParty} onChange={(e) => setF({ ...f, entitledParty: e.target.value })} error={act.fields.entitledParty} />}
      <div className="sm:col-span-2"><TextArea label="Reason" required rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} error={act.fields.reason} /></div>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Register</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function UnclaimedEvent({ id, onDone, onCancel }: { id: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ kind: "CONTACT_ATTEMPT", eventDate: todayIso(), method: "", outcome: "", amount: "", reference: "", note: "" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const o = (v: string) => v.trim() || undefined;
      if (await act.run(() => api("POST", `/api/trust/unclaimed/${id}/events`, { kind: f.kind, eventDate: f.eventDate, method: o(f.method), outcome: o(f.outcome), amount: o(f.amount), reference: o(f.reference), note: f.note }))) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Step" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}
        options={["CONTACT_ATTEMPT", "NOTE", "PARTY_LOCATED", "INTEREST_ACCRUED", "RESOLVED_PAID_OUT", "REMITTED_TO_RECO", "CLOSED"].map((k) => ({ value: k, label: labelOf(k) }))} />
      <TextField label="Date" type="date" value={f.eventDate} onChange={(e) => setF({ ...f, eventDate: e.target.value })} />
      {f.kind === "CONTACT_ATTEMPT" && <TextField label="How" required hint="Phone, email, registered mail…" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} error={act.fields.method} />}
      {f.kind === "CONTACT_ATTEMPT" && <TextField label="Outcome" required value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} error={act.fields.outcome} />}
      {(f.kind === "INTEREST_ACCRUED" || f.kind === "REMITTED_TO_RECO") && <TextField label="Amount" required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} error={act.fields.amount} />}
      {(f.kind === "REMITTED_TO_RECO" || f.kind === "RESOLVED_PAID_OUT") && <TextField label="Reference" required value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} />}
      <div className="sm:col-span-2"><TextArea label="Note" required rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} error={act.fields.note} /></div>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Save</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
