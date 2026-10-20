/**
 * Trade record sheet (O. Reg. 579/05 s.17): generated from the deal, corrected
 * with initials (earlier entries stay legible), signed by the agent once no
 * conditions remain, then reviewed and signed by the broker of record.
 */

import { useState, type ReactNode } from "react";
import { api, ApiError } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { hasRole, useSession } from "../app/session.tsx";
import { Button, ButtonLink, Loading, Notice, Section, SelectField, StatusBadge, TextArea, TextField } from "../ui/kit.tsx";
import { ConfirmButton, InlineForm } from "../ui/Disclosure.tsx";
import { dateText, dateTimeText, labelOf, moneyText } from "../ui/format.ts";
import type { TabProps } from "./DealWorkspace.tsx";

export interface TrsItem { item: string; label: string; value: unknown; history: { value: unknown; by: string | null; at: string; reason: string; initials: string | null }[] }
export interface TradeRecord {
  id: string; dealId: string; status: "PREPARED" | "SIGNED_BY_AGENT" | "SIGNED_BY_BROKER_OF_RECORD";
  items: TrsItem[]; missing: { item: string; reason: string }[]; differsFromDeal: string[];
  agentSignedBy: string | null; agentSignedAt: string | null; brokerSignedBy: string | null; brokerSignedAt: string | null; retainUntil: string | null;
}

const isMoneyKey = (k: string) => /amount|price|consideration|remuneration/i.test(k);
const KEY_LABEL: Record<string, string> = { mlsNumber: "MLS® number", recoRegistrationNo: "RECO registration no.", taxExtra: "Plus HST", entityType: "Individual or corporation" };
const human = (k: string) => KEY_LABEL[k] ?? labelOf(k.replace(/([A-Z])/g, "_$1"));
const CODE_LABEL: Record<string, string> = {
  OUR_BROKERAGE: "Our brokerage (in trust)", COOP_BROKERAGE: "The other brokerage", BUYER_LAWYER: "Buyer's lawyer", SELLER_LAWYER: "Seller's lawyer",
  LANDLORD_LAWYER: "Landlord's lawyer", TENANT_LAWYER: "Tenant's lawyer", OUR_CLIENT: "Our client",
};
/** Stored codes (COOP_BROKERAGE, INDIVIDUAL) in words; two-letter values such as the province stay as they are */
const codeText = (s: string) => (/^[A-Z]{3,}(_[A-Z]+)*$/.test(s) ? CODE_LABEL[s] ?? labelOf(s) : s);
/** The server numbers the s.17 items ("1. Nature of the trade"); anything else, such as the broker's notes, isn't numbered */
export const itemTitle = (label: string, _n: number) => label;

