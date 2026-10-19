/**
 * Shared form and layout pieces for the staff screens. Built on the same
 * tokens as the dashboards (index.css); status is never colour alone.
 */

import {
  useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from "react";
import { StatusBadge, type Tone } from "../dashboard/components/ui.tsx";
import { Link } from "../app/router.tsx";

export { StatusBadge, type Tone };

const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

// ── Buttons ──────────────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-accent-on shadow-xs hover:bg-accent/90",
  secondary: "border border-line bg-card text-ink shadow-xs hover:bg-sunken",
  danger: "bg-critical text-white shadow-xs hover:bg-critical/90",
  ghost: "text-ink-2 hover:bg-sunken hover:text-ink",
};

export function Button({
  variant = "secondary", busy = false, className = "", children, disabled, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${focus} ${className}`}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function ButtonLink({ href, variant = "secondary", children, className = "" }: { href: string; variant?: Variant; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium ${VARIANT[variant]} ${focus} ${className}`}>
      {children}
    </Link>
  );
}

export function Spinner() {
  return <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />;
}

// ── Fields ───────────────────────────────────────────────────────────────────

const control = `block w-full rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink shadow-xs placeholder:text-ink-3 aria-[invalid=true]:border-critical ${focus}`;

interface FieldShell {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
}

function Shell({ id, label, hint, error, required, children }: FieldShell & { id: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
        {required && <span className="text-critical" aria-hidden> *</span>}
      </label>
      {children}
      {hint && !error && <p id={`${id}-hint`} className="text-xs text-ink-3">{hint}</p>}
      {error && <p id={`${id}-error`} className="text-xs font-medium text-critical">{error}</p>}
    </div>
  );
}

const described = (id: string, hint: unknown, error: unknown) =>
  [error ? `${id}-error` : null, hint && !error ? `${id}-hint` : null].filter(Boolean).join(" ") || undefined;

export function TextField({ label, hint, error, required, id: given, ...rest }: FieldShell & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <Shell id={id} label={label} hint={hint} error={error} required={required}>
      <input id={id} required={required} aria-invalid={error ? true : undefined} aria-describedby={described(id, hint, error)} className={control} {...rest} />
    </Shell>
  );
}

export function TextArea({ label, hint, error, required, id: given, ...rest }: FieldShell & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <Shell id={id} label={label} hint={hint} error={error} required={required}>
      <textarea id={id} rows={3} required={required} aria-invalid={error ? true : undefined} aria-describedby={described(id, hint, error)} className={control} {...rest} />
    </Shell>
  );
}

export function SelectField({
  label, hint, error, required, options, placeholder, id: given, ...rest
}: FieldShell & SelectHTMLAttributes<HTMLSelectElement> & { options: readonly { value: string; label: string }[]; placeholder?: string }) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <Shell id={id} label={label} hint={hint} error={error} required={required}>
      <select id={id} required={required} aria-invalid={error ? true : undefined} aria-describedby={described(id, hint, error)} className={control} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Shell>
  );
}

export function Checkbox({ label, hint, id: given, ...rest }: { label: ReactNode; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = given ?? auto;
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className={`mt-0.5 size-4 rounded border-line accent-[rgb(var(--accent))] ${focus}`} {...rest} />
      <label htmlFor={id} className="text-sm text-ink">
        {label}
        {hint && <span className="block text-xs text-ink-3">{hint}</span>}
      </label>
    </div>
  );
}

// ── Messages ─────────────────────────────────────────────────────────────────

const NOTICE: Record<"error" | "success" | "info" | "warning", { box: string; tone: Tone; role: "alert" | "status" }> = {
  error: { box: "border-critical/40 bg-critical/5", tone: "critical", role: "alert" },
  warning: { box: "border-warning/50 bg-warning/10", tone: "warning", role: "status" },
  success: { box: "border-good/40 bg-good/5", tone: "good", role: "status" },
  info: { box: "border-line bg-sunken", tone: "neutral", role: "status" },
};

export function Notice({ kind, title, children }: { kind: keyof typeof NOTICE; title?: ReactNode; children?: ReactNode }) {
  const n = NOTICE[kind];
  return (
    <div role={n.role} className={`rounded-lg border px-4 py-3 text-sm text-ink ${n.box}`}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? "mt-1 text-ink-2" : ""}>{children}</div>}
    </div>
  );
}

// ── Layout ───────────────────────────────────────────────────────────────────

/** Width and gutters for a screen inside the app frame. */
export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={`mx-auto px-4 py-5 sm:px-6 lg:px-8 ${wide ? "max-w-[1600px]" : "max-w-7xl"}`}>{children}</div>;
}

export function PageHeader({ title, eyebrow, actions, children }: { title: ReactNode; eyebrow?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="text-xs font-medium uppercase tracking-wide text-ink-3">{eyebrow}</p>}
        <h1 className="mt-1 text-xl font-semibold tracking-tight text-balance text-ink sm:text-2xl">{title}</h1>
        {children && <div className="mt-1 text-sm text-ink-2">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, description, actions, children, id }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  const auto = useId();
  const hid = `${id ?? auto}-title`;
  return (
    <section aria-labelledby={hid} className="min-w-0 rounded-xl border border-line bg-card shadow-xs">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 id={hid} className="text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-ink-3">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Label / value pairs that stack on phones. */
export function Facts({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs font-medium text-ink-3">{k}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A table that scrolls sideways inside its own box on narrow screens. */
export function Table({ head, children, caption }: { head: ReactNode[]; children: ReactNode; caption?: string }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-[36rem] text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line text-xs font-medium text-ink-3">
            {head.map((h, i) => <th key={i} scope="col" className="px-2 py-2 font-medium first:pl-0">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line [&_td]:px-2 [&_td]:py-2.5 [&_td:first-child]:pl-0 [&_td]:align-top">{children}</tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-4 text-sm text-ink-3">{children}</p>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-10 text-sm text-ink-2">
      <Spinner /> {label}…
    </div>
  );
}

/** Tabs as links, so each tab has its own URL and works with back/forward. */
export function TabLinks({ tabs, current, label }: { tabs: { href: string; label: ReactNode; key: string }[]; current: string; label: string }) {
  return (
    <nav aria-label={label} className="-mx-4 mb-5 overflow-x-auto border-b border-line px-4">
      <ul className="flex min-w-max gap-1">
        {tabs.map((t) => (
          <li key={t.key}>
            <Link
              href={t.href}
              aria-current={current === t.key ? "page" : undefined}
              className={`block border-b-2 px-3 py-2.5 text-sm font-medium ${focus} ${current === t.key ? "border-accent text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
            >
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
