import type { BrokerageDashboard } from "../types.ts";
import { compactDollars, dollars, DOC_STATUS_LABEL, money, relativeDays, shortDate, shortDocName } from "../format.ts";
import { CountPill, EmptyState, LockIcon, Panel, StatTile, StatusBadge, type Tone } from "./ui.tsx";

// ── 1. Financial summary ─────────────────────────────────────────────────────

export function FinancialSummary({ financials: f, year }: { financials: BrokerageDashboard["financials"]; year: number }) {
  return (
    <dl aria-label={`Financial summary, ${year} year to date`} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatTile
        label="Company dollar YTD"
        value={dollars(f.companyDollarCents)}
        title={money(f.companyDollarCents)}
        detail={<>Net of HST, after agent payouts · {f.finalizedClosings} finalized closing{f.finalizedClosings === 1 ? "" : "s"}</>}
      />
      <StatTile
        label="Closed volume YTD"
        value={compactDollars(f.closedVolumeCents)}
        title={money(f.closedVolumeCents)}
        detail={<>{f.closedDeals} closed deal{f.closedDeals === 1 ? "" : "s"}</>}
      />
      <StatTile
        label="Net HST on closed deals YTD (est.)"
        value={dollars(f.netHstEstimateCents)}
        title={money(f.netHstEstimateCents)}
        detail={<>Collected {dollars(f.hstCollectedCents)}, less HST paid to agents. Your HST return also counts other input tax credits.</>}
      />
    </dl>
  );
}

// ── 2. Trust account ─────────────────────────────────────────────────────────

export function TrustBalanceWidget({ trust, year }: { trust: BrokerageDashboard["trust"]; year: number }) {
  const late = trust.pastClosing;
  return (
    <Panel
      id="trust"
      title={<><span className="text-ink-3"><LockIcon /></span>Statutory trust account</>}
      subtitle="All deals, all trust accounts"
      action={late.length > 0 ? <StatusBadge tone="critical">{late.length} past closing</StatusBadge> : undefined}
    >
      <div className="px-4 pb-3 pt-4">
        <p className="text-xs font-medium text-ink-2">Held in trust now</p>
        <p className="mt-1 text-4xl font-semibold tracking-tight text-ink" title={money(trust.totalCents)}>{dollars(trust.totalCents)}</p>
        {trust.accounts.length > 1 && (
          <ul className="mt-3 space-y-1 text-sm">
            {trust.accounts.map((a) => (
              <li key={a.id} className="flex justify-between gap-3 text-ink-2">
                <span className="truncate">{a.name} <span className="text-ink-3">{a.bankName} ••{a.accountLast4}</span></span>
                <span className="tabular-nums text-ink">{money(a.balanceCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-line">
        <h3 className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-ink-3">Past closing, still holding funds</h3>
        {late.length === 0 ? (
          <EmptyState>No deal is holding trust funds past its closing date.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {late.map((d) => (
              <li key={d.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <a href={`/deals/${d.id}/trust`} className="text-sm font-medium text-ink underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                    {d.dealNumber}
                  </a>
                  <p className="truncate text-xs text-ink-3">{d.address}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    <StatusBadge tone="critical">Closed {shortDate(d.closeDate, year)} · {d.daysPastClose} days ago</StatusBadge>
                    {d.onHold && <StatusBadge tone="serious">On hold</StatusBadge>}
                  </div>
                </div>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{money(d.balanceCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

// ── 3. Compliance exception queue ────────────────────────────────────────────

function MissingList({ items }: { items: BrokerageDashboard["complianceQueue"][number]["missing"] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((m, i) => (
        <li key={i} className="flex items-start gap-2">
          <StatusBadge tone={DOC_TONE[m.status] ?? "critical"}>{DOC_STATUS_LABEL[m.status] ?? m.status}</StatusBadge>
          <span className="min-w-0 text-ink" title={m.document}>
            {shortDocName(m.document)}
            {m.party && <span className="text-ink-3"> · {m.party}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

const DOC_TONE: Record<string, Tone> = {
  MISSING: "critical",
  NOT_SET_UP: "critical",
  NEEDS_REVISION: "serious",
  PENDING_REVIEW: "warning",
};

function urgency(daysToClose: number): Tone {
  if (daysToClose <= 3) return "critical";
  if (daysToClose <= 7) return "serious";
  return "warning";
}

export function ComplianceQueue({
  queue, year, windowDays = 14, className = "",
}: { queue: BrokerageDashboard["complianceQueue"]; year: number; windowDays?: number; className?: string }) {
  return (
    <Panel
      id="compliance"
      className={className}
      title={<>FINTRAC exceptions <CountPill count={queue.length} tone={queue.length ? "critical" : "good"} /></>}
      subtitle={`Firm deals closing within ${windowDays} days (or overdue) without FINTRAC approval`}
    >
      {queue.length === 0 ? (
        <EmptyState>Every firm deal closing in the next {windowDays} days is FINTRAC approved.</EmptyState>
      ) : (
        <>
        {/* Phones: one card per deal */}
        <ul className="divide-y divide-line md:hidden">
          {queue.map((d) => (
            <li key={d.id} className="space-y-2 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <a href={`/deals/${d.id}/documents`} className="text-sm font-medium text-ink underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                    {d.dealNumber}
                  </a>
                  <p className="text-xs text-ink-3">{d.address} · {d.primaryAgent ?? "No agent"}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium text-ink">{shortDate(d.closeDate, year)}</p>
                  <StatusBadge tone={urgency(d.daysToClose)}>{relativeDays(d.daysToClose)}</StatusBadge>
                </div>
              </div>
              <MissingList items={d.missing} />
            </li>
          ))}
        </ul>
        {/* Tablet and up: dense table */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Firm deals closing soon that are missing FINTRAC approval, soonest first</caption>
            <thead className="bg-sunken text-xs font-medium text-ink-2">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Closing</th>
                <th scope="col" className="px-4 py-2 font-medium">Deal</th>
                <th scope="col" className="px-4 py-2 font-medium">Agent</th>
                <th scope="col" className="px-4 py-2 font-medium">Outstanding FINTRAC records</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {queue.map((d) => (
                <tr key={d.id} className="align-top hover:bg-sunken/60">
                  <td className="whitespace-nowrap px-4 py-2.5">
                    <div className="font-medium tabular-nums text-ink">{shortDate(d.closeDate, year)}</div>
                    <div className="mt-1"><StatusBadge tone={urgency(d.daysToClose)}>{relativeDays(d.daysToClose)}</StatusBadge></div>
                  </td>
                  <td className="px-4 py-2.5">
                    <a href={`/deals/${d.id}/documents`} className="font-medium text-ink underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                      {d.dealNumber}
                    </a>
                    <div className="text-xs text-ink-3">{d.address}</div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-ink-2">{d.primaryAgent ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <MissingList items={d.missing} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </Panel>
  );
}

export function AdminDashboard({ data, year }: { data: BrokerageDashboard; year: number }) {
  return (
    <div className="space-y-4">
      <FinancialSummary financials={data.financials} year={year} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <TrustBalanceWidget trust={data.trust} year={year} />
        <ComplianceQueue queue={data.complianceQueue} year={year} className="lg:col-span-2" />
      </div>
    </div>
  );
}
