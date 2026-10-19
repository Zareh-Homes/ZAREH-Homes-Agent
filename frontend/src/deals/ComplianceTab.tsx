/**
 * TRESA and FINTRAC for one deal: what the rules engine says is outstanding,
 * and the records that answer it. Evidence is recorded; nothing is filed.
 */

import { useState } from "react";
import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { Button, Checkbox, Empty, Loading, Notice, Section, SelectField, StatusBadge, TextArea, TextField, type Tone } from "../ui/kit.tsx";
import { InlineForm } from "../ui/Disclosure.tsx";
import { dateText, isLease, labelOf } from "../ui/format.ts";
import { hasRole, useSession } from "../app/session.tsx";
import type { Deal, TabProps } from "./DealWorkspace.tsx";

interface Finding { rule: string; citation: string; severity: "BLOCKING" | "BREACH" | "WARNING"; message: string; partyId?: string; dueBy?: string }
interface Obligations {
  parties: { id: string; role: string; name: string; representation: string }[];
  representation: { mode: string; citation: string; explanation: string };
  tresa: Finding[]; fintrac: Finding[];
  summary: { tresa: { blocking: number; breaches: number; warnings: number }; fintrac: { blocking: number; breaches: number; warnings: number } };
}

const SEVERITY: Record<Finding["severity"], Tone> = { BLOCKING: "critical", BREACH: "serious", WARNING: "warning" };
const iso = (local: string) => (local ? new Date(local).toISOString() : "");

