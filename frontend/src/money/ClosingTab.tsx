/**
 * Closing: the commission statement the server computes, the CDA it renders,
 * finalizing (which posts the trust distributions), then the commission
 * received and the payouts that follow. Every figure on this screen is the
 * server's; nothing is added up here. Recording a payment records what was
 * done in the bank portal; the app sends no money.
 */

import { useRef, useState } from "react";
import { api, apiText, newKey } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { hasRole, useSession } from "../app/session.tsx";
import { Button, Empty, Facts, Loading, Notice, Section, SelectField, StatusBadge, Table, TextArea, TextField, type Tone } from "../ui/kit.tsx";
import { ConfirmButton, InlineForm } from "../ui/Disclosure.tsx";
import { centsText, dateText, dateTimeText, isLease, labelOf, moneyText, todayIso } from "../ui/format.ts";
import type { TabProps } from "../deals/DealWorkspace.tsx";

type Cents = number;
interface Taxed { base: Cents; hst: Cents; total: Cents }
interface Computation {
  cdaNumber: string; hstRate: number; taxName: string; payer: { kind: string; name: string };
  incoming: { commission: Taxed; coop: Taxed; totalPayable: Cents; sides?: { listing: Cents; buyer: Cents } | null };
  agents: { userId: string; name: string; payeeName: string; side?: "LISTING" | "BUYER" | "BOTH" | null; fromSides?: { listing: Cents; buyer: Cents } | null; split: Taxed; feesTotal: Taxed; payout: Cents; owes: Cents; effectiveSplitBps: number; capReachedOnThisDeal: boolean;
    adjustments: { id: string; kind: string; description: string; signedTotal: Cents }[] }[];
  brokerage: { netEarnedShare: Taxed; referral: (Taxed & { payee: string }) | null; netHstEstimate: Cents; agentPayablesTotal: Cents };
  trust: { held: Cents; appliedToCommission: Cents; balanceDueToLawyer: Cents; balanceDueFromLawyer: Cents; distributions: { entryType: string; payee: string; amount: Cents; purpose: string }[] };
  wires: { payeeName: string; owed: Taxed; lessFromTrust: Cents; amount: Cents }[]; wiresTotal: Cents; warnings: string[];
}
interface ClosingView { finalized: boolean; finalizedAt: string | null; revision: number | null; computation: Computation }
interface PayoutLine {
  id: string; kind: "AGENT" | "COOP_BROKERAGE" | "REFERRAL"; payeeName: string; amount: string; carriedForward: string; remaining: string; status: string;
  approvedAt: string | null; paidAt: string | null; paymentReference: string | null; paymentConfirmed: boolean | null; recoveryRequired: boolean;
  history: { kind: string; eventDate: string; amount: string | null; reference: string | null; note: string | null; by: string }[];
}
interface PayoutsView {
  cdaNumber: string; revision: number; commissionDue: string; commissionReceived: string;
  receipts: { id: string; amount: string; receivedDate: string; reference: string; account: { type: string; id: string } | null; bankVerified: boolean; reversed: boolean }[];
  payouts: PayoutLine[];
}
interface Adjustment { id: string; agent: string; userId: string; kind: string; description: string; amount: string; taxable: boolean; status: string }

const WARNINGS: Record<string, string> = {
  CLOSING_LAWYER_HAS_NO_CONTACT_DETAILS: "The closing lawyer has no email or phone on the deal",
  NO_COMMISSION_PLAN: "No approved commission plan for",
  AGENT_NOT_HST_REGISTERED: "No HST number on file (no HST added to their split) for",
  SPLIT_DIFFERS_FROM_PLAN: "The deal's split differs from the plan for",
  AGENT_OWES_FEES: "Fees exceed the split; the agent owes the brokerage:",
  TRUST_BALANCE_DIFFERS_FROM_DEPOSIT_AMOUNT: "The amount held in trust differs from the deposit in the agreement",
};
/** "AGENT_NOT_HST_REGISTERED:Morgan Agent" → "No HST number on file … for Morgan Agent" */
const warningText = (w: string) => {
  const [code, ...rest] = w.split(":");
  const text = WARNINGS[code!] ?? labelOf(code);
  return rest.length ? `${text} ${rest.join(": ")}` : text;
};

