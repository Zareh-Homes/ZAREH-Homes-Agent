import { useState } from "react";
import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { hasRole, useSession } from "../app/session.tsx";
import { Button, Empty, Facts, Loading, Notice, Section, SelectField, StatusBadge, Table, TextArea, TextField } from "../ui/kit.tsx";
import { ConfirmButton, InlineForm } from "../ui/Disclosure.tsx";
import { dateText, dateTimeText, isLease, labelOf, moneyText } from "../ui/format.ts";
import type { TabProps } from "./DealWorkspace.tsx";

interface Lifecycle {
  dealId: string; status: string; side: string;
  conditions: { id: string; kind: string; description: string; forBenefitOf: string; dueAt: string; state: string; overdue: boolean;
    history: { outcome: string; eventAt: string; newDueAt: string | null; reference: string }[] }[];
  amendments: { field: string; oldValue: string | null; newValue: string; effectiveDate: string; reference: string }[];
  termination: { reason: string; terminatedOn: string; reference: string; note: string } | null;
  trustBalance: string;
  nextSteps: string[];
}

const HOLDER: Record<string, string> = { OUR_BROKERAGE: "Our brokerage (trust)", COOP_BROKERAGE: "Other brokerage", LAWYER: "Lawyer in trust", BUILDER: "Builder / trustee" };
const CONDITION_KINDS = ["FINANCING", "INSPECTION", "STATUS_CERTIFICATE", "SALE_OF_BUYERS_PROPERTY", "LAWYER_REVIEW", "INSURANCE", "OTHER"];
const MONEY_FIELDS = new Set(["SALE_PRICE", "DEPOSIT_AMOUNT", "TOTAL_GCI", "COOP_COMMISSION"]);

