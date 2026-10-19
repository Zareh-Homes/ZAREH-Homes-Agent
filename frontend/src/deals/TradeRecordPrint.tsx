/**
 * Printable trade record sheet: the record as it stands, every earlier entry
 * still legible with the initials of whoever corrected it, and both signatures.
 */

import { useEffect } from "react";
import { useApi } from "../app/useApi.ts";
import { Link } from "../app/router.tsx";
import { Button, Loading, Notice } from "../ui/kit.tsx";
import { dateText, dateTimeText, SIDE_LABEL } from "../ui/format.ts";
import { TrsValue, type TradeRecord } from "./TradeRecordTab.tsx";
import type { Deal } from "./DealWorkspace.tsx";

export function TradeRecordPrint({ dealId }: { dealId: string }) {
  const trs = useApi<TradeRecord>(`/api/deals/${dealId}/trade-record`);
  const deal = useApi<{ deal: Deal }>(`/api/deals/${dealId}`);
  useEffect(() => { document.title = "Trade record sheet"; }, []);
  if (trs.status === "error" || deal.status === "error") return <div className="p-6"><Notice kind="error">{trs.status === "error" ? trs.message : deal.status === "error" ? deal.message : ""}</Notice></div>;
  if (!trs.data || !deal.data) return <div className="p-6"><Loading /></div>;
  const t = trs.data;
  const d = deal.data.deal;
  return (
    <div className="mx-auto max-w-3xl bg-card px-6 py-8 text-sm text-ink print:max-w-none print:px-0 print:py-0">
      <div className="mb-6 flex items-center justify-between gap-3 print:hidden">
        <Link href={`/deals/${dealId}/record`} className="text-sm underline">Back to the deal</Link>
        <Button variant="primary" onClick={() => window.print()}>Print</Button>
      </div>
      <header className="mb-5 border-b border-ink pb-3">
        <h1 className="text-lg font-semibold">Trade record sheet</h1>
        <p>Deal {d.dealNumber} · {SIDE_LABEL[d.side] ?? d.side} · {d.unit ? `${d.unit} – ` : ""}{d.streetAddress}, {d.city}</p>
        <p className="text-xs text-ink-2">O. Reg. 579/05 s.17 · printed {dateTimeText(new Date().toISOString())}</p>
      </header>
      <ol className="space-y-4">
        {t.items.map((it, n) => (
          <li key={it.item} className="break-inside-avoid">
            <p className="font-semibold">{n + 1}. {it.label}</p>
            <div className="mt-1"><TrsValue value={it.value} /></div>
            {it.history.length > 1 && (
              <ol className="mt-1 space-y-1 border-l border-line pl-3 text-xs text-ink-2">
                {it.history.slice(0, -1).map((h, i) => (
                  <li key={i}>
                    <span className="line-through"><TrsValue value={h.value} /></span>
                    <span className="block">Replaced: {it.history[i + 1]!.reason} · {it.history[i + 1]!.by} ({it.history[i + 1]!.initials}) · {dateTimeText(it.history[i + 1]!.at)}</span>
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ol>
      <footer className="mt-8 grid gap-6 border-t border-ink pt-4 sm:grid-cols-2">
        <div><p className="font-semibold">Agent</p><p>{t.agentSignedBy ? `${t.agentSignedBy}, ${dateTimeText(t.agentSignedAt)}` : "Not signed"}</p></div>
        <div><p className="font-semibold">Broker of record</p><p>{t.brokerSignedBy ? `${t.brokerSignedBy}, ${dateTimeText(t.brokerSignedAt)}` : "Not signed"}</p></div>
        {t.retainUntil && <p className="text-xs text-ink-2 sm:col-span-2">Retain until {dateText(t.retainUntil)}.</p>}
      </footer>
    </div>
  );
}
