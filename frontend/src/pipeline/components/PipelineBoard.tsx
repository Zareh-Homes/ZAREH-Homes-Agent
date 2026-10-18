import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ColumnKey, DepositBadgeData, PipelineCard, PipelineResponse } from "../types.ts";
import { filterColumns } from "../filter.ts";
import { compactDollars, dollars, shortDate } from "../../dashboard/format.ts";
import { AlertIcon, CheckIcon, ClockIcon, StatusBadge, type Tone } from "../../dashboard/components/ui.tsx";

// ── Columns ──────────────────────────────────────────────────────────────────

const COLUMNS: { key: ColumnKey; title: string; hint: string }[] = [
  { key: "ACTIVE", title: "Active / Listed", hint: "On the market" },
  { key: "CONDITIONAL", title: "Conditional Offer", hint: "Waiting on financing, inspection or status certificate" },
  { key: "FIRM", title: "Firm / Pending Close", hint: "Conditions fulfilled or waived; waiting for completion" },
  { key: "CLOSED", title: "Closed", hint: "Completed this month" },
];

// ── Deposit badge ────────────────────────────────────────────────────────────

const DEPOSIT_STYLE: Record<DepositBadgeData["tone"], { box: string; icon: string; Icon: () => JSX.Element }> = {
  good: { box: "bg-good/10 ring-good/30", icon: "text-good", Icon: CheckIcon },
  // Slow pulse on the red badge only; turned off for people who ask for reduced motion
  critical: { box: "bg-critical/10 ring-critical/50 motion-safe:animate-pulse", icon: "text-critical", Icon: AlertIcon },
  warning: { box: "bg-warning/15 ring-warning/40", icon: "text-warning", Icon: ClockIcon },
  neutral: { box: "bg-sunken ring-line", icon: "text-ink-3", Icon: ClockIcon },
};

export function DepositBadge({ deposit }: { deposit: DepositBadgeData }) {
  const s = DEPOSIT_STYLE[deposit.tone];
  return (
    <div className={`rounded-md px-2 py-1 ring-1 ring-inset ${s.box}`} title={deposit.detail}>
      <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
        <span className={s.icon}><s.Icon /></span>
        <span>{deposit.label}</span>
      </p>
      {deposit.tone !== "good" && deposit.tone !== "neutral" && (
        <p className="mt-0.5 pl-[22px] text-[11px] leading-snug text-ink-2">{deposit.detail}</p>
      )}
      <span className="sr-only">. {deposit.detail}</span>
    </div>
  );
}

// ── Key date ─────────────────────────────────────────────────────────────────

function keyDateTone(column: ColumnKey, days: number): Tone {
  if (column === "CONDITIONAL") {
    if (days < 0) return "critical"; // deadline passed and still conditional
    if (days <= 2) return "serious";
    if (days <= 7) return "warning";
  }
  if (column === "FIRM") {
    if (days < 0) return "critical"; // completion date passed but not closed
    if (days <= 3) return "warning";
  }
  return "neutral";
}

function keyDateText(column: ColumnKey, days: number): string {
  if (column === "ACTIVE") return days === 0 ? "today" : `${-days}d on market`;
  if (column === "CLOSED") return days === 0 ? "today" : `${-days}d ago`;
  if (days === 0) return "today";
  if (days > 0) return `in ${days}d`;
  return column === "CONDITIONAL" ? `passed ${-days}d ago` : `${-days}d overdue`;
}

// ── Card ─────────────────────────────────────────────────────────────────────