export function OverviewTab({ deal, reloadDeal }: TabProps) {
  const { user } = useSession();
  const life = useApi<Lifecycle>(`/api/deals/${deal.id}/lifecycle`);
  const act = useAction();
  const lease = isLease(deal.side);
  const canCommission = hasRole(user, ["MANAGING_BROKER", "ADMIN"]);
  const after = () => { life.reload(); reloadDeal(); };
  const open = deal.status === "CONDITIONAL" || deal.status === "FIRM";

  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <div className="space-y-5 xl:col-span-2">
        {life.data && life.data.nextSteps.length > 0 && (
          <Notice kind="info" title="Next steps"><ul className="list-disc pl-5">{life.data.nextSteps.map((s) => <li key={s}>{s}</li>)}</ul></Notice>
        )}
        {act.error && <Notice kind="error">{act.error}</Notice>}

        <Section title="Terms">
          <Facts items={[
            [lease ? "Monthly rent" : "Sale price", moneyText(deal.salePrice)],
            [lease ? "Agreement date" : "Offer date", dateText(deal.offerDate)],
            ["Conditions due", dateText(deal.conditionsDueDate)],
            [lease ? "Commencement" : "Closing", dateText(deal.closeDate)],
            ["Deposit", `${moneyText(deal.depositAmount)}${deal.depositDueDate ? `, due ${dateText(deal.depositDueDate)}` : ""}`],
            ["Deposit held by", HOLDER[deal.trustDepositHolder] ?? deal.trustDepositHolder],
            ["Our commission (before tax)", moneyText(deal.totalGci)],
            ...(Number(deal.coopCommission) > 0 ? [["Co-op commission", `${moneyText(deal.coopCommission)} to ${deal.coopBrokerageName ?? "the other brokerage"}`] as [string, string]] : []),
            ...(deal.outsideReferralPayee ? [["Outside referral", `${deal.outsideReferralPct}% to ${deal.outsideReferralPayee}`] as [string, string]] : []),
            ["Trust balance", life.data ? moneyText(life.data.trustBalance) : "…"],
          ]} />
        </Section>

        <Section title="Conditions" description="The deal goes firm only once every condition is fulfilled or waived, with the document."
          actions={deal.status === "CONDITIONAL" ? (
            <InlineForm label="Add a condition">{(close) => <AddCondition dealId={deal.id} lease={lease} onDone={() => { close(); after(); }} />}</InlineForm>
          ) : undefined}>
          {!life.data ? <Loading /> : life.data.conditions.length === 0 ? <Empty>No conditions recorded.</Empty> : (
            <ul className="divide-y divide-line">
              {life.data.conditions.map((c) => (
                <li key={c.id} className="py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink">{labelOf(c.kind)} <span className="font-normal text-ink-3">for the {labelOf(c.forBenefitOf).toLowerCase()}</span></p>
                      <p className="text-sm text-ink-2">{c.description}</p>
                      <p className="text-xs text-ink-3">Due {dateTimeText(c.dueAt)}</p>
                    </div>
                    <StatusBadge tone={c.state === "FULFILLED" || c.state === "WAIVED" ? "good" : c.state === "FAILED" || c.overdue ? "critical" : "warning"}>
                      {c.overdue && (c.state === "OPEN" || c.state === "EXTENDED") ? "Overdue" : labelOf(c.state)}
                    </StatusBadge>
                  </div>
                  {(c.state === "OPEN" || c.state === "EXTENDED") && (
                    <div className="mt-2"><InlineForm label="Record the outcome">{(close) => <ConditionOutcome conditionId={c.id} onDone={() => { close(); after(); }} />}</InlineForm></div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Amendments" description="A recorded change to the deal's terms, with the signed amendment as the reference."
          actions={open ? (
            <InlineForm label="Record an amendment">{(close) => <Amend dealId={deal.id} canCommission={canCommission} onDone={() => { close(); after(); }} />}</InlineForm>
          ) : undefined}>
          {!life.data ? <Loading /> : life.data.amendments.length === 0 ? <Empty>No amendments.</Empty> : (
            <Table head={["What", "Was", "Now", "Effective", "Reference"]}>
              {life.data.amendments.map((a, i) => (
                <tr key={i}>
                  <td>{labelOf(a.field)}</td>
                  <td>{MONEY_FIELDS.has(a.field) ? moneyText(a.oldValue) : a.oldValue ?? "—"}</td>
                  <td>{MONEY_FIELDS.has(a.field) ? moneyText(a.newValue) : a.newValue}</td>
                  <td>{dateText(a.effectiveDate)}</td>
                  <td>{a.reference}</td>
                </tr>
              ))}
            </Table>
          )}
        </Section>
      </div>

      <div className="space-y-5">
        <Section title="Status">
          <div className="space-y-3">
            {life.data?.termination && (
              <Notice kind="warning" title={`Terminated ${dateText(life.data.termination.terminatedOn)}`}>
                {labelOf(life.data.termination.reason)} · {life.data.termination.reference}. {life.data.termination.note}
              </Notice>
            )}
            {deal.status === "CONDITIONAL" && (
              <ConfirmButton label="Mark firm" question="All conditions are fulfilled or waived?" busy={act.busy}
                onConfirm={() => void act.run(() => api("POST", `/api/deals/${deal.id}/firm`)).then((r) => r && after())} />
            )}
            {deal.status === "FIRM" && <CloseDeal dealId={deal.id} lease={lease} onDone={after} />}
            {open && <InlineForm label="Terminate the deal" variant="danger">{(close) => <Terminate dealId={deal.id} onDone={() => { close(); after(); }} />}</InlineForm>}
            {!open && !life.data?.termination && <p className="text-sm text-ink-2">This deal is {labelOf(deal.status).toLowerCase()}.</p>}
          </div>
        </Section>

        <Section title="Agents">
          <ul className="space-y-2 text-sm">
            {deal.agents.map((a) => (
              <li key={a.userId} className="flex justify-between gap-2">
                <span className="text-ink">{a.name}<span className="block text-xs text-ink-3">{labelOf(a.role)}{a.isPrec ? ` · paid to ${a.precLegalName}` : ""}</span></span>
                <span className="whitespace-nowrap text-ink-2">{a.splitPct}% split</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="People" actions={open ? (
          <InlineForm label="Add a person">{(close) => <AddParty dealId={deal.id} lease={lease} onDone={() => { close(); reloadDeal(); }} />}</InlineForm>
        ) : undefined}>
          <ul className="space-y-3 text-sm">
            {deal.parties.map((p) => (
              <li key={p.id}>
                <span className="font-medium text-ink">{p.fullName}</span>
                <span className="block text-xs text-ink-3">
                  {labelOf(p.role)}{p.entityType === "CORPORATION" ? " · corporation" : ""}{p.representation ? ` · ${labelOf(p.representation).toLowerCase()}` : ""}
                </span>
                {(p.email || p.phone) && <span className="block text-xs text-ink-2">{[p.email, p.phone].filter(Boolean).join(" · ")}</span>}
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

function AddCondition({ dealId, lease, onDone }: { dealId: string; lease: boolean; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ kind: "FINANCING", description: "", forBenefitOf: lease ? "TENANT" : "BUYER", dueAt: "" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/deals/${dealId}/conditions`, { ...f, dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : "" }));
      if (ok) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Condition" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={CONDITION_KINDS.map((k) => ({ value: k, label: labelOf(k) }))} />
      <SelectField label="For the benefit of" value={f.forBenefitOf} onChange={(e) => setF({ ...f, forBenefitOf: e.target.value })}
        options={(lease ? ["TENANT", "LANDLORD", "BOTH"] : ["BUYER", "SELLER", "BOTH"]).map((k) => ({ value: k, label: labelOf(k) }))} />
      <TextField label="Due" type="datetime-local" required value={f.dueAt} onChange={(e) => setF({ ...f, dueAt: e.target.value })} error={act.fields.dueAt} />
      <TextField label="Description" required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} error={act.fields.description} />
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Add condition</Button><Button onClick={onDone}>Cancel</Button></div>
    </form>
  );
}

function ConditionOutcome({ conditionId, onDone }: { conditionId: string; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ outcome: "FULFILLED", reference: "", newDueAt: "", note: "" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/conditions/${conditionId}/outcome`, {
        outcome: f.outcome, reference: f.reference, ...(f.outcome === "EXTENDED" ? { newDueAt: f.newDueAt ? new Date(f.newDueAt).toISOString() : "" } : {}),
        ...(f.note.trim() ? { note: f.note } : {}),
      }));
      if (ok) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })}
        options={["FULFILLED", "WAIVED", "EXTENDED", "FAILED"].map((k) => ({ value: k, label: labelOf(k) }))} />
      <TextField label="Document / reference" required hint="e.g. Form 124 notice of fulfillment, signed Nov 9" value={f.reference}
        onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} />
      {f.outcome === "EXTENDED" && <TextField label="New due date" type="datetime-local" required value={f.newDueAt} onChange={(e) => setF({ ...f, newDueAt: e.target.value })} error={act.fields.newDueAt} />}
      <TextField label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Save outcome</Button><Button onClick={onDone}>Cancel</Button></div>
    </form>
  );
}

function CloseDeal({ dealId, lease, onDone }: { dealId: string; lease: boolean; onDone: () => void }) {
  const act = useAction();
  const [closedOn, setClosedOn] = useState("");
  return (
    <InlineForm label={lease ? "Record commencement" : "Record the closing"} variant="primary">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act.run(() => api("POST", `/api/deals/${dealId}/close`, closedOn ? { closedOn } : {}));
          if (ok) { close(); onDone(); }
        }}>
          {act.error && <Notice kind="error">{act.error}</Notice>}
          <TextField label={lease ? "Commenced on" : "Closed on"} type="date" value={closedOn} onChange={(e) => setClosedOn(e.target.value)}
            hint="Leave blank to keep the date on the deal" error={act.fields.closedOn} />
          <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Mark closed</Button><Button onClick={close}>Cancel</Button></div>
        </form>
      )}
    </InlineForm>
  );
}

function Terminate({ dealId, onDone }: { dealId: string; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ reason: "CONDITION_NOT_MET", reference: "", note: "", terminatedOn: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/deals/${dealId}/terminate`, { reason: f.reason, reference: f.reference, note: f.note, ...(f.terminatedOn ? { terminatedOn: f.terminatedOn } : {}) }));
      if (ok) onDone();
    }}>
      <p className="text-sm text-ink-2">Money in trust is released only under a signed mutual release or a court order, from the Trust tab.</p>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <SelectField label="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })}
        options={["CONDITION_NOT_MET", "MUTUAL_RELEASE", "BUYER_DEFAULT", "SELLER_DEFAULT", "OTHER"].map((k) => ({ value: k, label: labelOf(k) }))} />
      <TextField label="Document / reference" required hint="e.g. Form 122 mutual release, signed by both parties Nov 12" value={f.reference}
        onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} />
      <TextField label="Terminated on" type="date" value={f.terminatedOn} onChange={(e) => setF({ ...f, terminatedOn: e.target.value })} />
      <TextArea label="Note" required value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} error={act.fields.note} />
      <div className="flex gap-2"><Button type="submit" variant="danger" busy={act.busy}>Terminate</Button><Button onClick={onDone}>Cancel</Button></div>
    </form>
  );
}

function Amend({ dealId, canCommission, onDone }: { dealId: string; canCommission: boolean; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ field: "CLOSE_DATE", newValue: "", reference: "", effectiveDate: "" });
  const fields = ["SALE_PRICE", "CLOSE_DATE", "DEPOSIT_AMOUNT", "DEPOSIT_DUE_DATE", ...(canCommission ? ["TOTAL_GCI", "COOP_COMMISSION"] : []), "OTHER"];
  const isDate = f.field === "CLOSE_DATE" || f.field === "DEPOSIT_DUE_DATE";
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/deals/${dealId}/amendments`, { field: f.field, newValue: f.newValue, reference: f.reference, ...(f.effectiveDate ? { effectiveDate: f.effectiveDate } : {}) }));
      if (ok) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="What changed" value={f.field} onChange={(e) => setF({ ...f, field: e.target.value, newValue: "" })}
        options={fields.map((k) => ({ value: k, label: k === "TOTAL_GCI" ? "Our commission" : labelOf(k) }))} />
      {f.field === "OTHER"
        ? <TextArea label="The change" required value={f.newValue} onChange={(e) => setF({ ...f, newValue: e.target.value })} error={act.fields.newValue} />
        : <TextField label="New value" type={isDate ? "date" : "text"} inputMode={isDate ? undefined : "decimal"} required value={f.newValue}
            onChange={(e) => setF({ ...f, newValue: e.target.value })} error={act.fields.newValue} />}
      <TextField label="Document / reference" required hint="e.g. Form 120 amendment, signed Nov 3" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} />
      <TextField label="Effective" type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} hint="Default: today" />
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Record amendment</Button><Button onClick={onDone}>Cancel</Button></div>
    </form>
  );
}

