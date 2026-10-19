/**
 * FINTRAC receipt of funds record for one deposit: who paid it and from
 * where. The payer's details are stored encrypted on the server.
 */

import { useState } from "react";
import { api } from "../app/api.ts";
import { useAction } from "../app/useApi.ts";
import { Button, Notice, SelectField, TextField } from "../ui/kit.tsx";

const PAYER_TYPES = [
  { value: "PERSON", label: "A person" },
  { value: "ENTITY", label: "A corporation or other entity" },
  { value: "FINANCIAL_ENTITY", label: "A bank or other financial entity" },
  { value: "PUBLIC_BODY", label: "A public body" },
];

export function ReceiptOfFunds({ entryId, onDone, onCancel }: { entryId: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ payerType: "PERSON", payerName: "", sourceAccount: "", onBehalfOf: "", cashAmount: "", exemptReason: "" });
  const [p, setP] = useState({ address: "", dateOfBirth: "", occupation: "", telephone: "", incorporationNumber: "", jurisdiction: "", principalBusiness: "" });
  const exempt = f.payerType === "FINANCIAL_ENTITY" || f.payerType === "PUBLIC_BODY";
  const opt = (v: string) => (v.trim() ? v.trim() : undefined);
  const payerDetails = f.payerType === "PERSON"
    ? { address: p.address, dateOfBirth: p.dateOfBirth, occupation: p.occupation, telephone: opt(p.telephone) }
    : { address: p.address, incorporationNumber: opt(p.incorporationNumber), jurisdiction: p.jurisdiction, principalBusiness: p.principalBusiness };
  const fe = (k: string) => act.fields[`payerDetails.${k}`];
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const ok = await act.run(() => api("POST", `/api/trust/entries/${entryId}/receipt-of-funds`, {
        payerType: f.payerType, payerName: f.payerName, ...(exempt ? { exemptReason: f.exemptReason } : { payerDetails }),
        sourceAccount: opt(f.sourceAccount), onBehalfOf: opt(f.onBehalfOf), cashAmount: opt(f.cashAmount),
      }));
      if (ok) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Paid by" value={f.payerType} options={PAYER_TYPES} onChange={(e) => setF({ ...f, payerType: e.target.value })} />
      <TextField label="Payer's name" required value={f.payerName} onChange={(e) => setF({ ...f, payerName: e.target.value })} error={act.fields.payerName} />
      {exempt ? (
        <div className="sm:col-span-2"><TextField label="Why no further details are needed" required value={f.exemptReason} onChange={(e) => setF({ ...f, exemptReason: e.target.value })} error={act.fields.exemptReason} /></div>
      ) : (
        <>
          <div className="sm:col-span-2"><TextField label="Address" required value={p.address} onChange={(e) => setP({ ...p, address: e.target.value })} error={fe("address")} /></div>
          {f.payerType === "PERSON" ? (
            <>
              <TextField label="Date of birth" type="date" required value={p.dateOfBirth} onChange={(e) => setP({ ...p, dateOfBirth: e.target.value })} error={fe("dateOfBirth")} />
              <TextField label="Occupation" required value={p.occupation} onChange={(e) => setP({ ...p, occupation: e.target.value })} error={fe("occupation")} />
              <TextField label="Telephone" type="tel" value={p.telephone} onChange={(e) => setP({ ...p, telephone: e.target.value })} error={fe("telephone")} />
            </>
          ) : (
            <>
              <TextField label="Incorporation number" value={p.incorporationNumber} onChange={(e) => setP({ ...p, incorporationNumber: e.target.value })} error={fe("incorporationNumber")} />
              <TextField label="Jurisdiction" required value={p.jurisdiction} onChange={(e) => setP({ ...p, jurisdiction: e.target.value })} error={fe("jurisdiction")} />
              <TextField label="Principal business" required value={p.principalBusiness} onChange={(e) => setP({ ...p, principalBusiness: e.target.value })} error={fe("principalBusiness")} />
            </>
          )}
        </>
      )}
      <TextField label="Account the funds came from" value={f.sourceAccount} onChange={(e) => setF({ ...f, sourceAccount: e.target.value })} error={act.fields.sourceAccount} />
      <TextField label="Paid on behalf of" value={f.onBehalfOf} onChange={(e) => setF({ ...f, onBehalfOf: e.target.value })} error={act.fields.onBehalfOf} />
      <TextField label="Cash portion" inputMode="decimal" hint="Leave blank if none" value={f.cashAmount} onChange={(e) => setF({ ...f, cashAmount: e.target.value })} error={act.fields.cashAmount} />
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Save record</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
