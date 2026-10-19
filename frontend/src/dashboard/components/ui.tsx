/**
 * Dashboard building blocks. Status colour never carries meaning alone:
 * every status pairs an icon with a text label.
 */

import type { ReactNode } from "react";

// ── Icons (inline, decorative: the label next to them carries the meaning) ────

const iconProps = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const AlertIcon = () => (
  <svg {...iconProps}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>
);
export const CheckIcon = () => (
  <svg {...iconProps}><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>
);
export const ClockIcon = () => (
  <svg {...iconProps}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const LockIcon = () => (
  <svg {...iconProps}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);
export const DocIcon = () => (
  <svg {...iconProps}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></svg>
);

// ── Status ───────────────────────────────────────────────────────────────────

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral";

const TONE: Record<Tone, { icon: string; chip: string; Icon: () => JSX.Element }> = {
  good: { icon: "text-good", chip: "bg-good/10 ring-good/30", Icon: CheckIcon },
  warning: { icon: "text-warning", chip: "bg-warning/15 ring-warning/40", Icon: ClockIcon },
  serious: { icon: "text-serious", chip: "bg-serious/15 ring-serious/40", Icon: AlertIcon },
  critical: { icon: "text-critical", chip: "bg-critical/10 ring-critical/30", Icon: AlertIcon },
  neutral: { icon: "text-ink-3", chip: "bg-sunken ring-line", Icon: ClockIcon },
};

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium text-ink ring-1 ring-inset ${t.chip}`}>
      <span className={t.icon}><t.Icon /></span>
      {children}
    </span>
  );
}

/** A small count pill for panel headers. */
export function CountPill({ count, tone }: { count: number; tone: Tone }) {
  return (
    <span className={`inline-flex min-w-6 items-center justify-center rounded-full px-2 py-0.5 text-xs font-semibold text-ink ring-1 ring-inset ${TONE[tone].chip}`}>
      {count}
    </span>
  );
}

// ── Layout ───────────────────────────────────────────────────────────────────

export function Panel({
  id, title, subtitle, action, children, className = "",
}: { id: string; title: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={`${id}-title`} className={`flex min-w-0 flex-col rounded-xl border border-line bg-card shadow-xs ${className}`}>
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
        </div>
        {action}
      </header>
      <div className="flex-1">{children}</div>
    </section>
  );
}

/** Stat tile: label, value, and one line of context. */
export function StatTile({ label, value, title, detail }: { label: string; value: string; title?: string; detail?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-line bg-card px-4 py-3.5 shadow-xs">
      <dt className="text-xs font-medium text-ink-2">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tracking-tight text-ink sm:text-[1.75rem]/8" title={title}>{value}</dd>
      {detail && <dd className="mt-1 text-xs text-ink-3">{detail}</dd>}
    </div>
  );
}

/**
 * Meter: fill in the accent, on a lighter step of the same hue, so the bar
 * reads as one scale. Full = done (good), never "danger".
 */
export function Meter({ value, max, label, valueText }: { value: number; max: number; label: string; valueText: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const full = pct >= 100;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      aria-valuetext={valueText}
      className="h-3 w-full overflow-hidden rounded-full bg-accent-track"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${full ? "bg-good" : "bg-accent"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function EmptyState({ tone = "good", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 py-6 text-sm text-ink-2">
      <span className={TONE[tone].icon}>{tone === "good" ? <CheckIcon /> : <ClockIcon />}</span>
      {children}
    </div>
  );
}
