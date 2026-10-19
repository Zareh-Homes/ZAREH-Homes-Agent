/**
 * Everything waiting on a broker or admin, in one list: payouts, commission
 * plans and adjustments to approve, bank files to verify, reconciliations to
 * sign. Approvals here follow segregation of duties: nobody approves what they
 * entered themselves (the database enforces it; the screen just says so).
 */

import { api } from "../app/api.ts";
import { useAction, useApi } from "../app/useApi.ts";
import { Link } from "../app/router.tsx";
import { hasRole, useSession } from "../app/session.tsx";
import { Button, Empty, Loading, Notice, Page, PageHeader, Section, StatusBadge } from "../ui/kit.tsx";
import { dateText, dateTimeText, labelOf, moneyText } from "../ui/format.ts";

interface Approvals {
  payouts: { dealId: string; dealNumber: string; address: string; action: string; line: { id: string; kind: string; payeeName: string; remaining: string; status: string } }[];
  plans: { id: string; userId: string; agent: string; effectiveFrom: string; splitBps: number | null; annualCap: string | null; reason: string; createdById: string | null; createdBy: string | null; createdAt: string }[];
  adjustments: { id: string; dealId: string; dealNumber: string; agent: string; kind: string; description: string; amount: string; taxable: boolean; createdById: string | null; createdAt: string }[];
  statements: { id: string; kind: string; account: string; periodStart: string; periodEnd: string; importedAt: string; importedById: string; importedBy: string }[];
  reconciliationsToSign: { id: string; trustAccountName: string; periodEnd: string; isBalanced: boolean; difference: string; preparedAt: string; preparedBy: string }[];
}

export function ApprovalsPage() {
  const { user } = useSession();
  const broker = hasRole(user, ["MANAGING_BROKER"]);
  const res = useApi<Approvals>("/api/work/approvals");
  const act = useAction();
  const approve = async (path: string) => { if (await act.run(() => api("POST", path, {}))) res.reload(); };

  const body = () => {
    if (res.status === "error" && !res.data) return <Notice kind="error">{res.message}</Notice>;
    if (!res.data) return <Loading label="Loading approvals" />;
    const a = res.data;
    return (
      <div className="space-y-5">
        {act.error && <Notice kind="error">{act.error}</Notice>}

        <Section title={`Payouts (${a.payouts.length})`} description="Open the deal's closing to approve or record a payment.">
          {a.payouts.length === 0 ? <Empty>No payouts waiting.</Empty> : (
            <ul className="divide-y divide-line text-sm">
              {a.payouts.map((p) => (
                <li key={p.line.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{p.line.payeeName}</span> <span className="text-ink-3">{labelOf(p.line.kind)}</span> · {moneyText(p.line.remaining)}
                    <span className="block text-ink-2">{p.action}</span>
                    <span className="block text-xs text-ink-3">Deal {p.dealNumber} · {p.address}</span>
                  </span>
                  <Link href={`/deals/${p.dealId}/closing`} className="text-sm underline">Open closing</Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Commission plans (${a.plans.length})`} description="A managing broker approves plan changes someone else proposed.">
          {a.plans.length === 0 ? <Empty>No plans waiting.</Empty> : (
            <ul className="divide-y divide-line text-sm">
              {a.plans.map((p) => {
                const own = p.createdById === user?.id;
                return (
                  <li key={p.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="font-medium text-ink">{p.agent}</span> · from {dateText(p.effectiveFrom)}
                      <span className="block text-ink-2">
                        {p.splitBps !== null ? `${p.splitBps / 100}% split` : "Split unchanged"}{p.annualCap ? ` · cap ${moneyText(p.annualCap)}` : ""} · {p.reason}
                      </span>
                      <span className="block text-xs text-ink-3">Proposed by {p.createdBy ?? "—"} {dateTimeText(p.createdAt)}</span>
                    </span>
                    {broker && (own ? <span className="text-xs text-ink-3">You proposed this; another broker approves it</span>
                      : <Button variant="primary" busy={act.busy} onClick={() => void approve(`/api/commission-plans/${p.id}/approve`)}>Approve</Button>)}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title={`Bonuses and deductions (${a.adjustments.length})`}>
          {a.adjustments.length === 0 ? <Empty>No adjustments waiting.</Empty> : (
            <ul className="divide-y divide-line text-sm">
              {a.adjustments.map((x) => {
                const own = x.createdById === user?.id;
                return (
                  <li key={x.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="font-medium text-ink">{x.agent}</span>: {labelOf(x.kind)} {moneyText(x.amount)}{x.taxable ? " + tax" : ""}
                      <span className="block text-ink-2">{x.description}</span>
                      <span className="block text-xs text-ink-3"><Link href={`/deals/${x.dealId}/closing`} className="underline">Deal {x.dealNumber}</Link> · added {dateTimeText(x.createdAt)}</span>
                    </span>
                    {broker && (own ? <span className="text-xs text-ink-3">You added this; another broker approves it</span>
                      : <Button variant="primary" busy={act.busy} onClick={() => void approve(`/api/commission-adjustments/${x.id}/approve`)}>Approve</Button>)}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        <Section title={`Bank files to verify (${a.statements.length})`} description="Someone other than the person who imported it checks it against the bank.">
          {a.statements.length === 0 ? <Empty>No bank files waiting.</Empty> : (
            <ul className="divide-y divide-line text-sm">
              {a.statements.map((s) => (
                <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{s.account}</span> · {labelOf(s.kind)} {dateText(s.periodStart)} – {dateText(s.periodEnd)}
                    <span className="block text-xs text-ink-3">Imported by {s.importedBy} {dateTimeText(s.importedAt)}{s.importedById === user?.id ? " (you)" : ""}</span>
                  </span>
                  <Link href={`/bank/statements/${s.id}`} className="text-sm underline">Open</Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Reconciliations to sign (${a.reconciliationsToSign.length})`}>
          {a.reconciliationsToSign.length === 0 ? <Empty>No reconciliations waiting.</Empty> : (
            <ul className="divide-y divide-line text-sm">
              {a.reconciliationsToSign.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="font-medium text-ink">{r.trustAccountName}</span> · {dateText(r.periodEnd)}{" "}
                    <StatusBadge tone={r.isBalanced ? "good" : "critical"}>{r.isBalanced ? "Balanced" : `Out by ${moneyText(r.difference)}`}</StatusBadge>
                    <span className="block text-xs text-ink-3">Prepared by {r.preparedBy} {dateTimeText(r.preparedAt)}</span>
                  </span>
                  <Link href={`/bank/reconciliations/${r.id}`} className="text-sm underline">Open</Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    );
  };

  return (
    <Page>
      <PageHeader title="Approvals & payouts">Approving records a decision. Payments are sent in the bank portal, never from here.</PageHeader>
      {body()}
    </Page>
  );
}
