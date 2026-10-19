/**
 * Opening a deal. The server checks everything (clients for the side, one
 * primary agent, dates, commission rules) and says which field is wrong.
 */

import { useState, type FormEvent } from "react";
import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { useSession } from "../app/session.tsx";
import { navigate } from "../app/router.tsx";
import { Button, Notice, Page, PageHeader, Section, SelectField, TextField } from "../ui/kit.tsx";
import { isLease, SIDE_LABEL } from "../ui/format.ts";

interface Person { id: string; firstName: string; lastName: string; role: string }
interface AgentRow { userId: string; role: "PRIMARY" | "CO_AGENT" | "REFERRAL"; splitPct: string }
interface PartyRow { role: string; entityType: "INDIVIDUAL" | "CORPORATION"; fullName: string; email: string; phone: string; representation: string }

const PARTY_ROLES: Record<string, { value: string; label: string }[]> = {
  sale: [
    { value: "SELLER", label: "Seller" }, { value: "BUYER", label: "Buyer" }, { value: "SELLER_LAWYER", label: "Seller's lawyer" },
    { value: "BUYER_LAWYER", label: "Buyer's lawyer" }, { value: "COOP_BROKERAGE", label: "Other brokerage" },
  ],
  lease: [
    { value: "LANDLORD", label: "Landlord" }, { value: "TENANT", label: "Tenant" }, { value: "COOP_BROKERAGE", label: "Other brokerage" },
  ],
};
const CLIENT_ROLE: Record<string, string> = { LISTING: "SELLER", BUYER: "BUYER", DUAL: "BUYER", LANDLORD: "LANDLORD", TENANT: "TENANT" };
const HOLDERS = [
  { value: "OUR_BROKERAGE", label: "Our brokerage (in trust)" }, { value: "COOP_BROKERAGE", label: "The other brokerage" },
  { value: "LAWYER", label: "A lawyer in trust" }, { value: "BUILDER", label: "Builder / trustee" },
];

const blankParty = (role: string): PartyRow => ({ role, entityType: "INDIVIDUAL", fullName: "", email: "", phone: "", representation: "" });

