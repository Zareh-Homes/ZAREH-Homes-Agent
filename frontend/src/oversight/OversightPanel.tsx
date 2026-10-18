/**
 * Broker of record, accounting and agent oversight. Every figure shows what
 * it means, where it comes from and when it was true; the details sit in a
 * native disclosure so they're keyboard and screen-reader friendly.
 */

import { useEffect, useState } from "react";
import { StatusBadge, type Tone } from "../dashboard/components/ui.tsx";
import type { Metric, OversightView } from "./types.ts";

const TONE: Record<Metric["status"], Tone> = { ok: "good", attention: "warning", critical: "critical" };
const STATUS_LABEL: Record<Metric["status"], string> = { ok: "OK", attention: "Needs attention", critical: "Act now" };

const cad = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });

export function formatValue(m: Metric): string {
  if (m.value === null) return "—";
  if (m.unit === "CAD") return cad.format(Number(m.value));
  return String(m.value);
}

const when = (iso: string) => (iso.length > 10 ? new Date(iso).toLocaleString("en-CA", { timeZone: "America/Toronto" }) : iso);

export function MetricCard({ m }: { m: Metric }) {
  return (
    <article className="flex flex-col gap-2 rounded-lg bg-card p-4 ring-1 ring-line" aria-labelledby={`m-${m.key}`}>
      <div className="flex items-start justify-between gap-2">
        <h3 id={`m-${m.key}`} className="text-sm font-medium text-ink-2">{m.label}</h3>
        <StatusBadge tone={TONE[m.status]}>{STATUS_LABEL[m.status]}</StatusBadge>
      </div>
      <p className="text-2xl font-semibold tabular-nums text-ink">{formatValue(m)}</p>
      <details className="text-xs text-ink-2">
        <summary className="cursor-pointer select-none font-medium text-ink">What this is</summary>
        <dl className="mt-2 grid gap-1">
          <dt className="font-medium text-ink">Definition</dt><dd>{m.definition}</dd>
          <dt className="font-medium text-ink">Source</dt><dd>{m.source}</dd>
          <dt className="font-medium text-ink">As of</dt><dd>{when(m.asOf)}</dd>
        </dl>
      </details>
      {m.items && m.items.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-2">
          {m.items.slice(0, 8).map((i) => <li key={i}>{i}</li>)}
          {m.items.length > 8 && <li>…and {m.items.length - 8} more</li>}
        </ul>
      )}
    </article>
  );
}

export function OversightPanel({ data }: { data: OversightView }) {
  const title = { broker: "Broker of record", accounting: "Accounting", agent: "My compliance" }[data.view];
  return (
    <section className="mx-auto max-w-[1600px] space-y-6 px-4 py-6 sm:px-6 lg:px-8" aria-label={title}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="text-xs text-ink-3">As of {when(data.asOf)}</p>
      </header>
      {data.sections.map((s) => (
        <section key={s.title} aria-label={s.title} className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-3">{s.title}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {s.metrics.map((m) => <MetricCard key={m.key} m={m} />)}
          </div>
        </section>
      ))}
    </section>
  );
}

type State = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: OversightView };

export function LiveOversight({ view, fetcher = fetch }: { view: OversightView["view"]; fetcher?: typeof fetch }) {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    fetcher(`/api/dashboard/oversight?view=${view}`, { credentials: "include", signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.error?.message ?? `This view couldn't load (${res.status})`);
        setState({ status: "ready", data: body as OversightView });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setState({ status: "error", message: err instanceof Error ? err.message : "This view couldn't load" });
      });
    return () => controller.abort();
  }, [view, fetcher]);
  if (state.status === "loading") return <p className="p-6 text-sm text-ink-2" role="status">Loading…</p>;
  if (state.status === "error") return <p className="p-6 text-sm text-critical" role="alert">{state.message}</p>;
  return <OversightPanel data={state.data} />;
}
