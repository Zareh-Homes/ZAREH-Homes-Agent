/**
 * One deal: header, then a tab per part of the file. Each tab loads its own
 * data from the API; the deal record here is shared by all of them.
 */

import type { ReactNode } from "react";
import { useApi } from "../app/useApi.ts";
import { hasRole, useSession } from "../app/session.tsx";
import { Loading, Notice, Page, StatusBadge, TabLinks } from "../ui/kit.tsx";
import { dateText, isLease, labelOf, moneyText, SIDE_LABEL } from "../ui/format.ts";
import { STATUS_TONE } from "./DealsList.tsx";
import { OverviewTab } from "./OverviewTab.tsx";
import { DocumentsTab } from "./DocumentsTab.tsx";
import { ComplianceTab } from "./ComplianceTab.tsx";
import { OffersTab } from "./OffersTab.tsx";
import { DealTrustTab } from "../money/DealTrustTab.tsx";
import { ClosingTab } from "../money/ClosingTab.tsx";
import { TradeRecordTab } from "./TradeRecordTab.tsx";

export interface Deal {
  id: string; dealNumber: string; side: string; status: string; province: string; streetAddress: string; unit: string | null; city: string;
  mlsNumber: string | null; salePrice: string; offerDate: string; conditionsDueDate: string | null; closeDate: string; depositAmount: string;
  depositDueDate: string | null; trustDepositHolder: string; depositStatus: string; totalGci: string; coopBrokerageName: string | null;
  coopCommission: string; outsideReferralPayee: string | null; outsideReferralPct: string | null;
  agents: { userId: string; name: string; role: string; splitPct: string; gciSharePct: string; isPrec: boolean; precLegalName: string | null }[];
  parties: { id: string; role: string; entityType: string; fullName: string; email: string | null; phone: string | null; representation: string | null }[];
  cda: { cdaNumber: string; revision: number; finalizedAt: string; voided: string | null } | null;
}

export interface TabProps { deal: Deal; reloadDeal: () => void }

const TABS: { key: string; label: string; staffOnly?: boolean; listingOnly?: boolean; render: (p: TabProps) => ReactNode }[] = [
  { key: "overview", label: "Overview", render: (p) => <OverviewTab {...p} /> },
  { key: "documents", label: "Documents", render: (p) => <DocumentsTab {...p} /> },
  { key: "compliance", label: "TRESA & FINTRAC", render: (p) => <ComplianceTab {...p} /> },
  { key: "offers", label: "Offers", listingOnly: true, render: (p) => <OffersTab {...p} /> },
  { key: "trust", label: "Trust", render: (p) => <DealTrustTab {...p} /> },
  { key: "closing", label: "Closing & CDA", staffOnly: true, render: (p) => <ClosingTab {...p} /> },
  { key: "record", label: "Trade record", render: (p) => <TradeRecordTab {...p} /> },
];

export function DealWorkspace({ dealId, tab }: { dealId: string; tab: string }) {
  const { user } = useSession();
  const res = useApi<{ deal: Deal }>(`/api/deals/${dealId}`);
  const deal = res.data?.deal;
  const staff = hasRole(user, ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"]);
  const tabs = TABS.filter((t) => (!t.staffOnly || staff) && (!t.listingOnly || !deal || ["LISTING", "DUAL", "LANDLORD"].includes(deal.side)));
  const current = tabs.find((t) => t.key === tab) ?? tabs[0]!;

  if (res.status === "error" && !deal) {
    return <Page><Notice kind="error" title="This deal couldn't be opened">{res.message}</Notice></Page>;
  }
  if (!deal) return <Page><Loading label="Loading the deal" /></Page>;

  return (
    <Page wide>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Deal {deal.dealNumber} · {SIDE_LABEL[deal.side] ?? deal.side}</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-balance text-ink sm:text-2xl">
            {deal.unit ? `${deal.unit} – ` : ""}{deal.streetAddress}, {deal.city}
          </h1>
          <p className="mt-1 text-sm text-ink-2">
            {isLease(deal.side) ? "Rent" : "Price"} {moneyText(deal.salePrice)} · {isLease(deal.side) ? "Commences" : "Closes"} {dateText(deal.closeDate)}
            {deal.mlsNumber ? ` · MLS® ${deal.mlsNumber}` : ""}
          </p>
        </div>
        <StatusBadge tone={STATUS_TONE[deal.status] ?? "neutral"}>{labelOf(deal.status)}</StatusBadge>
      </header>
      <PilotScope deal={deal} />
      <TabLinks label="Deal sections" current={current.key} tabs={tabs.map((t) => ({ key: t.key, label: t.label, href: `/deals/${deal.id}/${t.key}` }))} />
      {current.render({ deal, reloadDeal: res.reload })}
    </Page>
  );
}

/** What this deal needs that the pilot doesn't do (docs/pilot-scope.md). Display only: the server refuses those steps. */
function PilotScope({ deal }: { deal: Deal }) {
  const notes: string[] = [];
  if (isLease(deal.side)) notes.push("Lease: the deal, documents and deposit are tracked here, but the CDA and payments out of trust stay off until the broker of record enables lease settlement.");
  if (deal.trustDepositHolder === "BUILDER") notes.push("Pre-construction deposit held by the builder: outside the pilot. Keep this deal's money in Lone Wolf.");
  if (deal.outsideReferralPayee) notes.push(`Outside referral to ${deal.outsideReferralPayee}: the referral payable can't be approved until the third-party payables policy is enabled. Pay it outside the pilot.`);
  if (notes.length === 0) return null;
  return (
    <div className="mb-4">
      <Notice kind="warning" title="Outside the pilot">
        <ul className="list-disc pl-5">{notes.map((n) => <li key={n}>{n}</li>)}</ul>
      </Notice>
    </div>
  );
}
