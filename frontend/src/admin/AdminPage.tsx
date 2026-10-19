/**
 * Brokerage set-up: people and invitations, the broker of record and
 * financial policies, accounts, commission plans, and the business calendar.
 * Buttons follow each route's role; the server checks every one again and its
 * answer is shown as given.
 */

import { useState } from "react";
import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { hasRole, useSession, type Role } from "../app/session.tsx";
import { Button, Checkbox, Empty, Loading, Notice, Page, PageHeader, Section, SelectField, StatusBadge, TabLinks, Table, TextArea, TextField } from "../ui/kit.tsx";
import { ConfirmButton, InlineForm } from "../ui/Disclosure.tsx";
import { dateText, dateTimeText, labelOf, moneyText, ROLE_LABEL, todayIso } from "../ui/format.ts";

const ROLES: Role[] = ["AGENT", "MANAGING_BROKER", "COMPLIANCE_ADMIN", "ADMIN"];
const roleOptions = ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] ?? labelOf(r) }));

interface User {
  id: string; email: string; firstName: string; lastName: string; role: Role; phone: string | null; isActive: boolean;
  recoRegistrationNo: string | null; isPrec: boolean; precLegalName: string | null; hstNumber: string | null;
  passwordSet: boolean; mfaEnabled: boolean; locked: boolean; createdAt: string;
}

export function AdminPage({ tab }: { tab: string }) {
  const current = ["people", "governance", "plans", "calendar"].includes(tab) ? tab : "people";
  return (
    <Page>
      <PageHeader title="Admin" />
      <TabLinks label="Admin sections" current={current} tabs={[
        { key: "people", label: "People", href: "/admin" },
        { key: "governance", label: "Broker of record & accounts", href: "/admin/governance" },
        { key: "plans", label: "Commission plans", href: "/admin/plans" },
        { key: "calendar", label: "Business calendar", href: "/admin/calendar" },
      ]} />
      {current === "people" && <People />}
      {current === "governance" && <Governance />}
      {current === "plans" && <Plans />}
      {current === "calendar" && <Calendar />}
    </Page>
  );
}