/** A record value as readable text: strings as-is, objects as "label: value" lines, lists as bullets. */
export function TrsValue({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="text-ink-3">—</span>;
  if (typeof value === "string") return /^-?\d+\.\d{2}$/.test(value) ? moneyText(value) : codeText(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-ink-3">None</span>;
    return <ul className="list-disc space-y-1 pl-5">{value.map((v, i) => <li key={i}><TrsValue value={v} /></li>)}</ul>;
  }
  return (
    <dl className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-ink-3">{human(k)}</dt>
          <dd className="text-ink">{typeof v === "string" && isMoneyKey(k) && /^-?\d+(\.\d+)?$/.test(v) ? moneyText(v) : typeof v === "boolean" ? (v ? "Yes" : "No") : <TrsValue value={v} />}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TradeRecordTab({ deal }: TabProps) {
  const { user } = useSession();
  const trs = useApi<TradeRecord>(`/api/deals/${deal.id}/trade-record`);
  const act = useAction();
  const broker = hasRole(user, ["MANAGING_BROKER"]);
  const onDeal = deal.agents.some((a) => a.userId === user?.id);
  const notPrepared = trs.status === "error" && trs.error instanceof ApiError && trs.error.status === 404;

  if (notPrepared) {
    return (
      <Section title="Trade record sheet">
        <p className="mb-3 text-sm text-ink-2">Not prepared yet. It's generated from the deal and stays available for the rest of the transaction.</p>
        {act.error && <div className="mb-3"><Notice kind="error">{act.error}</Notice></div>}
        <Button variant="primary" busy={act.busy} onClick={async () => { if (await act.run(() => api("POST", `/api/deals/${deal.id}/trade-record`))) trs.reload(); }}>
          Prepare the trade record sheet
        </Button>
      </Section>
    );
  }
  if (trs.status === "error" && !trs.data) return <Notice kind="error">{trs.message}</Notice>;
  if (!trs.data) return <Loading label="Loading the trade record" />;
  const t = trs.data;
  const locked = t.status === "SIGNED_BY_BROKER_OF_RECORD";
  const canCorrect = !locked && (t.status === "PREPARED" ? onDeal || broker : broker);
  const outstanding = act.failure?.code === "COMPLIANCE_OUTSTANDING" ? (act.failure.details?.outstanding as unknown[] | undefined) ?? [] : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatusBadge tone={locked ? "good" : t.status === "SIGNED_BY_AGENT" ? "warning" : "neutral"}>
          {locked ? `Signed by the broker of record ${dateText(t.brokerSignedAt)}` : t.status === "SIGNED_BY_AGENT" ? "Signed by the agent; waiting for the broker of record" : "Prepared; not signed"}
        </StatusBadge>
        <ButtonLink href={`/deals/${deal.id}/trade-record/print`}>Printable copy</ButtonLink>
      </div>
      {t.missing.length > 0 && (
        <Notice kind="warning" title="Items to complete before signing">
          <ul className="list-disc pl-5">{t.missing.map((m) => <li key={m.item}>{human(m.item)}: {m.reason}</li>)}</ul>
        </Notice>
      )}
      {t.differsFromDeal.length > 0 && (
        <Notice kind="warning" title="The deal changed after this was prepared">
          <ul className="list-disc pl-5">{t.differsFromDeal.map((d) => <li key={d}>{d}</li>)}</ul>
          Correct the sheet (with initials) if the change belongs on it.
        </Notice>
      )}
      {act.error && (
        <Notice kind="error" title={outstanding ? "Not ready for the broker's signature" : undefined}>
          {act.error}
          {outstanding && outstanding.length > 0 && <ul className="mt-1 list-disc pl-5">{outstanding.map((o, i) => <li key={i}>{typeof o === "string" ? o : (o as { message?: string; item?: string }).message ?? JSON.stringify(o)}</li>)}</ul>}
        </Notice>
      )}

      <Section title="Record">
        <ol className="divide-y divide-line">
          {t.items.map((it, n) => (
            <li key={it.item} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-sm font-medium text-ink">{itemTitle(it.label, n)}</p>
                {canCorrect && (
                  <InlineForm label="Correct">{(close) => <Correct dealId={deal.id} item={it} onDone={() => { close(); trs.reload(); }} onCancel={close} />}</InlineForm>
                )}
              </div>
              <div className="mt-1 text-sm"><TrsValue value={it.value} /></div>
              {it.history.length > 1 && (
                <details className="mt-2 text-xs text-ink-2">
                  <summary className="cursor-pointer">History ({it.history.length - 1} correction{it.history.length === 2 ? "" : "s"})</summary>
                  <ol className="mt-2 space-y-2 border-l border-line pl-3">
                    {it.history.map((h, i) => (
                      <li key={i}>
                        <span className={i < it.history.length - 1 ? "line-through decoration-ink-3" : ""}><TrsValue value={h.value} /></span>
                        <span className="block text-ink-3">{h.reason} · {h.by ?? "—"}{h.initials ? ` (${h.initials})` : ""} · {dateTimeText(h.at)}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Signatures">
        <div className="space-y-3 text-sm">
          <p>Agent: {t.agentSignedBy ? `${t.agentSignedBy}, ${dateTimeText(t.agentSignedAt)}` : "not signed"}</p>
          <p>Broker of record: {t.brokerSignedBy ? `${t.brokerSignedBy}, ${dateTimeText(t.brokerSignedAt)}` : "not signed"}</p>
          {t.retainUntil && <p className="text-ink-2">Keep until {dateText(t.retainUntil)}.</p>}
          <div className="flex flex-wrap gap-2">
            {t.status === "PREPARED" && onDeal && (
              <ConfirmButton label="Sign as the agent" question="I've reviewed every item, corrected and initialled any changes, and no conditions remain." busy={act.busy}
                onConfirm={() => void act.run(() => api("POST", `/api/deals/${deal.id}/trade-record/sign`, {})).then((r) => r && trs.reload())} />
            )}
            {t.status === "SIGNED_BY_AGENT" && broker && (
              <ConfirmButton label="Sign as broker of record" question="I've reviewed this record and the deal's TRESA and FINTRAC obligations." busy={act.busy}
                onConfirm={() => void act.run(() => api("POST", `/api/deals/${deal.id}/trade-record/broker-sign`, {})).then((r) => r && trs.reload())} />
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}

/** Edits a value field by field when it's text or a flat object; anything deeper as structured text. */
function Correct({ dealId, item, onDone, onCancel }: { dealId: string; item: TrsItem; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const flat = item.value !== null && typeof item.value === "object" && !Array.isArray(item.value)
    && Object.values(item.value as object).every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
  const [text, setText] = useState(typeof item.value === "string" ? item.value : flat ? "" : JSON.stringify(item.value ?? null, null, 2));
  const [obj, setObj] = useState<Record<string, unknown>>(flat ? { ...(item.value as Record<string, unknown>) } : {});
  const [reason, setReason] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      let value: unknown = text;
      if (flat) value = obj;
      else if (typeof item.value !== "string") {
        try { value = JSON.parse(text); setParseError(null); } catch { setParseError("That isn't in the expected format"); return; }
      }
      const ok = await act.run(() => api("POST", `/api/deals/${dealId}/trade-record/corrections`, { item: item.item, value, reason }));
      if (ok) onDone();
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {flat ? Object.entries(obj).map(([k, v]) => typeof v === "boolean"
        ? <SelectField key={k} label={human(k)} value={String(v)} options={[{ value: "true", label: "Yes" }, { value: "false", label: "No" }]} onChange={(e) => setObj({ ...obj, [k]: e.target.value === "true" })} />
        : <TextField key={k} label={human(k)} value={v === null ? "" : String(v)} onChange={(e) => setObj({ ...obj, [k]: e.target.value === "" ? null : e.target.value })} />)
        : <TextArea label="Corrected value" rows={typeof item.value === "string" ? 2 : 8} value={text} onChange={(e) => setText(e.target.value)} error={parseError} />}
      <TextField label="Reason" required hint="Your initials are added automatically" value={reason} onChange={(e) => setReason(e.target.value)} error={act.fields.reason} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Save correction</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
