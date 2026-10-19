/**
 * The deal's trust ledger: every receipt, payment and reversal with the
 * running balance the server computes. Entries are never edited; a mistake is
 * corrected with a reversal. Recording an entry here records what already
 * happened at the bank; nothing in the app moves money.
 */

import { useState } from "react";
import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { hasRole, useSession } from "../app/session.tsx";
import { Button, Empty, Facts, Loading, Notice, Section, SelectField, StatusBadge, Table, TextArea, TextField } from "../ui/kit.tsx";
import { InlineForm } from "../ui/Disclosure.tsx";
import { dateText, dateTimeText, isLease, labelOf, moneyText, todayIso } from "../ui/format.ts";
import type { TabProps } from "../deals/DealWorkspace.tsx";
import { ReceiptOfFunds } from "./ReceiptOfFunds.tsx";

interface LedgerEntry {
  id: string; trustAccountId: string; entryType: string; direction: 1 | -1; amount: string; method: string; referenceNo: string | null;
  receiptNumber: number | null; counterparty: string; receivedDate: string | null; effectiveDate: string; authorizationMethod: string | null;
  memo: string | null; reversesEntryId: string | null; createdAt: string; runningBalance: string;
}
interface Hold { id: string; reason: string; note: string; flaggedAt: string; releasedAt: string | null; releaseNote: string | null; active: boolean }
interface DealLedger {
  deal: { id: string; dealNumber: string; status: string; trustDepositHolder: string; depositStatus: string };
  balances: { trustAccountId: string; balance: string }[]; entries: LedgerEntry[]; holds: Hold[]; activeHold: Hold | null;
}
interface TrustAccount { id: string; name: string; kind: string; bankName: string; accountLast4: string; isActive: boolean }

