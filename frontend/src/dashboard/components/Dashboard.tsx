import { useId, useState } from "react";
import type { DashboardResponse } from "../types.ts";
import type { DashboardState } from "../useDashboard.ts";
import { ROLE_LABEL, shortDate } from "../format.ts";
import { AdminDashboard } from "./AdminDashboard.tsx";
import { AgentDashboard } from "./AgentDashboard.tsx";

type View = "brokerage" | "personal";

/**
 * Picks the layout from the session's role. The server only sends the
 * sections a role may see; a managing broker who also sells gets both, with
 * a toggle.
 */
export function Dashboard({ data }: { data: DashboardResponse }) {
  const available: View[] = [
    ...(data.brokerage ? (["brokerage"] as const) : []),
    ...(data.personal ? (["personal"] as const) : []),
  ];
  const [view, setView] = useState<View>(available[0] ?? "personal");
  const tabsId = useId();
  const year = data.period.year;

  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-ink-3">
            {year} year to date · as of {shortDate(data.period.today)}
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            {view === "brokerage" ? "Brokerage overview" : "Your business"}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {available.length > 1 && (
            <div role="tablist" aria-label="Dashboard view" className="inline-flex rounded-lg border border-line bg-sunken p-0.5">
              {available.map((v) => (
                <button
                  key={v}
                  role="tab"
                  type="button"
                  id={`${tabsId}-${v}`}
                  aria-selected={view === v}
                  aria-controls={`${tabsId}-panel`}
                  onClick={() => setView(v)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                    view === v ? "bg-card text-ink shadow-xs" : "text-ink-2 hover:text-ink"
                  }`}
                >
                  {v === "brokerage" ? "Brokerage" : "My business"}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-ink">{data.viewer.name}</span>
            <span className="rounded-md bg-sunken px-2 py-0.5 text-xs font-medium text-ink-2 ring-1 ring-inset ring-line">
              {ROLE_LABEL[data.viewer.role] ?? data.viewer.role}
              {data.viewer.isPrec ? " · PREC" : ""}
            </span>
          </div>
        </div>
      </header>

      <div
        id={`${tabsId}-panel`}
        role={available.length > 1 ? "tabpanel" : undefined}
        aria-labelledby={available.length > 1 ? `${tabsId}-${view}` : undefined}
      >
        {view === "brokerage" && data.brokerage && <AdminDashboard data={data.brokerage} year={year} />}
        {view === "personal" && data.personal && <AgentDashboard data={data.personal} year={year} />}
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mx-auto max-w-7xl animate-pulse px-4 py-5 motion-reduce:animate-none sm:px-6 lg:px-8" aria-busy="true" aria-label="Loading dashboard">
      <div className="mb-5 h-8 w-64 rounded-sm bg-sunken" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => <div key={i} className="h-28 rounded-xl bg-sunken" />)}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="h-72 rounded-xl bg-sunken" />
        <div className="h-72 rounded-xl bg-sunken lg:col-span-2" />
      </div>
    </div>
  );
}

/** Loading / error / ready wrapper around useDashboard(). */
export function DashboardPage({ state, onRetry }: { state: DashboardState; onRetry: () => void }) {
  if (state.status === "loading") return <Skeleton />;
  if (state.status === "error") {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center" role="alert">
        <p className="text-base font-semibold text-ink">The dashboard didn't load</p>
        <p className="mt-1 text-sm text-ink-2">{state.message}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg border border-line bg-card px-3 py-1.5 text-sm font-medium text-ink shadow-xs hover:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Try again
        </button>
      </div>
    );
  }
  return <Dashboard data={state.data} />;
}
