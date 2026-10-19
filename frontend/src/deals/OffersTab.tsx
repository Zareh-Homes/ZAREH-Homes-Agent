/**
 * Offers on a listing (TRESA s.22.7 / s.22.0.3): every offer received is kept
 * with its outcome; accepting one is refused until the other offerors have had
 * the disclosures they're owed.
 */

import { useState } from "react";
import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { Button, Checkbox, Empty, Loading, Notice, Section, SelectField, StatusBadge, Table, TextField, type Tone } from "../ui/kit.tsx";
import { InlineForm } from "../ui/Disclosure.tsx";
import { dateText, dateTimeText, isLease, labelOf, moneyText } from "../ui/format.ts";
import type { TabProps } from "./DealWorkspace.tsx";

interface Offer {
  id: string; receivedAt: string; written: boolean; offerorBrokerage: string | null; offerorSelfRepresented: boolean; price: string | null;
  status: string; documentFileId: string | null; keepUntil: string; history: { status: string; eventAt: string; note: string | null }[];
}

const OFFER_TONE: Record<string, Tone> = { RECEIVED: "neutral", SIGNED_BACK: "warning", ACCEPTED: "good", REJECTED: "neutral", EXPIRED: "neutral", WITHDRAWN: "neutral" };
const FINAL = new Set(["ACCEPTED", "REJECTED", "EXPIRED", "WITHDRAWN"]);

export function OffersTab({ deal }: TabProps) {
  const res = useApi<{ offers: Offer[] }>(`/api/deals/${deal.id}/offers`);
  const lease = isLease(deal.side);
  if (res.status === "error" && !res.data) return <Notice kind="error">{res.message}</Notice>;
  if (!res.data) return <Loading label="Loading offers" />;
  const offers = res.data.offers;
  return (
    <Section title={`Offers (${offers.length})`} description="Record every offer as it comes in, written or not. Records are kept a year, or six years for the accepted one."
      actions={<InlineForm label="Record an offer" variant="primary">{(close) => <NewOffer dealId={deal.id} lease={lease} onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm>}>
      {offers.length === 0 ? <Empty>No offers recorded yet.</Empty> : (
        <Table head={["Received", "From", lease ? "Rent" : "Price", "Status", ""]}>
          {offers.map((o) => (
            <tr key={o.id} className="align-top">
              <td className="px-3 py-2 whitespace-nowrap">{dateTimeText(o.receivedAt)}{!o.written && <span className="block text-xs text-ink-3">Verbal</span>}</td>
              <td className="px-3 py-2">{o.offerorSelfRepresented ? "Self-represented buyer" : o.offerorBrokerage}</td>
              <td className="px-3 py-2 whitespace-nowrap">{o.price ? moneyText(o.price) : "—"}</td>
              <td className="px-3 py-2">
                <StatusBadge tone={OFFER_TONE[o.status] ?? "neutral"}>{labelOf(o.status)}</StatusBadge>
                {o.history.length > 0 && (
                  <ul className="mt-1 text-xs text-ink-3">
                    {o.history.map((h, i) => <li key={i}>{labelOf(h.status)} {dateTimeText(h.eventAt)}{h.note ? `: ${h.note}` : ""}</li>)}
                  </ul>
                )}
                <span className="block text-xs text-ink-3">Keep until {dateText(o.keepUntil)}</span>
              </td>
              <td className="px-3 py-2">
                {!FINAL.has(o.status) && <InlineForm label="Update">{(close) => <OfferEvent offerId={o.id} onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm>}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function NewOffer({ dealId, lease, onDone, onCancel }: { dealId: string; lease: boolean; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ receivedAt: "", written: true, selfRep: false, brokerage: "", price: "" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/deals/${dealId}/offers`, {
        receivedAt: f.receivedAt ? new Date(f.receivedAt).toISOString() : "", written: f.written,
        offerorSelfRepresented: f.selfRep, ...(f.selfRep ? {} : { offerorBrokerage: f.brokerage }), ...(f.price.trim() ? { price: f.price.trim() } : {}),
      }));
      if (ok) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <TextField label="Received" type="datetime-local" required value={f.receivedAt} onChange={(e) => setF({ ...f, receivedAt: e.target.value })} error={act.fields.receivedAt} />
      <TextField label={lease ? "Monthly rent offered" : "Price offered"} inputMode="decimal" hint="Optional" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} error={act.fields.price} />
      <Checkbox label="Written offer" checked={f.written} onChange={(e) => setF({ ...f, written: e.target.checked })} />
      <Checkbox label={lease ? "Tenant is self-represented" : "Buyer is self-represented"} checked={f.selfRep} onChange={(e) => setF({ ...f, selfRep: e.target.checked })} />
      {!f.selfRep && <TextField label="Offeror's brokerage" required value={f.brokerage} onChange={(e) => setF({ ...f, brokerage: e.target.value })} error={act.fields.offerorBrokerage} />}
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Record offer</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function OfferEvent({ offerId, onDone, onCancel }: { offerId: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ status: "SIGNED_BACK", eventAt: "", note: "" });
  const outstanding = act.failure?.code === "OFFER_DISCLOSURES_OUTSTANDING" ? (act.failure.details?.outstanding as string[] | undefined) ?? [] : [];
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/offers/${offerId}/events`, {
        status: f.status, ...(f.eventAt ? { eventAt: new Date(f.eventAt).toISOString() } : {}), ...(f.note.trim() ? { note: f.note } : {}),
      }));
      if (ok) onDone();
    }}>
      {act.error && (
        <Notice kind="error">{act.error}{outstanding.length > 0 && <ul className="mt-1 list-disc pl-5">{outstanding.map((o) => <li key={o}>{o}</li>)}</ul>}</Notice>
      )}
      <SelectField label="What happened" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}
        options={["SIGNED_BACK", "ACCEPTED", "REJECTED", "EXPIRED", "WITHDRAWN"].map((s) => ({ value: s, label: labelOf(s) }))} />
      <TextField label="When" type="datetime-local" hint="Default: now" value={f.eventAt} onChange={(e) => setF({ ...f, eventAt: e.target.value })} error={act.fields.eventAt} />
      <TextField label="Note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Save</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