function AddParty({ dealId, lease, onDone }: { dealId: string; lease: boolean; onDone: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ role: lease ? "TENANT" : "SELLER_LAWYER", entityType: "INDIVIDUAL", fullName: "", email: "", phone: "", representation: "" });
  const roles = lease ? ["LANDLORD", "TENANT", "COOP_BROKERAGE"] : ["SELLER", "BUYER", "SELLER_LAWYER", "BUYER_LAWYER", "COOP_BROKERAGE"];
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/deals/${dealId}/parties`, {
        role: f.role, entityType: f.entityType, fullName: f.fullName.trim(), ...(f.email.trim() ? { email: f.email.trim() } : {}),
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}), ...(f.representation ? { representation: f.representation } : {}),
      }));
      if (ok) onDone();
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <SelectField label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} options={roles.map((r) => ({ value: r, label: labelOf(r) }))} />
      <TextField label="Full legal name" required value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} error={act.fields.fullName} />
      <SelectField label="Individual or corporation" value={f.entityType} onChange={(e) => setF({ ...f, entityType: e.target.value })}
        options={[{ value: "INDIVIDUAL", label: "Individual" }, { value: "CORPORATION", label: "Corporation" }]} />
      <TextField label="Email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={act.fields.email} />
      <TextField label="Phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      <SelectField label="Representation" value={f.representation} placeholder="Not recorded yet" onChange={(e) => setF({ ...f, representation: e.target.value })}
        options={[{ value: "OUR_CLIENT", label: "Our client" }, { value: "REPRESENTED_ELSEWHERE", label: "Represented elsewhere" }, { value: "SELF_REPRESENTED", label: "Self-represented" }]} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Add</Button><Button onClick={onDone}>Cancel</Button></div>
    </form>
  );
}