export function ComplianceTab({ deal }: TabProps) {
  const ob = useApi<Obligations>(`/api/deals/${deal.id}/obligations`);
  if (ob.status === "error" && !ob.data) return <Notice kind="error">{ob.message}</Notice>;
  if (!ob.data) return <Loading label="Checking TRESA and FINTRAC" />;
  const o = ob.data;
  const principals = o.parties.filter((p) => ["BUYER", "SELLER", "LANDLORD", "TENANT"].includes(p.role));
  const listing = ["LISTING", "DUAL", "LANDLORD"].includes(deal.side);
  const rep = o.representation;

  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <div className="space-y-5 xl:col-span-2">
        {rep.mode !== "NONE" && (
          <Notice kind={rep.mode === "SEPARATE_DESIGNATED" ? "info" : "warning"} title={REP_TITLE[rep.mode] ?? labelOf(rep.mode)}>
            {rep.explanation} <span className="text-ink-3">({rep.citation})</span>
          </Notice>
        )}
        <Findings title="TRESA" findings={o.tresa} />
        {isLease(deal.side)
          ? <Section title="FINTRAC"><p className="text-sm text-ink-2">FINTRAC's real estate obligations cover purchases and sales, so there's nothing to record for a lease.</p></Section>
          : <Findings title="FINTRAC" findings={o.fintrac} />}
      </div>
      <div className="space-y-5">
        <Section title="Who represents whom" description="Our client, represented by another brokerage, or self-represented.">
          <ul className="space-y-3">
            {principals.map((p) => <Representation key={p.id} dealId={deal.id} party={p} onDone={ob.reload} />)}
          </ul>
        </Section>
        <Section title="Record evidence">
          <div className="space-y-3">
            <InlineForm label="A disclosure or consent">{(close) => <Disclosure dealId={deal.id} parties={o.parties} listing={listing} onDone={() => { close(); ob.reload(); }} onCancel={close} />}</InlineForm>
            <InlineForm label="A representation agreement">{(close) => <Agreement dealId={deal.id} parties={principals} agents={deal.agents} onDone={() => { close(); ob.reload(); }} onCancel={close} />}</InlineForm>
            {!isLease(deal.side) && <InlineForm label="A FINTRAC determination">{(close) => <Determination parties={principals} onDone={() => { close(); ob.reload(); }} onCancel={close} />}</InlineForm>}
            {listing && <InlineForm label="Seller's direction on offers">{(close) => <Direction dealId={deal.id} onDone={() => { close(); ob.reload(); }} onCancel={close} />}</InlineForm>}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Findings({ title, findings }: { title: string; findings: Finding[] }) {
  return (
    <Section title={title} description={findings.length ? `${findings.length} item${findings.length === 1 ? "" : "s"} to deal with. Blocking items stop the broker of record signing the trade record.` : undefined}>
      {findings.length === 0 ? <Empty>Nothing outstanding.</Empty> : (
        <ul className="divide-y divide-line">
          {findings.map((f, i) => (
            <li key={`${f.rule}-${i}`} className="flex flex-wrap items-start justify-between gap-2 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">{f.message}</p>
                <p className="text-xs text-ink-3">{f.citation}{f.dueBy ? ` · due ${dateText(f.dueBy)}` : ""}</p>
              </div>
              <StatusBadge tone={SEVERITY[f.severity]}>{labelOf(f.severity)}</StatusBadge>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Representation({ dealId, party, onDone }: { dealId: string; party: Obligations["parties"][number]; onDone: () => void }) {
  const act = useAction();
  return (
    <li>
      <SelectField label={`${party.name} (${labelOf(party.role).toLowerCase()})`} value={party.representation === "UNKNOWN" ? "" : party.representation}
        placeholder="Not recorded" disabled={act.busy}
        options={[{ value: "OUR_CLIENT", label: "Our client" }, { value: "REPRESENTED_ELSEWHERE", label: "Represented elsewhere" }, { value: "SELF_REPRESENTED", label: "Self-represented" }]}
        onChange={async (e) => { if (e.target.value && await act.run(() => api("POST", `/api/deals/${dealId}/parties/${party.id}/representation`, { representation: e.target.value }))) onDone(); }}
        error={act.error} />
    </li>
  );
}

const REP_TITLE: Record<string, string> = {
  SEPARATE_DESIGNATED: "Separate designated representatives: not multiple representation",
  BROKERAGE: "Multiple representation (brokerage representation)",
  DESIGNATED_SAME: "Multiple representation (same designated representative)",
  MIXED: "Multiple representation (brokerage and designated)",
  UNDETERMINED: "Possible multiple representation: record both representation agreements",
};

/** Kinds given to an offeror (picked by offer) rather than to a party on the deal */
const OFFER_KINDS = new Set(["COMPETING_OFFERS_NUMBER", "COMPETING_OFFERS_CONTENT", "SAME_BROKERAGE_REPRESENTATION", "COMPETING_BUYERS_CONSENT"]);
/** Written consent is confirmed by a managing broker or compliance admin who has seen the signed form */
const CONSENT_KINDS = new Set(["MULTIPLE_REPRESENTATION_CONSENT", "COMPETING_BUYERS_CONSENT"]);
const DISCLOSURES = ["INFORMATION_GUIDE", "SELF_REPRESENTED_PARTY_FORM", "MULTIPLE_REPRESENTATION_DISCLOSURE", "MULTIPLE_REPRESENTATION_CONSENT",
  "COMPETING_OFFERS_NUMBER", "COMPETING_OFFERS_CONTENT", "SAME_BROKERAGE_REPRESENTATION", "COMPETING_BUYERS_CONSENT"];
const KIND_LABEL: Record<string, string> = {
  SAME_BROKERAGE_REPRESENTATION: "Disclosure to another buyer: we act for seller and a buyer",
  COMPETING_BUYERS_CONSENT: "Competing buyers we represent: buyer's written consent",
  MULTIPLE_REPRESENTATION_CONSENT: "Multiple representation: client's written consent",
  MULTIPLE_REPRESENTATION_DISCLOSURE: "Multiple representation: written disclosure",
};

function Disclosure({ dealId, parties, listing, onDone, onCancel }: { dealId: string; parties: Obligations["parties"]; listing: boolean; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const { user } = useSession();
  const reviewer = hasRole(user, ["MANAGING_BROKER", "COMPLIANCE_ADMIN"]);
  const offers = useApi<{ offers: { id: string; receivedAt: string; offerorBrokerage: string | null; offerorSelfRepresented: boolean; fromOurBrokerage: boolean }[] }>(
    listing ? `/api/deals/${dealId}/offers` : null);
  const kinds = DISCLOSURES.filter((k) => (reviewer || !CONSENT_KINDS.has(k)) && (listing || !OFFER_KINDS.has(k)));
  const [f, setF] = useState({ kind: "INFORMATION_GUIDE", partyId: "", offerId: "", deliveredAt: "", method: "", explainedAt: "", acknowledgedAt: "", formVersion: "", numberDisclosed: "", content: "" });
  const opt = (v: string) => (v ? v : undefined);
  const toOffer = OFFER_KINDS.has(f.kind);
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/deals/${dealId}/disclosures`, {
        kind: f.kind, ...(toOffer ? { offerId: opt(f.offerId) } : { partyId: opt(f.partyId) }), deliveredAt: iso(f.deliveredAt), method: f.method,
        explainedAt: f.explainedAt ? iso(f.explainedAt) : undefined, acknowledgedAt: f.acknowledgedAt ? iso(f.acknowledgedAt) : undefined,
        formVersion: opt(f.formVersion), numberDisclosed: f.numberDisclosed ? Number(f.numberDisclosed) : undefined, content: opt(f.content),
      }));
      if (ok) onDone();
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <SelectField label="What" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={kinds.map((k) => ({ value: k, label: KIND_LABEL[k] ?? labelOf(k) }))}
        hint={reviewer ? undefined : "Written consent to multiple representation is recorded by the broker or compliance after they see the signed form."} />
      {toOffer
        ? <SelectField label="Offer" value={f.offerId} placeholder="Choose…" onChange={(e) => setF({ ...f, offerId: e.target.value })}
            options={(offers.data?.offers ?? []).map((o, i) => ({ value: o.id, label: `Offer ${i + 1}: ${o.offerorSelfRepresented ? "self-represented buyer" : o.offerorBrokerage}${o.fromOurBrokerage ? " (our client)" : ""}` }))} />
        : <SelectField label="To" value={f.partyId} placeholder="Choose…" onChange={(e) => setF({ ...f, partyId: e.target.value })} options={parties.map((p) => ({ value: p.id, label: `${p.name} (${labelOf(p.role).toLowerCase()})` }))} />}
      <TextField label="Delivered" type="datetime-local" required value={f.deliveredAt} onChange={(e) => setF({ ...f, deliveredAt: e.target.value })} error={act.fields.deliveredAt} />
      <TextField label="How" required hint="e.g. emailed PDF, signed copy returned" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} error={act.fields.method} />
      <TextField label="Explained" type="datetime-local" value={f.explainedAt} onChange={(e) => setF({ ...f, explainedAt: e.target.value })} />
      <TextField label={CONSENT_KINDS.has(f.kind) ? "Consent signed" : "Acknowledged / consented"} type="datetime-local" required={CONSENT_KINDS.has(f.kind)}
        value={f.acknowledgedAt} onChange={(e) => setF({ ...f, acknowledgedAt: e.target.value })} error={act.fields.acknowledgedAt} />
      {f.kind === "INFORMATION_GUIDE" || f.kind === "SAME_BROKERAGE_REPRESENTATION" ? (
        <SelectField label="Form version" value={f.formVersion} placeholder="—" onChange={(e) => setF({ ...f, formVersion: e.target.value })}
          options={[{ value: "BROKERAGE_REPRESENTATION", label: "Brokerage representation" }, { value: "DESIGNATED_REPRESENTATION", label: "Designated representation" }]} />
      ) : null}
      {f.kind === "COMPETING_OFFERS_NUMBER" && <TextField label="Number of offers disclosed" inputMode="numeric" value={f.numberDisclosed} onChange={(e) => setF({ ...f, numberDisclosed: e.target.value })} />}
      {f.kind === "COMPETING_OFFERS_CONTENT" && <TextArea label="What was disclosed" value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />}
      {f.kind === "COMPETING_BUYERS_CONSENT" && <TextArea label="What you confirmed" required hint="e.g. signed consent to multiple representation, or separate designated representatives"
        value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} />}
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Record</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Agreement({ dealId, parties, agents, onDone, onCancel }: { dealId: string; parties: Obligations["parties"]; agents: Deal["agents"]; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ partyId: parties[0]?.id ?? "", type: "BROKERAGE", signedAt: "", effectiveFrom: "", expiresOn: "", remunerationTerms: "", services: "", terminationTerms: "" });
  const [reps, setReps] = useState<string[]>([]);
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/deals/${dealId}/representation-agreements`, {
        ...f, signedAt: iso(f.signedAt), ...(f.type === "DESIGNATED" ? { designatedRepresentativeIds: reps } : {}) }));
      if (ok) onDone();
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <SelectField label="Client" value={f.partyId} onChange={(e) => setF({ ...f, partyId: e.target.value })} options={parties.map((p) => ({ value: p.id, label: p.name }))} />
      <SelectField label="Type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}
        options={[{ value: "BROKERAGE", label: "Brokerage representation" }, { value: "DESIGNATED", label: "Designated representation" }]}
        hint="As the signed agreement says. Separate designated representatives for seller and buyer aren't multiple representation." />
      {f.type === "DESIGNATED" && (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium text-ink">Designated representatives (named in the agreement)</legend>
          {act.fields.designatedRepresentativeIds && <p className="text-xs font-medium text-critical">{act.fields.designatedRepresentativeIds}</p>}
          {agents.map((a) => (
            <Checkbox key={a.userId} label={a.name} checked={reps.includes(a.userId)}
              onChange={(e) => setReps((xs) => (e.target.checked ? [...xs, a.userId] : xs.filter((x) => x !== a.userId)))} />
          ))}
        </fieldset>
      )}
      <TextField label="Signed" type="datetime-local" required value={f.signedAt} onChange={(e) => setF({ ...f, signedAt: e.target.value })} error={act.fields.signedAt} />
      <TextField label="Effective from" type="date" required value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} error={act.fields.effectiveFrom} />
      <TextField label="Expires" type="date" required value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} error={act.fields.expiresOn} />
      <TextArea label="Remuneration terms" required value={f.remunerationTerms} onChange={(e) => setF({ ...f, remunerationTerms: e.target.value })} error={act.fields.remunerationTerms} />
      <TextArea label="Services" required value={f.services} onChange={(e) => setF({ ...f, services: e.target.value })} error={act.fields.services} />
      <TextArea label="Termination terms" required value={f.terminationTerms} onChange={(e) => setF({ ...f, terminationTerms: e.target.value })} error={act.fields.terminationTerms} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Record</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Determination({ parties, onDone, onCancel }: { parties: Obligations["parties"]; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ partyId: parties[0]?.id ?? "", kind: "PEP_HIO", result: "NONE", riskRating: "LOW", details: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/parties/${f.partyId}/fintrac-determinations`, { kind: f.kind, result: f.result, riskRating: f.riskRating || undefined, details: f.details }));
      if (ok) onDone();
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <SelectField label="Client" value={f.partyId} onChange={(e) => setF({ ...f, partyId: e.target.value })} options={parties.map((p) => ({ value: p.id, label: p.name }))} />
      <SelectField label="Determination" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, result: e.target.value === "PEP_HIO" ? "NONE" : "" })}
        options={["PEP_HIO", "BUSINESS_RELATIONSHIP", "BENEFICIAL_OWNERSHIP_CONFIRMED", "ENTITY_EXISTENCE_CONFIRMED"].map((k) => ({ value: k, label: labelOf(k) }))} />
      {f.kind === "PEP_HIO" ? (
        <SelectField label="Result" value={f.result} onChange={(e) => setF({ ...f, result: e.target.value, riskRating: e.target.value === "FOREIGN_PEP" ? "HIGH" : f.riskRating })}
          options={["NONE", "FOREIGN_PEP", "DOMESTIC_PEP", "HIO", "FAMILY_OR_CLOSE_ASSOCIATE"].map((k) => ({ value: k, label: labelOf(k) }))} />
      ) : <TextField label="Result" required value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })} error={act.fields.result} />}
      <SelectField label="Risk rating" value={f.riskRating} onChange={(e) => setF({ ...f, riskRating: e.target.value })} placeholder="—"
        options={["LOW", "MEDIUM", "HIGH"].map((k) => ({ value: k, label: labelOf(k) }))} />
      <TextArea label="How it was determined" required value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} error={act.fields.details} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Record</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Direction({ dealId, onDone, onCancel }: { dealId: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ givenAt: "", shareContent: "false", scope: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/deals/${dealId}/offer-directions`, {
        givenAt: iso(f.givenAt), shareContent: f.shareContent === "true", ...(f.shareContent === "true" ? { scope: f.scope } : {}),
      }));
      if (ok) onDone();
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <TextField label="Given (in writing)" type="datetime-local" required value={f.givenAt} onChange={(e) => setF({ ...f, givenAt: e.target.value })} error={act.fields.givenAt} />
      <SelectField label="Offer content" value={f.shareContent} onChange={(e) => setF({ ...f, shareContent: e.target.value })}
        options={[{ value: "false", label: "Don't share the content of competing offers" }, { value: "true", label: "Share the content of competing offers" }]} />
      {f.shareContent === "true" && <TextArea label="What may be shared" required value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })} error={act.fields.scope} />}
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>Record</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