export function DealCard({ card, column, year }: { card: PipelineCard; column: ColumnKey; year: number }) {
  const kd = card.keyDate;
  return (
    <li>
      <article className="group relative rounded-lg border border-line bg-card p-3 shadow-sm transition-shadow hover:shadow-md">
        <h3 className="text-sm font-semibold leading-snug text-ink">
          {/* Stretched link: the whole card is clickable, the heading is the accessible name */}
          <a href={card.href} className="after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-accent">
            {card.address}
          </a>
        </h3>
        <p className="text-xs text-ink-3">{card.city}</p>

        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-ink-3">MLS®</dt>
          <dd className="truncate font-medium text-ink-2">{card.mlsNumber ?? "Exclusive / not posted"}</dd>
          <dt className="text-ink-3">Agent</dt>
          <dd className="truncate font-medium text-ink-2">{card.agentName ?? "—"}</dd>
        </dl>

        <div className="mt-2 flex items-end justify-between gap-2">
          <div>
            <p className="text-[11px] text-ink-3">{card.priceLabel}</p>
            <p className="text-base font-semibold tracking-tight text-ink">{dollars(card.priceCents)}</p>
          </div>
          {kd ? (
            <div className="text-right">
              <p className="text-[11px] text-ink-3">{kd.label}</p>
              <StatusBadge tone={keyDateTone(column, kd.daysFromToday)}>
                <span className="tabular-nums">{shortDate(kd.date, year)}</span>
                <span className="font-normal text-ink-2">· {keyDateText(column, kd.daysFromToday)}</span>
              </StatusBadge>
            </div>
          ) : column === "CONDITIONAL" ? (
            <StatusBadge tone="serious">No condition date</StatusBadge>
          ) : null}
        </div>

        {(card.deposit || card.finalized) && (
          <div className="mt-2.5 space-y-1.5 border-t border-line pt-2.5">
            {card.deposit && <DepositBadge deposit={card.deposit} />}
            {card.finalized && <p className="text-[11px] font-medium text-ink-3">CDA finalized · funds disbursed</p>}
          </div>
        )}
      </article>
    </li>
  );
}

// ── Board ────────────────────────────────────────────────────────────────────