export function NewDeal() {
  const { user } = useSession();
  const people = useApi<{ users: Person[] }>("/api/users");
  const action = useAction();
  const [side, setSide] = useState("LISTING");
  const [f, setF] = useState({
    streetAddress: "", unit: "", city: "", mlsNumber: "", salePrice: "", offerDate: "", conditionsDueDate: "", closeDate: "",
    depositAmount: "", depositDueDate: "", trustDepositHolder: "OUR_BROKERAGE", totalGci: "", coopBrokerageName: "", coopCommission: "",
    outsideReferralPayee: "", outsideReferralPct: "", status: "CONDITIONAL",
  });
  const [agents, setAgents] = useState<AgentRow[]>(() => [{ userId: user?.role === "AGENT" ? user.id : "", role: "PRIMARY", splitPct: "" }]);
  const [parties, setParties] = useState<PartyRow[]>([blankParty("SELLER")]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const lease = isLease(side);
  const listingSide = side === "LISTING" || side === "LANDLORD";
  const err = action.fields;
  const agentOptions = (people.data?.users ?? []).filter((p) => p.role === "AGENT" || p.role === "MANAGING_BROKER")
    .map((p) => ({ value: p.id, label: `${p.firstName} ${p.lastName}` }));

  const changeSide = (next: string) => {
    setSide(next);
    const kind = isLease(next) ? "lease" : "sale";
    setParties((ps) => {
      const kept = ps.filter((p) => PARTY_ROLES[kind]!.some((r) => r.value === p.role));
      return kept.length ? kept : [blankParty(CLIENT_ROLE[next]!)];
    });
    if (!(next === "LISTING" || next === "LANDLORD")) setF((x) => ({ ...x, coopCommission: "" }));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const opt = (v: string) => (v.trim() ? v.trim() : undefined);
    const body = {
      side, status: f.status, streetAddress: f.streetAddress.trim(), unit: opt(f.unit), city: f.city.trim(), mlsNumber: opt(f.mlsNumber),
      salePrice: f.salePrice.trim(), offerDate: f.offerDate, conditionsDueDate: opt(f.conditionsDueDate), closeDate: f.closeDate,
      depositAmount: f.depositAmount.trim() || "0", depositDueDate: opt(f.depositDueDate), trustDepositHolder: f.trustDepositHolder,
      totalGci: f.totalGci.trim(), coopBrokerageName: opt(f.coopBrokerageName), coopCommission: listingSide ? opt(f.coopCommission) : undefined,
      outsideReferralPayee: opt(f.outsideReferralPayee), outsideReferralPct: f.outsideReferralPct.trim() ? Number(f.outsideReferralPct) : undefined,
      agents: agents.map((a) => ({ userId: a.userId, role: a.role, splitPct: Number(a.splitPct) })),
      parties: parties.map((p) => ({
        role: p.role, entityType: p.entityType, fullName: p.fullName.trim(), email: opt(p.email), phone: opt(p.phone),
        representation: p.representation || undefined,
      })),
    };
    const res = await action.run(() => api<{ deal: { id: string } }>("POST", "/api/deals", body));
    if (res) navigate(`/deals/${res.deal.id}`);
  };

  return (
    <Page>
      <PageHeader title="New deal" eyebrow="Deals">
        Documents, FINTRAC records (sales) and TRESA checks are set up from what you enter here.
      </PageHeader>
      <form onSubmit={submit} className="space-y-5" noValidate>
        {action.error && <Notice kind="error" title="The deal wasn't opened">{action.error}</Notice>}

        <Section title="Transaction">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <SelectField label="Our side" required value={side} onChange={(e) => changeSide(e.target.value)} error={err.side}
              options={Object.entries(SIDE_LABEL).map(([value, label]) => ({ value, label }))} />
            <SelectField label="Status" value={f.status} onChange={set("status")} error={err.status}
              options={[{ value: "CONDITIONAL", label: "Conditional" }, { value: "FIRM", label: "Firm" }]} />
            <TextField label="MLS® number" value={f.mlsNumber} onChange={set("mlsNumber")} error={err.mlsNumber} />
            <TextField label="Street address" required value={f.streetAddress} onChange={set("streetAddress")} error={err.streetAddress} />
            <TextField label="Unit" value={f.unit} onChange={set("unit")} error={err.unit} />
            <TextField label="City" required value={f.city} onChange={set("city")} error={err.city} />
            <TextField label={lease ? "Monthly rent" : "Sale price"} required inputMode="decimal" value={f.salePrice} onChange={set("salePrice")} error={err.salePrice} />
          </div>
        </Section>

        <Section title="Dates and deposit">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <TextField label={lease ? "Agreement date" : "Offer date"} type="date" required value={f.offerDate} onChange={set("offerDate")} error={err.offerDate} />
            <TextField label="Conditions due" type="date" value={f.conditionsDueDate} onChange={set("conditionsDueDate")} error={err.conditionsDueDate} />
            <TextField label={lease ? "Lease commencement" : "Closing date"} type="date" required value={f.closeDate} onChange={set("closeDate")} error={err.closeDate} />
            <TextField label={lease ? "Deposit (e.g. first and last month's rent)" : "Deposit"} required inputMode="decimal" value={f.depositAmount} onChange={set("depositAmount")} error={err.depositAmount} />
            <TextField label="Deposit due" type="date" value={f.depositDueDate} onChange={set("depositDueDate")} error={err.depositDueDate} />
            <SelectField label="Who holds the deposit" required value={f.trustDepositHolder} onChange={set("trustDepositHolder")} options={HOLDERS} error={err.trustDepositHolder} />
          </div>
        </Section>

        <Section title="Commission" description="Before tax. The CDA works out tax, splits and fees from these and each agent's approved plan.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <TextField label="Our commission" required inputMode="decimal" value={f.totalGci} onChange={set("totalGci")} error={err.totalGci}
              hint={lease ? "e.g. one month's rent" : undefined} />
            <TextField label="Other brokerage" value={f.coopBrokerageName} onChange={set("coopBrokerageName")} error={err.coopBrokerageName} />
            {listingSide && (
              <TextField label={lease ? "Tenant's brokerage commission" : "Co-op commission"} inputMode="decimal" value={f.coopCommission}
                onChange={set("coopCommission")} error={err.coopCommission} hint="Paid from what we collect" />
            )}
            <TextField label="Outside referral to" value={f.outsideReferralPayee} onChange={set("outsideReferralPayee")} error={err.outsideReferralPayee} />
            <TextField label="Referral %" inputMode="decimal" value={f.outsideReferralPct} onChange={set("outsideReferralPct")} error={err.outsideReferralPct} />
          </div>
        </Section>

        <Section title="Agents" description="One primary agent. The split is the agent's share of their part of our commission.">
          {err.agents && <p className="mb-3 text-xs font-medium text-critical">{err.agents}</p>}
          <div className="space-y-3">
            {agents.map((a, i) => (
              <fieldset key={i} className="grid items-end gap-3 rounded-lg border border-line p-3 sm:grid-cols-[1fr_10rem_8rem_auto]">
                <legend className="sr-only">Agent {i + 1}</legend>
                <SelectField label="Agent" required value={a.userId} placeholder="Choose…" options={agentOptions} error={err[`agents[${i}].userId`]}
                  onChange={(e) => setAgents((xs) => xs.map((x, j) => (j === i ? { ...x, userId: e.target.value } : x)))} />
                <SelectField label="Role" value={a.role}
                  options={[{ value: "PRIMARY", label: "Primary" }, { value: "CO_AGENT", label: "Co-agent" }, { value: "REFERRAL", label: "Referral" }]}
                  onChange={(e) => setAgents((xs) => xs.map((x, j) => (j === i ? { ...x, role: e.target.value as AgentRow["role"] } : x)))} />
                <TextField label="Split %" inputMode="decimal" required value={a.splitPct} error={err[`agents[${i}].splitPct`]}
                  onChange={(e) => setAgents((xs) => xs.map((x, j) => (j === i ? { ...x, splitPct: e.target.value } : x)))} />
                <Button variant="ghost" disabled={agents.length === 1} onClick={() => setAgents((xs) => xs.filter((_, j) => j !== i))}>Remove</Button>
              </fieldset>
            ))}
          </div>
          {agents.length < 4 && (
            <Button className="mt-3" onClick={() => setAgents((xs) => [...xs, { userId: "", role: "CO_AGENT", splitPct: "" }])}>Add an agent</Button>
          )}
        </Section>

        <Section title="People on the deal" description={`At least one ${lease ? "landlord or tenant" : "buyer or seller"} who is our client. Lawyers and the other brokerage can be added later.`}>
          {err.parties && <p className="mb-3 text-xs font-medium text-critical">{err.parties}</p>}
          <div className="space-y-3">
            {parties.map((p, i) => {
              const update = (patch: Partial<PartyRow>) => setParties((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <fieldset key={i} className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-2 lg:grid-cols-3">
                  <legend className="sr-only">Person {i + 1}</legend>
                  <SelectField label="Role" value={p.role} options={PARTY_ROLES[lease ? "lease" : "sale"]!} onChange={(e) => update({ role: e.target.value })} />
                  <TextField label="Full legal name" required value={p.fullName} onChange={(e) => update({ fullName: e.target.value })} error={err[`parties[${i}].fullName`]} />
                  <SelectField label="Individual or corporation" value={p.entityType}
                    options={[{ value: "INDIVIDUAL", label: "Individual" }, { value: "CORPORATION", label: "Corporation" }]}
                    onChange={(e) => update({ entityType: e.target.value as PartyRow["entityType"] })} />
                  <TextField label="Email" type="email" value={p.email} onChange={(e) => update({ email: e.target.value })} error={err[`parties[${i}].email`]} />
                  <TextField label="Phone" type="tel" value={p.phone} onChange={(e) => update({ phone: e.target.value })} />
                  <div className="flex items-end justify-between gap-2">
                    <SelectField label="Representation" value={p.representation} placeholder="Not recorded yet"
                      options={[{ value: "OUR_CLIENT", label: "Our client" }, { value: "REPRESENTED_ELSEWHERE", label: "Represented elsewhere" }, { value: "SELF_REPRESENTED", label: "Self-represented" }]}
                      onChange={(e) => update({ representation: e.target.value })} />
                    <Button variant="ghost" disabled={parties.length === 1} onClick={() => setParties((xs) => xs.filter((_, j) => j !== i))}>Remove</Button>
                  </div>
                </fieldset>
              );
            })}
          </div>
          <Button className="mt-3" onClick={() => setParties((xs) => [...xs, blankParty(lease ? "TENANT" : "BUYER")])}>Add a person</Button>
        </Section>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" busy={action.busy}>Open the deal</Button>
          <Button onClick={() => navigate("/deals")}>Cancel</Button>
        </div>
      </form>
    </Page>
  );
}
