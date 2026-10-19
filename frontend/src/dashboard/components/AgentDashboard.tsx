import type { PersonalDashboard } from "../types.ts";
import { compactDollars, dollars, money, percent, shortDate } from "../format.ts";
import { CountPill, DocIcon, EmptyState, Meter, Panel, StatTile, StatusBadge } from "./ui.tsx";

// ── 1. Personal analytics ────────────────────────────────────────────────────

export function PersonalAnalytics({ data, year }: { data: PersonalDashboard; year: number }) {
  return (
    <dl aria-label={`Your ${year} year to date`} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatTile
        label="Volume sold YTD"
        value={compactDollars(data.volumeCents)}
        title={money(data.volumeCents)}
        detail={<>{data.closedDeals} closed deal{data.closedDeals === 1 ? "" : "s"} (your share on co-listings)</>}
      />
      <StatTile
        label="Gross GCI earned YTD"
        value={dollars(data.grossGciCents)}
        title={money(data.grossGciCents)}
        detail="Your share of commission, before split, excl. HST"
      />
      <StatTile
        label="Net payouts YTD"
        value={dollars(data.netPayoutsCents)}
        title={money(data.netPayoutsCents)}
        detail="After split and fees, incl. HST · finalized closings"
      />
    </dl>
  );
}

// ── 2. PREC tax tracker ──────────────────────────────────────────────────────

export function PrecTaxTracker({ prec, year }: { prec: NonNullable<PersonalDashboard["prec"]>; year: number }) {
  return (
    <Panel id="prec" title="PREC tax tracker" subtitle={prec.legalName}>
      <div className="px-4 py-4">
        <p className="text-xs font-medium text-ink-2">HST Received on Commissions YTD</p>
        <p className="mt-1 text-4xl font-semibold tracking-tight text-ink" title={money(prec.hstReceivedCents)}>
          {dollars(prec.hstReceivedCents)}
        </p>
        <p className="mt-2 text-sm text-ink-2">
          This is HST you collected for CRA, not income. Set it aside for your corporation's HST return; it's separate from corporate income tax.
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3 text-sm">
          <div>
            <dt className="text-xs text-ink-3">Commission income {year} (excl. HST)</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-ink">{money(prec.commissionIncomeCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Corporation HST number</dt>
            <dd className="mt-0.5 font-medium text-ink">{prec.hstNumber ?? <StatusBadge tone="serious">Not on file</StatusBadge>}</dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}

// ── 3. Commission cap tracker ────────────────────────────────────────────────

export function CapTracker({ cap, year, className = "" }: { cap: PersonalDashboard["cap"]; year: number; className?: string }) {
  if (!cap) {
    return (
      <Panel id="cap" title="Commission cap" className={className}>
        <EmptyState tone="neutral">Your plan has no annual cap.</EmptyState>
      </Panel>
    );
  }
  const pct = percent(cap.paidCents, cap.capCents);
  const remaining = Math.max(0, cap.capCents - cap.paidCents);
  const capped = remaining === 0;
  const lastDay = new Date(`${cap.yearEnd}T12:00:00Z`);
  lastDay.setUTCDate(lastDay.getUTCDate() - 1);
  const label = `${dollars(cap.paidCents)} paid of ${dollars(cap.capCents)} cap`;

  return (
    <Panel
      id="cap"
      className={className}
      title="Commission cap"
      subtitle={`Cap year ${shortDate(cap.yearStart)}, ${cap.yearStart.slice(0, 4)} – ${shortDate(lastDay.toISOString().slice(0, 10))}, ${lastDay.getUTCFullYear()}`}
      action={capped ? <StatusBadge tone="good">Capped · 100% split</StatusBadge> : undefined}
    >
      <div className="px-4 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-lg font-semibold text-ink">{label}</p>
          <p className="text-sm font-medium tabular-nums text-ink-2">{Math.floor(pct)}%</p>
        </div>
        <div className="mt-3">
          <Meter value={cap.paidCents} max={cap.capCents} label="Progress toward your annual cap" valueText={label} />
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-3 text-sm">
          <div>
            <dt className="text-xs text-ink-3">House share paid</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-ink">{money(cap.paidCents)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Still to go</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-ink">{money(remaining)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">Cap resets</dt>
            <dd className="mt-0.5 font-medium text-ink">{shortDate(cap.yearEnd)}, {cap.yearEnd.slice(0, 4)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-ink-2">
          {capped
            ? "You've reached your cap. You keep 100% of your split until the cap year resets."
            : <>{dollars(remaining)} to go, then you keep 100% of your split for the rest of the cap year.</>}
        </p>
      </div>
    </Panel>
  );
}

// ── 4. Document warnings ─────────────────────────────────────────────────────

export function DocumentWarnings({ items, year }: { items: PersonalDashboard["needsRevision"]; year: number }) {
  return (
    <Panel
      id="revisions"
      title={<>Documents sent back <CountPill count={items.length} tone={items.length ? "serious" : "good"} /></>}
      subtitle="Fix these and re-upload; your broker reviews the new version"
    >
      {items.length === 0 ? (
        <EmptyState>Nothing needs revision. You're all caught up.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((d) => (
            <li key={d.slotId} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,16rem)_1fr_auto] md:items-start">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                  <span className="text-ink-3"><DocIcon /></span>
                  <span>{d.document}</span>
                </p>
                {d.party && <p className="ml-[22px] text-xs text-ink-3">{d.party}</p>}
                <p className="ml-[22px] mt-1 text-xs text-ink-3">
                  {d.dealNumber} · {d.address} · closes {shortDate(d.closeDate, year)}
                </p>
              </div>
              <figure className="rounded-lg border-l-4 border-serious bg-sunken px-3 py-2">
                <blockquote className="text-sm text-ink">{d.comment}</blockquote>
                <figcaption className="mt-1 text-xs text-ink-3">
                  {d.reviewer ?? "Reviewer"}{d.reviewedAt ? ` · ${shortDate(d.reviewedAt, year)}` : ""}
                </figcaption>
              </figure>
              <a
                href={`/deals/${d.id}/documents#slot-${d.slotId}`}
                className="inline-flex items-center justify-center rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-on shadow-xs hover:bg-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Upload revision
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function AgentDashboard({ data, year }: { data: PersonalDashboard; year: number }) {
  return (
    <div className="space-y-4">
      <PersonalAnalytics data={data} year={year} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <CapTracker cap={data.cap} year={year} className={data.prec ? "lg:col-span-2" : "lg:col-span-3"} />
        {data.prec && <PrecTaxTracker prec={data.prec} year={year} />}
      </div>
      <DocumentWarnings items={data.needsRevision} year={year} />
    </div>
  );
}
