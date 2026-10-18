/** Fictional board for local previews (/pipeline?demo=1) and component tests. */

import type { DepositBadgeData, PipelineCard, PipelineResponse } from "./types.ts";

const cleared = (amount: number, receipt: number): DepositBadgeData => ({
  state: "CLEARED", tone: "good", label: "Deposit Received & Cleared",
  detail: `$${amount.toLocaleString("en-CA")} in trust · receipt #${receipt}`, expectedCents: amount * 100, receivedCents: amount * 100,
});

let n = 0;
const card = (c: Partial<PipelineCard> & Pick<PipelineCard, "address" | "city" | "agentName" | "priceCents">): PipelineCard => ({
  id: `demo-${++n}`, kind: "DEAL", href: "#", dealNumber: `2026-0${140 + n}`, side: "LISTING", mlsNumber: `W${7_400_000 + n * 3_117}`,
  priceLabel: "Sale price", keyDate: null, deposit: null, finalized: false, ...c,
});

export const demoPipeline: PipelineResponse = {
  today: "2026-10-18",
  month: "2026-10",
  scope: "ALL",
  columns: {
    ACTIVE: [
      card({ kind: "LISTING", dealNumber: null, side: null, address: "310 Lakeshore Rd E", city: "Oakville", agentName: "Jane Smith", priceCents: 239_900_000, priceLabel: "List price", keyDate: { label: "Listed", date: "2026-10-14", daysFromToday: -4 } }),
      card({ kind: "LISTING", dealNumber: null, side: null, address: "1203 – 2560 Eglinton Ave W", city: "Mississauga", agentName: "Omar Haddad", priceCents: 64_900_000, priceLabel: "List price", keyDate: { label: "Listed", date: "2026-10-02", daysFromToday: -16 } }),
      card({ kind: "LISTING", dealNumber: null, side: null, mlsNumber: null, address: "41 Ridge Rd", city: "Stoney Creek", agentName: "Priya Shah", priceCents: 104_900_000, priceLabel: "List price", keyDate: { label: "Listed", date: "2026-09-20", daysFromToday: -28 } }),
    ],
    CONDITIONAL: [
      card({ address: "17 Elm Ave", city: "Grimsby", agentName: "Priya Shah", priceCents: 78_500_000, keyDate: { label: "Conditions due", date: "2026-10-19", daysFromToday: 1 },
        deposit: cleared(40_000, 1061) }),
      card({ side: "BUYER", address: "905 – 15 Lynch St", city: "Toronto", agentName: "Jane Smith", priceCents: 61_200_000, keyDate: { label: "Conditions due", date: "2026-10-23", daysFromToday: 5 },
        deposit: { state: "OVERDUE", tone: "critical", label: "Deposit Missing / Overdue", detail: "$30,000 was due Oct 14 (2 business days ago)", expectedCents: 3_000_000, receivedCents: 0 } }),
      card({ address: "88 Bay St N", city: "Hamilton", agentName: "Omar Haddad", priceCents: 54_900_000, keyDate: { label: "Conditions due", date: "2026-10-30", daysFromToday: 12 },
        deposit: { state: "DUE", tone: "neutral", label: "Deposit due Oct 20", detail: "$25,000 expected", expectedCents: 2_500_000, receivedCents: 0 } }),
    ],
    FIRM: [
      card({ address: "22 Main St E", city: "Grimsby", agentName: "Priya Shah", priceCents: 92_000_000, keyDate: { label: "Closing", date: "2026-10-21", daysFromToday: 3 },
        deposit: { state: "LATE_TO_TRUST", tone: "critical", label: "Deposited late to trust", detail: "Received Sep 29, banked Oct 8: 7 business days (limit 5)", expectedCents: 4_600_000, receivedCents: 4_600_000 } }),
      card({ address: "1205 – 88 Queens Quay W", city: "Toronto", agentName: "Jane Smith", priceCents: 110_000_000, keyDate: { label: "Closing", date: "2026-11-30", daysFromToday: 43 },
        deposit: cleared(55_000, 1042) }),
      card({ side: "BUYER", address: "1450 Dundas St W", city: "Mississauga", agentName: "Omar Haddad", priceCents: 117_500_000, keyDate: { label: "Closing", date: "2026-12-04", daysFromToday: 47 },
        deposit: { state: "HELD_ELSEWHERE", tone: "neutral", label: "Held by co-op brokerage", detail: "$50,000 deposit is not in our trust account", expectedCents: 5_000_000, receivedCents: 0 } }),
    ],
    CLOSED: [
      card({ address: "8 Barton St", city: "Hamilton", agentName: "Omar Haddad", priceCents: 69_900_000, keyDate: { label: "Closed", date: "2026-10-15", daysFromToday: -3 },
        deposit: cleared(35_000, 1033), finalized: true }),
      card({ side: "BUYER", address: "56 Ontario St", city: "Grimsby", agentName: "Priya Shah", priceCents: 83_000_000, keyDate: { label: "Closed", date: "2026-10-02", daysFromToday: -16 },
        deposit: { state: "HELD_ELSEWHERE", tone: "neutral", label: "Held by co-op brokerage", detail: "$40,000 deposit is not in our trust account", expectedCents: 4_000_000, receivedCents: 0 }, finalized: true }),
    ],
  },
};