/** A one-time link shown once, with copy */
function OneTimeLink({ title, url, minutes, onClose }: { title: string; url: string; minutes: number; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Notice kind="success" title={title}>
      <p>This link is shown once and works for {minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`}. Send it through a channel you trust.</p>
      <p className="mt-2 break-all rounded bg-sunken px-2 py-1 font-mono text-xs text-ink" data-testid="one-time-link">{url}</p>
      <div className="mt-2 flex gap-2">
        <Button onClick={() => { void navigator.clipboard?.writeText(url).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy link"}</Button>
        <Button variant="ghost" onClick={onClose}>Done</Button>
      </div>
    </Notice>
  );
}

// ── People ───────────────────────────────────────────────────────────────────

function People() {
  const { user: me } = useSession();
  const admin = hasRole(me, ["ADMIN"]);
  const [inactive, setInactive] = useState(false);
  const res = useApi<{ users: User[] }>(`/api/users${inactive ? "?includeInactive=true" : ""}`);
  const act = useAction();
  const [link, setLink] = useState<{ title: string; url: string; minutes: number } | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const userAction = async (path: string, done: string) => {
    setOk(null);
    if (await act.run(() => api("POST", path, {}))) { setOk(done); res.reload(); }
  };
  return (
    <div className="space-y-5">
      {link && <OneTimeLink {...link} onClose={() => setLink(null)} />}
      {ok && <Notice kind="success">{ok}</Notice>}
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <Section title="People"
        actions={<div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setInactive(!inactive)}>{inactive ? "Hide suspended" : "Show suspended"}</Button>
          {admin && <InlineForm label="Invite someone" variant="primary">{(close) => <Invite onDone={(token, minutes) => {
            close(); res.reload();
            setLink({ title: "Invitation created", url: `${location.origin}/accept-invite#token=${encodeURIComponent(token)}`, minutes });
          }} onCancel={close} />}</InlineForm>}
        </div>}>
        {res.status === "error" && !res.data ? <Notice kind="error">{res.message}</Notice> : !res.data ? <Loading /> : res.data.users.length === 0 ? <Empty>No people.</Empty> : (
          <ul className="divide-y divide-line">
            {res.data.users.map((u) => {
              const self = u.id === me?.id;
              return (
                <li key={u.id} className="py-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="font-medium text-ink">{u.firstName} {u.lastName}</span>{self ? " (you)" : ""} · {ROLE_LABEL[u.role] ?? u.role}
                      <span className="block text-ink-2">{u.email}{u.phone ? ` · ${u.phone}` : ""}</span>
                      <span className="block text-xs text-ink-3">
                        {u.recoRegistrationNo ? `RECO #${u.recoRegistrationNo}` : "No RECO number on file"}
                        {u.isPrec ? ` · PREC: ${u.precLegalName ?? "name missing"}` : ""}{u.hstNumber ? ` · HST ${u.hstNumber}` : ""}
                      </span>
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {!u.isActive && <StatusBadge tone="neutral">Suspended</StatusBadge>}
                      {!u.passwordSet && <StatusBadge tone="warning">Invitation not accepted</StatusBadge>}
                      {u.passwordSet && !u.mfaEnabled && <StatusBadge tone="warning">No two-factor</StatusBadge>}
                      {u.locked && <StatusBadge tone="critical">Locked</StatusBadge>}
                    </span>
                  </div>
                  {admin && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <InlineForm label="Edit">{(close) => <EditProfile user={u} self={self} onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm>
                      {!self && (
                        <>
                          <Button busy={act.busy} onClick={async () => {
                            setOk(null);
                            const r = await act.run(() => api<{ resetToken: string; expiresInMinutes: number }>("POST", `/api/users/${u.id}/password-reset`, {}));
                            if (r) setLink({ title: `Password reset link for ${u.firstName}`, url: `${location.origin}/reset-password#token=${encodeURIComponent(r.resetToken)}`, minutes: r.expiresInMinutes });
                          }}>Password reset link</Button>
                          {u.mfaEnabled && <ConfirmButton label="Reset two-factor" variant="secondary" busy={act.busy}
                            question={`${u.firstName} will set up two-factor again at next sign-in, and is signed out everywhere.`}
                            onConfirm={() => void userAction(`/api/users/${u.id}/mfa-reset`, `Two-factor reset for ${u.firstName}.`)} />}
                          {u.isActive
                            ? <ConfirmButton label="Suspend" variant="danger" busy={act.busy} question={`${u.firstName} is signed out and can't sign in until reactivated.`}
                                onConfirm={() => void userAction(`/api/users/${u.id}/suspend`, `${u.firstName} suspended.`)} />
                            : <Button busy={act.busy} onClick={() => void userAction(`/api/users/${u.id}/reactivate`, `${u.firstName} reactivated.`)}>Reactivate</Button>}
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Invite({ onDone, onCancel }: { onDone: (token: string, minutes: number) => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ email: "", firstName: "", lastName: "", role: "AGENT", phone: "" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const r = await act.run(() => api<{ invitationToken: string; expiresInMinutes: number }>("POST", "/api/users", { ...f, phone: f.phone.trim() || undefined }));
      if (r) onDone(r.invitationToken, r.expiresInMinutes);
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <TextField label="First name" required value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} error={act.fields.firstName} />
      <TextField label="Last name" required value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} error={act.fields.lastName} />
      <TextField label="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={act.fields.email} />
      <TextField label="Phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} error={act.fields.phone} />
      <SelectField label="Role" value={f.role} options={roleOptions} onChange={(e) => setF({ ...f, role: e.target.value })} error={act.fields.role} />
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Create invitation</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function EditProfile({ user, self, onDone, onCancel }: { user: User; self: boolean; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({
    firstName: user.firstName, lastName: user.lastName, phone: user.phone ?? "", role: user.role, recoRegistrationNo: user.recoRegistrationNo ?? "",
    isPrec: user.isPrec, precLegalName: user.precLegalName ?? "", hstNumber: user.hstNumber ?? "",
  });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const body: Record<string, unknown> = {
        firstName: f.firstName, lastName: f.lastName, phone: f.phone.trim() || null, recoRegistrationNo: f.recoRegistrationNo.trim() || null,
        isPrec: f.isPrec, precLegalName: f.isPrec ? f.precLegalName : null, hstNumber: f.hstNumber.trim() || null,
      };
      if (!self && f.role !== user.role) body.role = f.role;
      if (await act.run(() => api("POST", `/api/users/${user.id}/profile`, body))) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <TextField label="First name" required value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} error={act.fields.firstName} />
      <TextField label="Last name" required value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} error={act.fields.lastName} />
      <TextField label="Phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} error={act.fields.phone} />
      <SelectField label="Role" value={f.role} options={roleOptions} disabled={self} hint={self ? "Another admin changes your role" : "A role change signs them out"}
        onChange={(e) => setF({ ...f, role: e.target.value as Role })} error={act.fields.role} />
      <TextField label="RECO registration number" value={f.recoRegistrationNo} onChange={(e) => setF({ ...f, recoRegistrationNo: e.target.value })} error={act.fields.recoRegistrationNo} />
      <TextField label="HST number" value={f.hstNumber} onChange={(e) => setF({ ...f, hstNumber: e.target.value })} error={act.fields.hstNumber} />
      <Checkbox label="Paid through a PREC" checked={f.isPrec} onChange={(e) => setF({ ...f, isPrec: e.target.checked })} />
      {f.isPrec && <TextField label="PREC legal name" required value={f.precLegalName} onChange={(e) => setF({ ...f, precLegalName: e.target.value })} error={act.fields.precLegalName} />}
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Save</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

// ── Governance: broker of record, policies, accounts ─────────────────────────

interface Designation { id: string; userId: string; name: string; role: string; effectiveFrom: string; effectiveTo: string | null; activeToday: boolean; reference: string; recordedBy: string }
interface Policy { policy: string; description: string; enabled: boolean; history: { enabled: boolean; reference: string; note: string | null; decidedBy: string; decidedAt: string }[] }
interface TrustAccount { id: string; name: string; kind: string; bankName: string; accountLast4: string; isActive: boolean; balance: string }
interface OperatingAccount { id: string; name: string; bankName: string; accountLast4: string; isActive: boolean }

function Governance() {
  const { user } = useSession();
  const bank = hasRole(user, ["ADMIN", "MANAGING_BROKER"]);
  const broker = hasRole(user, ["MANAGING_BROKER"]);
  return (
    <div className="space-y-5">
      <BrokerOfRecord canRecord={bank} />
      <Policies canDecide={broker} />
      <TrustAccounts canCreate={broker} />
      {bank && <OperatingAccounts />}
    </div>
  );
}

function BrokerOfRecord({ canRecord }: { canRecord: boolean }) {
  const res = useApi<{ designations: Designation[] }>("/api/broker-of-record");
  const act = useAction();
  return (
    <Section title="Broker of record" description="Who holds the role, and who substitutes. The person recording it can't be the person designated."
      actions={canRecord && <InlineForm label="Record a designation">{(close) => <NewDesignation onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm>}>
      {act.error && <div className="mb-3"><Notice kind="error">{act.error}</Notice></div>}
      {res.status === "error" && !res.data ? <Notice kind="error">{res.message}</Notice> : !res.data ? <Loading /> : res.data.designations.length === 0 ? (
        <Notice kind="warning">No broker of record is on file. Trust approvals and reconciliation sign-off need one.</Notice>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {res.data.designations.map((d) => (
            <li key={d.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="font-medium text-ink">{d.name}</span> · {labelOf(d.role)} {d.activeToday && <StatusBadge tone="good">In effect</StatusBadge>}
                <span className="block text-ink-2">{dateText(d.effectiveFrom)} – {d.effectiveTo ? dateText(d.effectiveTo) : "ongoing"} · {d.reference}</span>
                <span className="block text-xs text-ink-3">Recorded by {d.recordedBy}</span>
              </span>
              {canRecord && !d.effectiveTo && <InlineForm label="End">{(close) => <EndDesignation id={d.id} onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function NewDesignation({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const users = useApi<{ users: User[] }>("/api/users?role=MANAGING_BROKER");
  const [f, setF] = useState({ userId: "", role: "BROKER_OF_RECORD", effectiveFrom: todayIso(), effectiveTo: "", reference: "" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      if (await act.run(() => api("POST", "/api/broker-of-record", { ...f, effectiveTo: f.effectiveTo || undefined }))) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <SelectField label="Broker" required placeholder="Choose" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} error={act.fields.userId}
        options={(users.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.firstName} ${u.lastName}` }))} />
      <SelectField label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}
        options={[{ value: "BROKER_OF_RECORD", label: "Broker of record" }, { value: "DESIGNATED_SUBSTITUTE", label: "Designated substitute" }]} />
      <TextField label="From" type="date" required value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} error={act.fields.effectiveFrom} />
      <TextField label="To" type="date" hint="Leave blank if ongoing" value={f.effectiveTo} onChange={(e) => setF({ ...f, effectiveTo: e.target.value })} error={act.fields.effectiveTo} />
      <div className="sm:col-span-2"><TextField label="Reference" required hint="e.g. RECO designation notice, date" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} /></div>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Record</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function EndDesignation({ id, onDone, onCancel }: { id: string; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [effectiveTo, setTo] = useState(todayIso());
  return (
    <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api("POST", `/api/broker-of-record/${id}/end`, { effectiveTo }))) onDone(); }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <TextField label="Last day" type="date" required value={effectiveTo} onChange={(e) => setTo(e.target.value)} error={act.fields.effectiveTo} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>End designation</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function Policies({ canDecide }: { canDecide: boolean }) {
  const res = useApi<{ policies: Policy[] }>("/api/financial-policies");
  return (
    <Section title="Financial policies" description="Off until the broker of record decides, with the counsel or accountant sign-off as the reference.">
      {res.status === "error" && !res.data ? <Notice kind="error">{res.message}</Notice> : !res.data ? <Loading /> : (
        <ul className="divide-y divide-line text-sm">
          {res.data.policies.map((p) => (
            <li key={p.policy} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{labelOf(p.policy)}</span>
                  <span className="block text-ink-2">{p.description}</span>
                  {p.history[0] && <span className="block text-xs text-ink-3">Last decided by {p.history[0].decidedBy} {dateTimeText(p.history[0].decidedAt)} · {p.history[0].reference}</span>}
                </span>
                <StatusBadge tone={p.enabled ? "good" : "neutral"}>{p.enabled ? "On" : "Off"}</StatusBadge>
              </div>
              {canDecide && <div className="mt-2"><InlineForm label={p.enabled ? "Turn off" : "Turn on"}>{(close) => <DecidePolicy policy={p} onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm></div>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function DecidePolicy({ policy, onDone, onCancel }: { policy: Policy; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ reference: "", note: "" });
  return (
    <form className="space-y-3" onSubmit={async (e) => {
      e.preventDefault();
      if (await act.run(() => api("POST", "/api/financial-policies", { policy: policy.policy, enabled: !policy.enabled, reference: f.reference, note: f.note.trim() || undefined }))) onDone();
    }}>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      <TextField label="Sign-off reference" required hint="Counsel or accountant advice, with date" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} />
      <TextArea label="Note" rows={2} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} error={act.fields.note} />
      <div className="flex gap-2"><Button type="submit" variant="primary" busy={act.busy}>{policy.enabled ? "Turn off" : "Turn on"}</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

function TrustAccounts({ canCreate }: { canCreate: boolean }) {
  const res = useApi<{ accounts: TrustAccount[] }>("/api/trust/accounts");
  return (
    <Section title="Trust accounts" description="Balances are the ledger's. Check the account details match the bank and the RECO registration."
      actions={canCreate && <InlineForm label="Add a trust account">{(close) => <NewAccount kind="trust" onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm>}>
      {res.status === "error" && !res.data ? <Notice kind="error">{res.message}</Notice> : !res.data ? <Loading /> : res.data.accounts.length === 0 ? <Empty>No trust accounts yet.</Empty> : (
        <Table head={["Account", "Kind", "Bank", "Ledger balance", ""]}>
          {res.data.accounts.map((a) => (
            <tr key={a.id}>
              <td className="px-3 py-2">{a.name}</td>
              <td className="px-3 py-2">{labelOf(a.kind)}</td>
              <td className="px-3 py-2 whitespace-nowrap">{a.bankName} ••{a.accountLast4}</td>
              <td className="px-3 py-2 whitespace-nowrap tabular-nums">{moneyText(a.balance)}</td>
              <td className="px-3 py-2">{!a.isActive && <StatusBadge tone="neutral">Inactive</StatusBadge>}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function OperatingAccounts() {
  const res = useApi<{ accounts: OperatingAccount[] }>("/api/operating-accounts");
  return (
    <Section title="Operating accounts" description="Where commission is received and payouts are paid from."
      actions={<InlineForm label="Add an operating account">{(close) => <NewAccount kind="operating" onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm>}>
      {res.status === "error" && !res.data ? <Notice kind="error">{res.message}</Notice> : !res.data ? <Loading /> : res.data.accounts.length === 0 ? <Empty>No operating accounts yet.</Empty> : (
        <ul className="divide-y divide-line text-sm">
          {res.data.accounts.map((a) => (
            <li key={a.id} className="py-2">{a.name} · {a.bankName} ••{a.accountLast4} {!a.isActive && <StatusBadge tone="neutral">Inactive</StatusBadge>}</li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function NewAccount({ kind, onDone, onCancel }: { kind: "trust" | "operating"; onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ name: "", bankName: "", accountLast4: "", kind: "REAL_ESTATE_TRUST" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const body = kind === "trust" ? f : { name: f.name, bankName: f.bankName, accountLast4: f.accountLast4 };
      if (await act.run(() => api("POST", kind === "trust" ? "/api/trust/accounts" : "/api/operating-accounts", body))) onDone();
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <TextField label="Account name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={act.fields.name} />
      <TextField label="Bank" required value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} error={act.fields.bankName} />
      <TextField label="Last 4 digits" required inputMode="numeric" maxLength={4} value={f.accountLast4} onChange={(e) => setF({ ...f, accountLast4: e.target.value })} error={act.fields.accountLast4} />
      {kind === "trust" && <SelectField label="Kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}
        options={[{ value: "REAL_ESTATE_TRUST", label: "Real estate trust" }, { value: "COMMISSION_TRUST", label: "Commission trust" }]} />}
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Add account</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

// ── Commission plans ─────────────────────────────────────────────────────────

interface PlanList {
  userId: string; inForceToday: string | null;
  versions: { id: string; effectiveFrom: string; splitBps: number | null; annualCap: string | null; capYearStart: { month: number; day: number };
    fees: { name: string; amount: string }[]; reason: string; source: string; status: string; proposedBy: string; approvedBy: string | null; approvedAt: string | null }[];
}

function Plans() {
  const { user } = useSession();
  const bank = hasRole(user, ["ADMIN", "MANAGING_BROKER"]);
  const broker = hasRole(user, ["MANAGING_BROKER"]);
  const agents = useApi<{ users: User[] }>("/api/users?role=AGENT");
  const [agentId, setAgentId] = useState("");
  const plans = useApi<PlanList>(agentId ? `/api/agents/${agentId}/commission-plans` : null);
  const [view, setView] = useState<PlanList | null>(null);
  const act = useAction();
  const p = view && view.userId === agentId ? view : plans.data;
  return (
    <div className="space-y-5">
      <Section title="Agent">
        {agents.status === "error" && !agents.data ? <Notice kind="error">{agents.message}</Notice> : (
          <SelectField label="Agent" placeholder="Choose an agent" value={agentId} onChange={(e) => { setAgentId(e.target.value); setView(null); act.clear(); }}
            options={(agents.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.firstName} ${u.lastName}` }))} />
        )}
      </Section>
      {agentId && (
        <Section title="Plan versions" description="A new version takes effect once a managing broker other than the proposer approves it."
          actions={bank && <InlineForm label="Propose a new version" variant="primary">{(close) => <NewPlan userId={agentId} onDone={(v) => { close(); setView(v); }} onCancel={close} />}</InlineForm>}>
          {act.error && <div className="mb-3"><Notice kind="error">{act.error}</Notice></div>}
          {plans.status === "error" && !p ? <Notice kind="error">{plans.message}</Notice> : !p ? <Loading /> : p.versions.length === 0 ? <Empty>No plan on file.</Empty> : (
            <ul className="divide-y divide-line text-sm">
              {p.versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                  <span className="min-w-0">
                    <span className="font-medium text-ink">From {dateText(v.effectiveFrom)}</span>{" "}
                    {p.inForceToday === v.id && <StatusBadge tone="good">In force</StatusBadge>}{" "}
                    <StatusBadge tone={v.status === "PROPOSED" ? "warning" : "neutral"}>{labelOf(v.status)}</StatusBadge>
                    <span className="block text-ink-2">
                      {v.splitBps !== null ? `${v.splitBps / 100}% split` : "No split set"} · {v.annualCap ? `cap ${moneyText(v.annualCap)}` : "no cap"} · cap year from {v.capYearStart.month}/{v.capYearStart.day}
                    </span>
                    {v.fees.length > 0 && <span className="block text-ink-2">Fees: {v.fees.map((f) => `${f.name} ${moneyText(f.amount)}`).join(", ")}</span>}
                    <span className="block text-xs text-ink-3">{v.reason} · proposed by {v.proposedBy}{v.approvedBy ? ` · approved by ${v.approvedBy} ${dateTimeText(v.approvedAt)}` : ""}</span>
                  </span>
                  {broker && v.status === "PROPOSED" && (
                    <Button variant="primary" busy={act.busy} onClick={async () => {
                      const r = await act.run(() => api<PlanList>("POST", `/api/commission-plans/${v.id}/approve`, {}));
                      if (r) setView(r);
                    }}>Approve</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}

function NewPlan({ userId, onDone, onCancel }: { userId: string; onDone: (p: PlanList) => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ effectiveFrom: todayIso(), splitPct: "", annualCap: "", capYearStartMonth: "1", capYearStartDay: "1", reason: "" });
  const [fees, setFees] = useState<{ name: string; amount: string }[]>([]);
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault();
      const r = await act.run(() => api<PlanList>("POST", `/api/agents/${userId}/commission-plans`, {
        effectiveFrom: f.effectiveFrom, reason: f.reason, fees,
        // percentages and calendar numbers are sent as numbers (the API's percent fields); amounts stay decimal strings
        ...(f.splitPct.trim() ? { splitPct: Number(f.splitPct) } : {}), ...(f.annualCap.trim() ? { annualCap: f.annualCap.trim() } : {}),
        capYearStartMonth: Number(f.capYearStartMonth), capYearStartDay: Number(f.capYearStartDay),
      }));
      if (r) onDone(r);
    }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <TextField label="Effective from" type="date" required value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} error={act.fields.effectiveFrom} />
      <TextField label="Agent's split (%)" inputMode="decimal" value={f.splitPct} onChange={(e) => setF({ ...f, splitPct: e.target.value })} error={act.fields.splitPct} />
      <TextField label="Annual cap" inputMode="decimal" hint="Leave blank for no cap" value={f.annualCap} onChange={(e) => setF({ ...f, annualCap: e.target.value })} error={act.fields.annualCap} />
      <div className="grid grid-cols-2 gap-3">
        <TextField label="Cap year month" inputMode="numeric" value={f.capYearStartMonth} onChange={(e) => setF({ ...f, capYearStartMonth: e.target.value })} error={act.fields.capYearStartMonth} />
        <TextField label="Day" inputMode="numeric" value={f.capYearStartDay} onChange={(e) => setF({ ...f, capYearStartDay: e.target.value })} error={act.fields.capYearStartDay} />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <p className="text-sm font-medium text-ink">Fees per deal</p>
        {fees.map((fee, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
            <TextField label="Fee" value={fee.name} onChange={(e) => setFees(fees.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} error={act.fields[`fees[${i}].name`]} />
            <TextField label="Amount" inputMode="decimal" value={fee.amount} onChange={(e) => setFees(fees.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} error={act.fields[`fees[${i}].amount`]} />
            <Button variant="ghost" onClick={() => setFees(fees.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button onClick={() => setFees([...fees, { name: "", amount: "" }])}>Add a fee</Button>
      </div>
      <div className="sm:col-span-2"><TextArea label="Reason" required rows={2} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} error={act.fields.reason} /></div>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Propose</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}

// ── Business calendar ────────────────────────────────────────────────────────

interface CalendarView {
  year: number | null; civicHolidayCounted: boolean; holidays: { date: string; name: string }[];
  proclaimed: { date: string; name: string; reference: string; addedBy: string; addedAt: string }[]; rule: string;
}

function Calendar() {
  const { user } = useSession();
  const broker = hasRole(user, ["MANAGING_BROKER"]);
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const res = useApi<CalendarView>(`/api/business-calendar?year=${encodeURIComponent(year)}`);
  return (
    <div className="space-y-5">
      <Section title="Business days" description="Used for the 5-business-day trust deposit rule and other deadlines."
        actions={<div className="w-32"><SelectField label="Year" value={year} onChange={(e) => setYear(e.target.value)}
          options={[-1, 0, 1].map((d) => String(new Date().getFullYear() + d)).map((y) => ({ value: y, label: y }))} /></div>}>
        {res.status === "error" && !res.data ? <Notice kind="error">{res.message}</Notice> : !res.data ? <Loading /> : (
          <>
            <p className="mb-3 text-sm text-ink-2">{res.data.rule}{res.data.civicHolidayCounted ? " Civic Holiday counts as a holiday." : ""}</p>
            <ul className="grid gap-1 text-sm sm:grid-cols-2">
              {res.data.holidays.map((h) => <li key={h.date}><span className="tabular-nums text-ink-2">{dateText(h.date)}</span> · {h.name}</li>)}
            </ul>
          </>
        )}
      </Section>
      <Section title="Proclaimed holidays" description="One-off holidays proclaimed by the province, added by the broker of record."
        actions={broker && <InlineForm label="Add a proclaimed holiday">{(close) => <NewProclaimed onDone={() => { close(); res.reload(); }} onCancel={close} />}</InlineForm>}>
        {!res.data ? null : res.data.proclaimed.length === 0 ? <Empty>None this year.</Empty> : (
          <ul className="divide-y divide-line text-sm">
            {res.data.proclaimed.map((p) => (
              <li key={p.date} className="py-2">{dateText(p.date)} · {p.name}<span className="block text-xs text-ink-3">{p.reference} · added by {p.addedBy} {dateTimeText(p.addedAt)}</span></li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function NewProclaimed({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const act = useAction();
  const [f, setF] = useState({ date: "", name: "", reference: "" });
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api("POST", "/api/business-calendar/proclaimed", f))) onDone(); }}>
      {act.error && <div className="sm:col-span-2"><Notice kind="error">{act.error}</Notice></div>}
      <TextField label="Date" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} error={act.fields.date} />
      <TextField label="Name" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={act.fields.name} />
      <div className="sm:col-span-2"><TextField label="Reference" required hint="The proclamation, with date" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} error={act.fields.reference} /></div>
      <div className="flex gap-2 sm:col-span-2"><Button type="submit" variant="primary" busy={act.busy}>Add holiday</Button><Button variant="ghost" onClick={onCancel}>Cancel</Button></div>
    </form>
  );
}
