import { useEffect, useState } from "react";
import { useApi } from "../app/useApi.ts";
import { Link, navigate, useLocation } from "../app/router.tsx";
import { ButtonLink, Empty, Loading, Notice, Page, PageHeader, SelectField, StatusBadge, Table, TextField, type Tone } from "../ui/kit.tsx";
import { dateText, labelOf, moneyText, SIDE_LABEL } from "../ui/format.ts";

export interface DealRow {
  id: string; dealNumber: string; side: string; status: string; streetAddress: string; unit: string | null; city: string;
  mlsNumber: string | null; offerDate: string; closeDate: string; salePrice: string; trustDepositHolder: string; agents: string[];
}

export const STATUS_TONE: Record<string, Tone> = { CONDITIONAL: "warning", FIRM: "good", CLOSED: "neutral", COLLAPSED: "critical", CANCELLED: "critical" };

export function DealsList() {
  const loc = useLocation();
  const [q, setQ] = useState(loc.search.get("q") ?? "");
  const status = loc.search.get("status") ?? "";
  const side = loc.search.get("side") ?? "";
  const [debounced, setDebounced] = useState(q);
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const params = new URLSearchParams({ ...(debounced ? { q: debounced } : {}), ...(status ? { status } : {}), ...(side ? { side } : {}) });
  const deals = useApi<{ deals: DealRow[]; truncated: boolean }>(`/api/deals?${params}`);
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(loc.search);
    if (value) next.set(key, value); else next.delete(key);
    navigate(`/deals${next.size ? `?${next}` : ""}`, { replace: true });
  };

  return (
    <Page wide>
      <PageHeader title="Deals" actions={<ButtonLink href="/deals/new" variant="primary">New deal</ButtonLink>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_12rem_12rem]">
        <TextField label="Search" type="search" placeholder="Deal number, address, MLS® or client name" value={q} onChange={(e) => setQ(e.target.value)} />
        <SelectField label="Status" value={status} onChange={(e) => setFilter("status", e.target.value)} placeholder="Any status"
          options={["CONDITIONAL", "FIRM", "CLOSED", "COLLAPSED", "CANCELLED"].map((s) => ({ value: s, label: labelOf(s) }))} />
        <SelectField label="Type" value={side} onChange={(e) => setFilter("side", e.target.value)} placeholder="Sales and leases"
          options={Object.entries(SIDE_LABEL).map(([value, label]) => ({ value, label }))} />
      </div>
      {deals.status === "error" && <Notice kind="error">{deals.message}</Notice>}
      {deals.status === "loading" && !deals.data ? <Loading label="Loading deals" /> : deals.data && (
        <div className="rounded-xl border border-line bg-card p-4 shadow-xs">
          {deals.data.deals.length === 0 ? <Empty>No deals match.</Empty> : (
            <Table head={["Deal", "Property", "Type", "Status", "Closing", "Price / rent", "Agents"]} caption="Deals">
              {deals.data.deals.map((d) => (
                <tr key={d.id}>
                  <td><Link href={`/deals/${d.id}`} className="font-medium text-ink underline-offset-2 hover:underline">{d.dealNumber}</Link></td>
                  <td>{d.unit ? `${d.unit} – ` : ""}{d.streetAddress}<span className="block text-xs text-ink-3">{d.city}{d.mlsNumber ? ` · MLS® ${d.mlsNumber}` : ""}</span></td>
                  <td className="whitespace-nowrap">{SIDE_LABEL[d.side] ?? d.side}</td>
                  <td><StatusBadge tone={STATUS_TONE[d.status] ?? "neutral"}>{labelOf(d.status)}</StatusBadge></td>
                  <td className="whitespace-nowrap">{dateText(d.closeDate)}</td>
                  <td className="whitespace-nowrap tabular-nums">{moneyText(d.salePrice)}</td>
                  <td>{d.agents.join(", ")}</td>
                </tr>
              ))}
            </Table>
          )}
          {deals.data.truncated && <p className="mt-3 text-xs text-ink-3">Showing the 200 most recent. Search to narrow it down.</p>}
        </div>
      )}
    </Page>
  );
}
