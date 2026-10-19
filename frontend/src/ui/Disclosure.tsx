import { useState, type ReactNode } from "react";
import { Button } from "./kit.tsx";

/**
 * A button that opens an inline form under it (no modal: works the same on
 * phones, and keeps the record visible while filling it in).
 */
export function InlineForm({
  label, variant = "secondary", children, disabled,
}: { label: string; variant?: "primary" | "secondary" | "danger"; disabled?: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      {!open && <Button variant={variant} disabled={disabled} onClick={() => setOpen(true)}>{label}</Button>}
      {open && (
        <div className="rounded-lg border border-line bg-sunken/50 p-4">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Ask once more before something that can't be undone, inline. */
export function ConfirmButton({
  label, confirmLabel, question, onConfirm, busy, variant = "primary", disabled,
}: { label: string; confirmLabel?: string; question: ReactNode; onConfirm: () => void; busy?: boolean; variant?: "primary" | "danger" | "secondary"; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button variant={variant} disabled={disabled} busy={busy} onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-sunken/50 p-3 text-sm text-ink">
      <span className="min-w-0 flex-1">{question}</span>
      <Button variant={variant} busy={busy} onClick={() => { onConfirm(); setAsking(false); }}>{confirmLabel ?? label}</Button>
      <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
    </div>
  );
}