const PAYOUT_HELP: Record<string, string> = {
  AWAITING_COMMISSION: "Waiting for the full commission. Paying part of a commission isn't supported: this payout waits until all of it is received.",
  AWAITING_BANK_VERIFICATION: "Received, but not yet matched to a bank file someone else verified.",
  AWAITING_POLICY_APPROVAL: "Co-op and referral payables stay off until the broker of record's THIRD_PARTY_PAYABLES decision.",
  READY_FOR_APPROVAL: "A managing broker who didn't record or match the commission approves it.",
  APPROVED: "Send the payment in the bank portal, then record it here.",
  PAYMENT_RETURNED: "The payment came back. Send it again and record it.",
};

const SIDE_TEXT = { LISTING: "Represents the seller", BUYER: "Represents the buyer", BOTH: "Represents seller and buyer" } as const;

const PAYOUT_TONE: Record<string, Tone> = {
  AWAITING_COMMISSION: "neutral", AWAITING_BANK_VERIFICATION: "warning", AWAITING_POLICY_APPROVAL: "warning", READY_FOR_APPROVAL: "neutral",
  APPROVED: "neutral", PAID: "good", PAYMENT_RETURNED: "critical", NOTHING_OWED: "neutral",
};

export function ClosingTab({ deal, reloadDeal }: TabProps) {
  const { user } = useSession();
  const broker = hasRole(user, ["MANAGING_BROKER"]);
  const bank = hasRole(user, ["ADMIN", "MANAGING_BROKER"]);
  const view = useApi<ClosingView>(`/api/deals/${deal.id}/closing`);
  const policies = useApi<{ policies: { policy: string; enabled: boolean }[] }>(isLease(deal.side) ? "/api/financial-policies" : null);
  const leaseBlocked = isLease(deal.side) && !policies.data?.policies.find((p) => p.policy === "LEASE_SETTLEMENT")?.enabled;
  const act = useAction();
  // One key per CDA: a double-click replays it, but a new CDA after a void needs a new key
  const [key, setKey] = useState(() => newKey());
  const lease = isLease(deal.side);

  const outstanding = (act.failure ?? (view.status === "error" ? view.error : null)) as { details?: Record<string, unknown> } | null;
  const detailList = (outstanding?.details?.outstanding as string[] | undefined) ?? [];

  const leaseNotice = leaseBlocked && (
    <Notice kind="warning" title="Lease settlement isn't enabled">
      Any statement here is a preview only. A lease's CDA and payments out of trust stay off until the broker of record records counsel's
      sign-off (Admin → Financial policies → Lease settlement): commission from the first and last month's rent, the tenant's entitlement
      to that deposit, and the signed commission agreement. The deposit can still be received, held and refunded.
    </Notice>
  );

  if (view.status === "error" && !view.data) {
    return (
      <div className="space-y-4">{leaseNotice}
      <Notice kind="warning" title="The closing statement can't be prepared yet">
        {view.message}
        {detailList.length > 0 && <ul className="mt-1 list-disc pl-5">{detailList.map((d) => <li key={d}>{d}</li>)}</ul>}
      </Notice>
      </div>
    );
  }
  if (!view.data) return <Loading label="Preparing the closing statement" />;
  const v = view.data;
  const c = v.computation;
  const reload = () => { view.reload(); reloadDeal(); };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusBadge tone={v.finalized ? "good" : "warning"}>
          {v.finalized ? `CDA ${c.cdaNumber} issued ${dateTimeText(v.finalizedAt)}` : `Draft: ${deal.status === "CLOSED" ? "ready to finalize" : `finalize after ${lease ? "commencement" : "closing"}`}`}
        </StatusBadge>
        <div className="flex flex-wrap gap-2">
          {broker && !v.finalized && deal.status === "CLOSED" && !leaseBlocked && (
            <ConfirmButton label="Finalize the CDA" busy={act.busy}
              question="This issues the CDA and posts the trust distributions below to the ledger. It records them; it doesn't send any money."
              onConfirm={() => void act.run(() => api("POST", `/api/deals/${deal.id}/closing/finalize`, {}, { idempotencyKey: key })).then((r) => { if (r) { setKey(newKey()); reload(); } })} />
          )}
          {broker && v.finalized && <InlineForm label="Void the CDA" variant="danger">{(close) => <VoidCda dealId={deal.id} onDone={() => { close(); reload(); }} onCancel={close} />}</InlineForm>}
        </div>
      </div>
      {leaseNotice}
      {act.error && <Notice kind="error">{act.error}{detailList.length > 0 && <ul className="mt-1 list-disc pl-5">{detailList.map((d) => <li key={d}>{d}</li>)}</ul>}</Notice>}
      {c.warnings.length > 0 && (
        <Notice kind="warning" title={v.finalized ? "Noted when the CDA was issued" : "Check before finalizing"}>
          <ul className="list-disc pl-5">{c.warnings.map((w) => <li key={w}>{warningText(w)}</li>)}</ul>
        </Notice>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Commission">
          <Facts items={[
            ["Payable by", `${c.payer.name} (${labelOf(c.payer.kind).toLowerCase()})`],
            ["Commission", `${centsText(c.incoming.commission.base)} + ${c.taxName} ${centsText(c.incoming.commission.hst)} = ${centsText(c.incoming.commission.total)}`],
            ...(c.incoming.coop.total ? [["Co-operating brokerage", centsText(c.incoming.coop.total)] as [string, string]] : []),
            ...(c.brokerage.referral ? [[`Referral to ${c.brokerage.referral.payee}`, centsText(c.brokerage.referral.total)] as [string, string]] : []),
            ...(c.incoming.sides ? [["Of which", `listing side ${centsText(c.incoming.sides.listing)} · buyer side ${centsText(c.incoming.sides.buyer)} (billed once)`] as [string, string]] : []),
            // HST is collected for remittance, not earned: shown apart from the brokerage's share. It's the HST
            // collected on the whole commission less HST paid to agents, not tax on the brokerage's share alone.
            ["Brokerage share (before expenses)", centsText(c.brokerage.netEarnedShare.base)],
            [`${c.taxName} to remit (collected on the commission, less ${c.taxName} paid to agents)`, centsText(c.brokerage.netEarnedShare.hst)],
            [`Net ${c.taxName} (this deal, estimate)`, centsText(c.brokerage.netHstEstimate)],
          ]} />
        </Section>
        <Section title="Trust">
          <Facts items={[
            ["Held", centsText(c.trust.held)],
            ["Applied to commission", centsText(c.trust.appliedToCommission)],
            [lease ? "Balance to the landlord" : "Deposit balance to the seller's lawyer", centsText(c.trust.balanceDueToLawyer)],
            ["Balance still owed to us", centsText(c.trust.balanceDueFromLawyer)],
          ]} />
          {c.trust.distributions.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {c.trust.distributions.map((d, i) => <li key={i}>{labelOf(d.entryType)}: {centsText(d.amount)} to {d.payee} <span className="text-ink-3">({d.purpose})</span></li>)}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Agents">
        <Table head={["Agent", "Split", "Fees", "Adjustments", "Payout"]}>
          {c.agents.map((a) => (
            <tr key={a.userId} className="align-top">
              <td className="px-3 py-2">{a.name}{a.payeeName !== a.name && <span className="block text-xs text-ink-3">Paid to {a.payeeName}</span>}
                {a.fromSides && <span className="block text-xs text-ink-2">{SIDE_TEXT[a.side ?? "BOTH"]}: {[
                  a.fromSides.listing ? `${centsText(a.fromSides.listing)} from the listing side` : "",
                  a.fromSides.buyer ? `${centsText(a.fromSides.buyer)} from the buyer side` : ""].filter(Boolean).join(" + ")}</span>}
                <span className="block text-xs text-ink-3">{a.effectiveSplitBps / 100}% split{a.capReachedOnThisDeal ? " · cap reached on this deal" : ""}</span></td>
              <td className="px-3 py-2 whitespace-nowrap tabular-nums">{centsText(a.split.total)}</td>
              <td className="px-3 py-2 whitespace-nowrap tabular-nums">{centsText(a.feesTotal.total)}</td>
              <td className="px-3 py-2">{a.adjustments.length === 0 ? "—" : a.adjustments.map((x) => <span key={x.id} className="block">{x.description}: {centsText(x.signedTotal)}</span>)}</td>
              <td className="px-3 py-2 whitespace-nowrap font-medium tabular-nums">{centsText(a.payout)}{a.owes > 0 && <span className="block text-xs text-critical">Owes {centsText(a.owes)}</span>}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <CdaDocument dealId={deal.id} finalized={v.finalized} />
      {!v.finalized && <Adjustments dealId={deal.id} agents={deal.agents} canAdd={bank} canApprove={broker} onChange={view.reload} />}
      {v.finalized && <Payouts dealId={deal.id} broker={broker} bank={bank} />}
    </div>
  );
}

/** The CDA as the server renders it, shown in a frame without scripts. */
function CdaDocument({ dealId, finalized }: { dealId: string; finalized: boolean }) {
  const [audience, setAudience] = useState<"lawyer" | "internal">("lawyer");
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const load = async (a: "lawyer" | "internal") => {
    setAudience(a); setBusy(true); setError(null);
    try { setHtml(await apiText(`/api/deals/${dealId}/closing/cda?audience=${a}`)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Section title={finalized ? "Commission direction" : "Commission direction (draft)"}
      actions={<div className="flex flex-wrap gap-2">
        <Button busy={busy && audience === "lawyer"} onClick={() => void load("lawyer")}>{html && audience === "lawyer" ? "Refresh" : "Show"} lawyer copy</Button>
        <Button busy={busy && audience === "internal"} onClick={() => void load("internal")}>Internal copy</Button>
        {html && <Button variant="primary" onClick={() => frame.current?.contentWindow?.print()}>Print</Button>}
      </div>}>
      {error && <Notice kind="error">{error}</Notice>}
      {html ? <iframe ref={frame} title="Commission direction" sandbox="allow-same-origin allow-modals" srcDoc={html} className="h-[70vh] w-full rounded-lg border border-line bg-white" />
        : <p className="text-sm text-ink-2">Open the copy for the lawyer, or the internal copy with agent statements and the {`HST`} position.</p>}
    </Section>
  );
}

function VoidCda({ dealId, onDone, onCancel }: { dealId: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [reason, setReason] = useState("");
  return (
    <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api("POST", `/api/deals/${dealId}/closing/void`, { reason }))) onDone(); }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <p className="text-sm text-ink-2">Open approvals are cancelled. Payments already made carry forward, and trust distributions stay unless reversed.</p>
      <TextArea label="Reason" required rows={2} value={reason} onChange={(e) => setReason(e.target.value)} error={act.fields.reason} />
      <div className="flex gap-2"><Button type="submit" variant="danger" busy={act.busy}>Void</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Adjustments({ dealId, agents, canAdd, canApprove, onChange }: { dealId: string; agents: TabProps["deal"]["agents"]; canAdd: boolean; canApprove: boolean; onChange: () => void }) {
  const list = useApi<Adjustment[]>(`/api/deals/${dealId}/commission-adjustments`);
  const act = useAction();
  const done = () => { list.reload(); onChange(); };
  return (
    <Section title="Bonuses and deductions" description="Approved by a managing broker who didn't add them. Locked once the CDA is issued."
      actions={canAdd && <InlineForm label="Add">{(close) => <NewAdjustment dealId={dealId} agents={agents} onDone={() => { close(); done(); }} onCancel={close} />}</InlineForm>}>
      {act.error && <div className="mb-3"><Notice kind="error">{act.error}</Notice></div>}
      {!list.data ? (list.status === "error" ? <Notice kind="error">{list.message}</Notice> : <Loading />) : list.data.length === 0 ? <Empty>None.</Empty> : (
        <ul className="divide-y divide-line text-sm">
          {list.data.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{a.agent}: {labelOf(a.kind)} {moneyText(a.amount)}{a.taxable ? " + tax" : ""} · {a.description} <StatusBadge tone={a.status === "APPROVED" ? "good" : "neutral"}>{labelOf(a.status)}</StatusBadge></span>
              {a.status === "PROPOSED" && (
                <span className="flex gap-2">
                  {canApprove && <Button variant="primary" busy={act.busy} onClick={async () => { if (await act.run(() => api("POST", `/api/commission-adjustments/${a.id}/approve`, {}))) done(); }}>Approve</Button>}
                  {canAdd && <Button variant="ghost" busy={act.busy} onClick={async () => { if (await act.run(() => api("POST", `/api/commission-adjustments/${a.id}/withdraw`, {}))) done(); }}>Withdraw</Button>}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function NewAdjustment({ dealId, agents, onDone, onCancel }: { dealId: string; agents: TabProps["deal"]["agents"]; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ userId: agents[0]?.userId ?? "", kind: "BONUS", description: "", amount: "", taxable: "false" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      if (await act.run(() => api("POST", `/api/deals/${dealId}/commission-adjustments`, { ...f, taxable: f.taxable === "true" }))) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Agent" value={f.userId} options={agents.map((a) => ({ value: a.userId, label: a.name }))} onChange={(e) => setF({ ...f, userId: e.target.value })} />
      <SelectField label="Kind" value={f.kind} options={[{ value: "BONUS", label: "Bonus" }, { value: "DEDUCTION", label: "Deduction" }]} onChange={(e) => setF({ ...f, kind: e.target.value })} />
      <TextField label="Amount" required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} error={act.fields.amount} />
      <SelectField label="Tax" value={f.taxable} options={[{ value: "false", label: "No tax" }, { value: "true", label: "Plus HST/GST" }]} onChange={(e) => setF({ ...f, taxable: e.target.value })} />
      <div className="sm:col-span-2"><TextField label="Description" required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} error={act.fields.description} /></div>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Add</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

// ── After the CDA: commission received, payouts ──────────────────────────────

interface Account { type: "OPERATING" | "COMMISSION_TRUST"; id: string; label: string }

function useCommissionAccounts(enabled: boolean): Account[] {
  const ops = useApi<{ accounts: { id: string; name: string; accountLast4: string; isActive: boolean }[] }>(enabled ? "/api/operating-accounts" : null);
  const trust = useApi<{ accounts: { id: string; name: string; kind: string; accountLast4: string; isActive: boolean }[] }>(enabled ? "/api/trust/accounts" : null);
  return [
    ...(ops.data?.accounts ?? []).filter((a) => a.isActive).map((a) => ({ type: "OPERATING" as const, id: a.id, label: `${a.name} ••${a.accountLast4} (operating)` })),
    ...(trust.data?.accounts ?? []).filter((a) => a.isActive && a.kind === "COMMISSION_TRUST").map((a) => ({ type: "COMMISSION_TRUST" as const, id: a.id, label: `${a.name} ••${a.accountLast4} (commission trust)` })),
  ];
}

function Payouts({ dealId, broker, bank }: { dealId: string; broker: boolean; bank: boolean }) {
  const res = useApi<PayoutsView>(`/api/deals/${dealId}/closing/payouts`);
  const accounts = useCommissionAccounts(bank);
  const [view, setView] = useState<PayoutsView | null>(null);
  const p = view ?? res.data;
  if (res.status === "error" && !p) return <Notice kind="error">{res.message}</Notice>;
  if (!p) return <Loading label="Loading payouts" />;
  const updated = (v: PayoutsView) => setView(v);
  return (
    <>
      <Section title="Commission received" description={`Due ${moneyText(p.commissionDue)} · received ${moneyText(p.commissionReceived)}${
        p.receipts.some((r) => !r.reversed) && p.payouts.some((l) => l.status === "AWAITING_COMMISSION") ? " · partly received: payouts wait for the rest" : ""}`}
        actions={bank && <InlineForm label="Record commission received" variant="primary">{(close) => <CommissionReceived dealId={dealId} accounts={accounts} onDone={(v) => { close(); updated(v); }} onCancel={close} />}</InlineForm>}>
        {p.receipts.length === 0 ? <Empty>Nothing received yet.</Empty> : (
          <ul className="divide-y divide-line text-sm">
            {p.receipts.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{moneyText(r.amount)} on {dateText(r.receivedDate)} · {r.reference}{" "}
                  <StatusBadge tone={r.reversed ? "neutral" : r.bankVerified ? "good" : "warning"}>{r.reversed ? "Reversed" : r.bankVerified ? "Matched to the bank" : "Not yet matched to a bank file"}</StatusBadge></span>
                {bank && !r.reversed && <InlineForm label="Reverse" variant="danger">{(close) => <ReasonForm path={`/api/commission-receipts/${r.id}/reverse`} dateField="reversedDate" refOptional submit="Reverse receipt" onDone={(v) => { close(); updated(v); }} onCancel={close} />}</InlineForm>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Payouts" description="Approve, then send the payment in the bank portal, then record it here with the bank's reference.">
        <ul className="divide-y divide-line">
          {p.payouts.map((l) => <PayoutRow key={l.id} line={l} broker={broker} bank={bank} accounts={accounts} onUpdate={updated} />)}
        </ul>
      </Section>
    </>
  );
}

function PayoutRow({ line, broker, bank, accounts, onUpdate }: { line: PayoutLine; broker: boolean; bank: boolean; accounts: Account[]; onUpdate: (v: PayoutsView) => void }) {
  const base = `/api/${line.kind === "AGENT" ? "payouts" : "payables"}/${line.id}`;
  return (
    <li className="py-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span>
          <span className="font-medium">{line.payeeName}</span> <span className="text-ink-3">{labelOf(line.kind)}</span>
          <span className="block">{moneyText(line.remaining)}{line.carriedForward !== "0.00" ? ` (of ${moneyText(line.amount)}; ${moneyText(line.carriedForward)} paid under an earlier CDA)` : ""}</span>
          {line.paymentReference && <span className="block text-xs text-ink-3">Recorded as sent {dateText(line.paidAt)} · {line.paymentReference}{line.paymentConfirmed === false ? " · not yet matched to a verified bank file" : ""}</span>}
          {line.recoveryRequired && <span className="block text-xs text-critical">Overpaid: a recovery is needed</span>}
          {PAYOUT_HELP[line.status] && <span className="block text-xs text-ink-2">{PAYOUT_HELP[line.status]}</span>}
        </span>
        {line.status === "PAID" && line.paymentConfirmed === false
          ? <StatusBadge tone="warning">Sent, not confirmed by the bank</StatusBadge>
          : <StatusBadge tone={PAYOUT_TONE[line.status] ?? "neutral"}>{line.status === "PAID" ? "Paid, confirmed by the bank" : labelOf(line.status)}</StatusBadge>}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {broker && line.status === "READY_FOR_APPROVAL" && <InlineForm label="Approve" variant="primary">{(close) => <Approve path={`${base}/approve`} accounts={accounts} onDone={(v) => { close(); onUpdate(v); }} onCancel={close} />}</InlineForm>}
        {bank && (line.status === "APPROVED" || line.status === "PAYMENT_RETURNED") && <InlineForm label="Record payment sent" variant="primary">{(close) => <Paid path={`${base}/paid`} onDone={(v) => { close(); onUpdate(v); }} onCancel={close} />}</InlineForm>}
        {bank && line.status === "PAID" && <InlineForm label="Payment came back">{(close) => <ReasonForm path={`${base}/payment-reversed`} dateField="date" submit="Record returned payment" onDone={(v) => { close(); onUpdate(v); }} onCancel={close} />}</InlineForm>}
        {broker && !["PAID", "NOTHING_OWED"].includes(line.status) && <InlineForm label="Cancel" variant="danger">{(close) => <ReasonForm path={`${base}/cancel`} submit="Cancel payout" onDone={(v) => { close(); onUpdate(v); }} onCancel={close} />}</InlineForm>}
      </div>
      {line.history.length > 0 && (
        <details className="mt-2 text-xs text-ink-2">
          <summary className="cursor-pointer">History</summary>
          <ul className="mt-1 space-y-0.5">{line.history.map((h, i) => <li key={i}>{dateText(h.eventDate)} · {labelOf(h.kind)}{h.amount ? ` ${moneyText(h.amount)}` : ""}{h.reference ? ` · ${h.reference}` : ""}{h.note ? ` · ${h.note}` : ""} · {h.by}</li>)}</ul>
        </details>
      )}
    </li>
  );
}

function CommissionReceived({ dealId, accounts, onDone, onCancel }: { dealId: string; accounts: Account[]; onDone: (v: PayoutsView) => void; onCancel: () => void }) {
  const act = useAction();
  const [key] = useState(() => newKey());
  const [f, setF] = useState({ amount: "", receivedDate: todayIso(), reference: "", account: accounts[0] ? `${accounts[0].type}:${accounts[0].id}` : "" });
  if (accounts.length === 0) return <Notice kind="warning">No active operating or commission trust account is set up.</Notice>;
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const [type, id] = f.account.split(":");
      const v = await act.run(() => api<PayoutsView>("POST", `/api/deals/${dealId}/closing/commission-received`, { amount: f.amount, receivedDate: f.receivedDate, reference: f.reference, account: { type, id } }, { idempotencyKey: key }));
      if (v) onDone(v);
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <TextField label="Amount" required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} error={act.fields.amount} />
      <TextField label="Received" type="date" required value={f.receivedDate} onChange={(e) => setF({ ...f, receivedDate: e.target.value })} error={act.fields.receivedDate} />
      <TextField label="Reference" required hint="Lawyer's cheque or wire reference" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} />
      <SelectField label="Deposited to" value={f.account} options={accounts.map((a) => ({ value: `${a.type}:${a.id}`, label: a.label }))} onChange={(e) => setF({ ...f, account: e.target.value })} />
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Record</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Approve({ path, accounts, onDone, onCancel }: { path: string; accounts: Account[]; onDone: (v: PayoutsView) => void; onCancel: () => void }) {
  const act = useAction();
  const [key] = useState(() => newKey());
  const [f, setF] = useState({ payFrom: "", note: "", exceptionReason: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const [type, id] = f.payFrom.split(":");
      const v = await act.run(() => api<PayoutsView>("POST", path, {
        ...(f.payFrom ? { payFrom: { type, id } } : {}), ...(f.note.trim() ? { note: f.note } : {}), ...(f.exceptionReason.trim() ? { exceptionReason: f.exceptionReason } : {}),
      }, { idempotencyKey: key }));
      if (v) onDone(v);
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <SelectField label="Pay from" placeholder="The account the commission went into" value={f.payFrom} options={accounts.map((a) => ({ value: `${a.type}:${a.id}`, label: a.label }))} onChange={(e) => setF({ ...f, payFrom: e.target.value })} />
      <TextField label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      <TextField label="Sole-operator exception" hint="Only if you also recorded the commission and the policy allows it" value={f.exceptionReason} onChange={(e) => setF({ ...f, exceptionReason: e.target.value })} error={act.fields.exceptionReason} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Approve</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Paid({ path, onDone, onCancel }: { path: string; onDone: (v: PayoutsView) => void; onCancel: () => void }) {
  const act = useAction();
  const [key] = useState(() => newKey());
  const [f, setF] = useState({ paidDate: todayIso(), reference: "", exceptionReason: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const v = await act.run(() => api<PayoutsView>("POST", path, { paidDate: f.paidDate, reference: f.reference, ...(f.exceptionReason.trim() ? { exceptionReason: f.exceptionReason } : {}) }, { idempotencyKey: key }));
      if (v) onDone(v);
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <p className="text-sm text-ink-2">Send the payment in the bank portal first. This only records it.</p>
      <TextField label="Sent on" type="date" required value={f.paidDate} onChange={(e) => setF({ ...f, paidDate: e.target.value })} error={act.fields.paidDate} />
      <TextField label="Bank reference" required value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} />
      <TextField label="Sole-operator exception" hint="Only if you also approved it" value={f.exceptionReason} onChange={(e) => setF({ ...f, exceptionReason: e.target.value })} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Record payment</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

/** Reason (+ optional date and reference): receipt reversal, returned payment, cancellation. */
function ReasonForm({ path, dateField, refOptional, submit, onDone, onCancel }: { path: string; dateField?: string; refOptional?: boolean; submit: string; onDone: (v: PayoutsView) => void; onCancel: () => void }) {
  const act = useAction();
  const [key] = useState(() => newKey());
  const [f, setF] = useState({ reason: "", date: todayIso(), reference: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const body: Record<string, string> = { reason: f.reason };
      if (dateField) { body[dateField] = f.date; if (f.reference.trim() || !refOptional) body.reference = f.reference; }
      const v = await act.run(() => api<PayoutsView>("POST", path, body, { idempotencyKey: key }));
      if (v) onDone(v);
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <TextArea label="Reason" required rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} error={act.fields.reason} />
      {dateField && <TextField label="Date" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} error={act.fields[dateField]} />}
      {dateField && <TextField label="Reference" required={!refOptional} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} />}
      <div className="flex gap-2"><Button type="submit" variant="danger" busy={act.busy}>{submit}</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