export function DealTrustTab({ deal, reloadDeal }: TabProps) {
  const { user } = useSession();
  const broker = hasRole(user, ["MANAGING_BROKER"]);
  const staff = hasRole(user, ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"]);
  const ledger = useApi<DealLedger>(`/api/deals/${deal.id}/trust`);
  const accounts = useApi<{ accounts: TrustAccount[] }>(broker ? "/api/trust/accounts" : null);
  const [warnings, setWarnings] = useState<string[]>([]);
  if (ledger.status === "error" && !ledger.data) return <Notice kind="error">{ledger.message}</Notice>;
  if (!ledger.data) return <Loading label="Loading the trust ledger" />;
  const l = ledger.data;
  const reversed = new Set(l.entries.filter((e) => e.reversesEntryId).map((e) => e.reversesEntryId));
  const active = (accounts.data?.accounts ?? []).filter((a) => a.isActive && a.kind === "REAL_ESTATE_TRUST");
  const done = (w: string[] = []) => { setWarnings(w); ledger.reload(); reloadDeal(); };
  const holdsMoney = l.balances.some((b) => !/^-?0+(\.0+)?$/.test(b.balance));

  return (
    <div className="space-y-5">
      {l.activeHold && (
        <Notice kind="warning" title={`On hold: ${labelOf(l.activeHold.reason).toLowerCase()}`}>
          {l.activeHold.note} (since {dateText(l.activeHold.flaggedAt)}). Nothing can be paid out of trust on this deal until a broker releases it.
        </Notice>
      )}
      {warnings.length > 0 && (
        <Notice kind="warning" title="Recorded, with warnings">
          <ul className="list-disc pl-5">{warnings.map((w) => <li key={w}>{WARNING_TEXT[w] ?? labelOf(w)}</li>)}</ul>
        </Notice>
      )}
      <Section title="Deposit">
        <Facts items={[
          ["Held by", labelOf(deal.trustDepositHolder)],
          ["Status", <StatusBadge tone={l.deal.depositStatus === "RECEIVED" ? "good" : "neutral"}>{labelOf(l.deal.depositStatus)}</StatusBadge>],
          ["Expected", moneyText(deal.depositAmount)],
          ["Due", dateText(deal.depositDueDate)],
          ...l.balances.map((b): [string, string] => ["Held in trust", moneyText(b.balance)]),
        ]} />
        {deal.trustDepositHolder !== "OUR_BROKERAGE" && <p className="mt-3 text-sm text-ink-2">Someone else holds this deposit ({labelOf(deal.trustDepositHolder).toLowerCase()}), so nothing is recorded in our trust account.</p>}
      </Section>

      {broker && deal.trustDepositHolder === "OUR_BROKERAGE" && (
        <div className="flex flex-wrap gap-2">
          <InlineForm label="Record a deposit received" variant="primary">{(close) => <Deposit dealId={deal.id} accounts={active} onDone={(w) => { close(); done(w); }} onCancel={close} />}</InlineForm>
          {holdsMoney && <InlineForm label="Record a payment out">{(close) => <Disbursement dealId={deal.id} lease={isLease(deal.side)} accounts={active} onDone={() => { close(); done(); }} onCancel={close} />}</InlineForm>}
        </div>
      )}

      <Section title="Ledger" description="Entries can't be changed or deleted. A mistake is corrected with a reversal that stays on the record.">
        {l.entries.length === 0 ? <Empty>Nothing recorded in trust for this deal.</Empty> : (
          <Table head={["Date", "Entry", "In / out", "Balance", ""]}>
            {l.entries.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="px-3 py-2 whitespace-nowrap">{dateText(e.effectiveDate)}{e.receivedDate && e.receivedDate !== e.effectiveDate && <span className="block text-xs text-ink-3">Received {dateText(e.receivedDate)}</span>}</td>
                <td className="px-3 py-2">
                  <span className="font-medium">{labelOf(e.entryType)}</span>{e.receiptNumber ? ` · receipt #${e.receiptNumber}` : ""}
                  <span className="block text-xs text-ink-2">{e.counterparty} · {labelOf(e.method)}{e.referenceNo ? ` · ${e.referenceNo}` : ""}</span>
                  {e.authorizationMethod && <span className="block text-xs text-ink-3">Authority: {labelOf(e.authorizationMethod)}</span>}
                  {e.memo && <span className="block text-xs text-ink-3">{e.memo}</span>}
                  {reversed.has(e.id) && <StatusBadge tone="neutral">Reversed</StatusBadge>}
                </td>
                <td className={`px-3 py-2 whitespace-nowrap tabular-nums ${e.direction < 0 ? "text-critical" : ""}`}>{e.direction < 0 ? "−" : "+"}{moneyText(e.amount)}</td>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums">{moneyText(e.runningBalance)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-col items-start gap-2">
                    {e.entryType === "DEPOSIT_RECEIVED" && !reversed.has(e.id) && (
                      <InlineForm label="Receipt of funds record">{(close) => <ReceiptOfFunds entryId={e.id} onDone={() => { close(); ledger.reload(); }} onCancel={close} />}</InlineForm>
                    )}
                    {broker && e.entryType !== "REVERSAL" && !reversed.has(e.id) && (
                      <InlineForm label="Reverse" variant="danger">{(close) => <Reversal entryId={e.id} onDone={() => { close(); done(); }} onCancel={close} />}</InlineForm>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>

      {staff && (
        <Section title="Holds" description="A disputed or unclaimed deposit stays in trust until a broker releases the hold.">
          {l.holds.length === 0 ? <Empty>No holds.</Empty> : (
            <ul className="divide-y divide-line text-sm">
              {l.holds.map((h) => (
                <li key={h.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <span>
                    <StatusBadge tone={h.active ? "warning" : "neutral"}>{labelOf(h.reason)}{h.active ? "" : " · released"}</StatusBadge>
                    <span className="block">{h.note}</span>
                    <span className="block text-xs text-ink-3">Flagged {dateTimeText(h.flaggedAt)}{h.releasedAt ? ` · released ${dateTimeText(h.releasedAt)}: ${h.releaseNote}` : ""}</span>
                  </span>
                  {h.active && broker && <InlineForm label="Release">{(close) => <ReleaseHold holdId={h.id} onDone={() => { close(); done(); }} onCancel={close} />}</InlineForm>}
                </li>
              ))}
            </ul>
          )}
          {!l.activeHold && <div className="mt-3"><InlineForm label="Put on hold">{(close) => <NewHold dealId={deal.id} deposits={l.entries.filter((e) => e.entryType === "DEPOSIT_RECEIVED")} onDone={() => { close(); done(); }} onCancel={close} />}</InlineForm></div>}
        </Section>
      )}
    </div>
  );
}

const WARNING_TEXT: Record<string, string> = {
  DEPOSITED_AFTER_5_BUSINESS_DAYS: "Deposited more than 5 business days after it was received (O. Reg. 567/05 s.17). Note the reason in the deal file.",
  EXCEEDS_EXPECTED_DEPOSIT: "More than the deposit in the agreement. Check the amount.",
  FINTRAC_LARGE_TRANSACTION_REPORT_OPENED: "Cash of $10,000 or more: a FINTRAC large cash transaction report was opened for preparation. Nothing is filed automatically.",
};

const accountOptions = (accounts: TrustAccount[]) => accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.bankName} ••${a.accountLast4})` }));

function Deposit({ dealId, accounts, onDone, onCancel }: { dealId: string; accounts: TrustAccount[]; onDone: (w: string[]) => void; onCancel: () => void }) {
  const act = useAction();
  const [key] = useState(() => crypto.randomUUID());
  const [f, setF] = useState({ trustAccountId: accounts[0]?.id ?? "", amount: "", method: "BANK_DRAFT", dateReceived: todayIso(), dateDeposited: todayIso(), payorName: "", bankReference: "", memo: "" });
  if (accounts.length === 0) return <Notice kind="warning">No active trust account. A managing broker adds it under Trust → Accounts.</Notice>;
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const r = await act.run(() => api<{ warnings: string[] }>("POST", "/api/trust/deposits", { dealId, ...f, memo: f.memo.trim() || undefined }, { idempotencyKey: key }));
      if (r) onDone(r.warnings);
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Trust account" value={f.trustAccountId} options={accountOptions(accounts)} onChange={(e) => setF({ ...f, trustAccountId: e.target.value })} />
      <TextField label="Amount" required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} error={act.fields.amount} />
      <SelectField label="Method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}
        options={["BANK_DRAFT", "WIRE", "CERTIFIED_CHEQUE", "CASH", "VIRTUAL_CURRENCY"].map((m) => ({ value: m, label: labelOf(m) }))} />
      <TextField label="Payor" required value={f.payorName} onChange={(e) => setF({ ...f, payorName: e.target.value })} error={act.fields.payorName} />
      <TextField label="Received" type="date" required value={f.dateReceived} onChange={(e) => setF({ ...f, dateReceived: e.target.value })} error={act.fields.dateReceived} />
      <TextField label="Deposited at the bank" type="date" required value={f.dateDeposited} onChange={(e) => setF({ ...f, dateDeposited: e.target.value })} error={act.fields.dateDeposited} />
      <TextField label="Bank reference" required hint="Draft / wire / deposit slip number" value={f.bankReference} onChange={(e) => setF({ ...f, bankReference: e.target.value })} error={act.fields.bankReference} />
      <TextField label="Memo" value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Record deposit</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Disbursement({ dealId, lease, accounts, onDone, onCancel }: { dealId: string; lease: boolean; accounts: TrustAccount[]; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [key] = useState(() => crypto.randomUUID());
  const [f, setF] = useState({ trustAccountId: accounts[0]?.id ?? "", amount: "", method: "EFT", dateDisbursed: todayIso(), payeeType: "OUR_BROKERAGE", payeeName: "", authorizationMethod: "CLOSING_COMPLETED", authorizationReference: "", referenceNo: "", memo: "" });
  const payees = ["OUR_BROKERAGE", "COOP_BROKERAGE", "LAWYER", ...(lease ? ["LANDLORD"] : []), "PAYOR_REFUND"];
  const auths = f.payeeType === "PAYOR_REFUND" ? ["MUTUAL_RELEASE", "COURT_ORDER"] : ["CLOSING_COMPLETED", "MUTUAL_RELEASE", "COURT_ORDER"];
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const body = { dealId, ...f, authorizationReference: f.authorizationReference.trim() || undefined, referenceNo: f.referenceNo.trim() || undefined, memo: f.memo.trim() || undefined };
      if (await act.run(() => api("POST", "/api/trust/disbursements", body, { idempotencyKey: key }))) onDone();
    }}>
      <p className="text-sm text-ink-2 sm:col-span-2">Records a payment already made from the trust account. Usually the CDA posts these when it's finalized.</p>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Trust account" value={f.trustAccountId} options={accountOptions(accounts)} onChange={(e) => setF({ ...f, trustAccountId: e.target.value })} />
      <TextField label="Amount" required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} error={act.fields.amount} />
      <SelectField label="Paid to" value={f.payeeType} options={payees.map((p) => ({ value: p, label: labelOf(p) }))}
        onChange={(e) => setF({ ...f, payeeType: e.target.value, authorizationMethod: e.target.value === "PAYOR_REFUND" ? "MUTUAL_RELEASE" : f.authorizationMethod })} />
      <TextField label="Payee name" required value={f.payeeName} onChange={(e) => setF({ ...f, payeeName: e.target.value })} error={act.fields.payeeName} />
      <SelectField label="Authority" value={f.authorizationMethod} options={auths.map((a) => ({ value: a, label: labelOf(a) }))} onChange={(e) => setF({ ...f, authorizationMethod: e.target.value })} error={act.fields.authorizationMethod} />
      {f.authorizationMethod !== "CLOSING_COMPLETED" && <TextField label="Release / order reference" required value={f.authorizationReference} onChange={(e) => setF({ ...f, authorizationReference: e.target.value })} error={act.fields.authorizationReference} />}
      <SelectField label="Method" value={f.method} options={["CHEQUE", "EFT", "WIRE", "BANK_DRAFT"].map((m) => ({ value: m, label: labelOf(m) }))} onChange={(e) => setF({ ...f, method: e.target.value })} />
      <TextField label="Paid on" type="date" required value={f.dateDisbursed} onChange={(e) => setF({ ...f, dateDisbursed: e.target.value })} error={act.fields.dateDisbursed} />
      <TextField label="Cheque / payment reference" value={f.referenceNo} onChange={(e) => setF({ ...f, referenceNo: e.target.value })} />
      <TextField label="Memo" value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Record payment</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Reversal({ entryId, onDone, onCancel }: { entryId: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [key] = useState(() => crypto.randomUUID());
  const [f, setF] = useState({ reason: "", effectiveDate: todayIso() });
  return (
    <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api("POST", `/api/trust/entries/${entryId}/reversals`, f, { idempotencyKey: key }))) onDone(); }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <TextArea label="Why it's being reversed" required rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} error={act.fields.reason} />
      <TextField label="Effective" type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} error={act.fields.effectiveDate} />
      <div className="flex gap-2"><Button type="submit" variant="danger" busy={act.busy}>Post reversal</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function NewHold({ dealId, deposits, onDone, onCancel }: { dealId: string; deposits: LedgerEntry[]; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ reason: "DISPUTED", note: "", depositEntryId: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api("POST", `/api/deals/${dealId}/trust/holds`, { ...f, depositEntryId: f.depositEntryId || undefined }))) onDone(); }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <SelectField label="Reason" value={f.reason} options={[{ value: "DISPUTED", label: "Disputed" }, { value: "UNCLAIMED", label: "Unclaimed" }]} onChange={(e) => setF({ ...f, reason: e.target.value })} />
      {deposits.length > 0 && <SelectField label="Deposit" placeholder="The whole deal" value={f.depositEntryId} onChange={(e) => setF({ ...f, depositEntryId: e.target.value })}
        options={deposits.map((d) => ({ value: d.id, label: `${moneyText(d.amount)} from ${d.counterparty}, ${dateText(d.effectiveDate)}` }))} />}
      <TextArea label="Note" required rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} error={act.fields.note} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Put on hold</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function ReleaseHold({ holdId, onDone, onCancel }: { holdId: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [note, setNote] = useState("");
  return (
    <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api("POST", `/api/trust/holds/${holdId}/release`, { releaseNote: note }))) onDone(); }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <TextArea label="Why it's released" required rows={2} hint="e.g. signed mutual release dated…" value={note} onChange={(e) => setNote(e.target.value)} error={act.fields.releaseNote} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Release hold</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