export function PipelineBoard({ data, initialQuery = "" }: { data: PipelineResponse; initialQuery?: string }) {
  const [query, setQuery] = useState(initialQuery);
  const deferred = useDeferredValue(query); // typing stays instant on big boards
  const inputRef = useRef<HTMLInputElement>(null);
  const columnRefs = useRef(new Map<ColumnKey, HTMLElement>());
  const searchId = useId();
  const year = Number(data.today.slice(0, 4));
  const monthName = new Date(`${data.month}-15T12:00:00Z`).toLocaleDateString("en-CA", { month: "long", timeZone: "UTC" });

  const visible = useMemo(() => filterColumns(data.columns, deferred), [data.columns, deferred]);
  const total = COLUMNS.reduce((s, c) => s + data.columns[c.key].length, 0);
  const shown = COLUMNS.reduce((s, c) => s + visible[c.key].length, 0);
  const alerts = [...data.columns.CONDITIONAL, ...data.columns.FIRM].filter((c) => c.deposit?.tone === "critical").length;

  // "/" jumps to search, Escape clears it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if (e.key === "/" && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="mx-auto max-w-[1600px] px-4 py-5 sm:px-6 lg:px-8">
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-3">
            {data.scope === "ALL" ? "All agents" : "Your listings and deals"} · as of {shortDate(data.today)}
          </p>
          <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            Deal pipeline
            {alerts > 0 && <StatusBadge tone="critical">{alerts} deposit issue{alerts === 1 ? "" : "s"}</StatusBadge>}
          </h1>
        </div>

        <div className="w-full sm:w-96">
          <label htmlFor={searchId} className="sr-only">Search by agent, MLS® number or street address</label>
          <div className="relative">
            <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={inputRef}
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setQuery("")}
              placeholder="Search agent, MLS® or address"
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-line bg-card py-2 pl-9 pr-12 text-sm text-ink shadow-sm placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 rounded border border-line bg-sunken px-1.5 text-[11px] text-ink-3 sm:block">/</kbd>
          </div>
          <p className="mt-1 text-xs text-ink-3" aria-live="polite">
            {deferred.trim() ? `${shown} of ${total} match` : `${total} on the board`}
          </p>
        </div>
      </header>

      {deferred.trim() && shown === 0 && (
        <p className="mb-4 rounded-lg border border-line bg-card px-4 py-3 text-sm text-ink-2">
          Nothing matches “{deferred.trim()}”. Try an agent's last name, part of the MLS® number, or the street name.
        </p>
      )}

      {/* Below xl the columns scroll sideways; these jump straight to one */}
      <nav aria-label="Jump to column" className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 sm:-mx-6 sm:px-6 xl:hidden">
        {COLUMNS.map((col) => (
          <button
            key={col.key}
            type="button"
            onClick={() => columnRefs.current.get(col.key)?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "start" })}
            className="shrink-0 rounded-full border border-line bg-card px-3 py-1 text-xs font-medium text-ink-2 shadow-sm hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {col.key === "CLOSED" ? "Closed" : col.title.split(" ")[0]} <span className="tabular-nums text-ink-3">{visible[col.key].length}</span>
          </button>
        ))}
      </nav>

      {/* Phones and tablets: swipe between columns. Wide screens: all four side by side. */}
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 xl:mx-0 xl:grid xl:grid-cols-4 xl:overflow-visible xl:px-0">
        {COLUMNS.map((col) => {
          const cards = visible[col.key];
          const value = cards.reduce((s, c) => s + c.priceCents, 0);
          const titleId = `${searchId}-${col.key}`;
          return (
            <section
              key={col.key}
              ref={(el) => {
                if (el) columnRefs.current.set(col.key, el);
                else columnRefs.current.delete(col.key);
              }}
              aria-labelledby={titleId}
              className="flex w-[85vw] max-w-sm shrink-0 snap-start flex-col rounded-xl border border-line bg-sunken/60 sm:w-80 xl:w-auto xl:max-w-none"
            >
              <header className="border-b border-line px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <h2 id={titleId} className="text-sm font-semibold text-ink">
                    {col.key === "CLOSED" ? `Closed (${monthName})` : col.title}
                  </h2>
                  <span className="rounded-full bg-card px-2 py-0.5 text-xs font-semibold tabular-nums text-ink ring-1 ring-inset ring-line">
                    {cards.length}
                  </span>
                </div>
                <p className="mt-0.5 flex justify-between gap-2 text-[11px] text-ink-3">
                  <span className="truncate">{col.hint}</span>
                  {cards.length > 0 && <span className="shrink-0 tabular-nums" title={dollars(value)}>{compactDollars(value)}</span>}
                </p>
              </header>
              {cards.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-ink-3">{deferred.trim() ? "No matches" : "Nothing here"}</p>
              ) : (
                <ul className="flex flex-col gap-2 p-2">
                  {cards.map((card) => <DealCard key={card.id} card={card} column={col.key} year={year} />)}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function PipelinePage({ state, onRetry, initialQuery = "" }: {
  state: { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: PipelineResponse };
  onRetry: () => void;
  initialQuery?: string;
}) {
  if (state.status === "loading") {
    return (
      <div className="mx-auto max-w-[1600px] animate-pulse px-4 py-5 motion-reduce:animate-none sm:px-6 lg:px-8" aria-busy="true" aria-label="Loading pipeline">
        <div className="mb-4 h-8 w-56 rounded bg-sunken" />
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-96 rounded-xl bg-sunken" />)}</div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center" role="alert">
        <p className="text-base font-semibold text-ink">The pipeline didn't load</p>
        <p className="mt-1 text-sm text-ink-2">{state.message}</p>
        <button type="button" onClick={onRetry} className="mt-4 rounded-lg border border-line bg-card px-3 py-1.5 text-sm font-medium text-ink shadow-sm hover:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          Try again
        </button>
      </div>
    );
  }
  return <PipelineBoard data={state.data} initialQuery={initialQuery} />;
}
