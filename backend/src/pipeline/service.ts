/**
 * Deal pipeline: four columns following an Ontario trade.
 *
 *   ACTIVE       listings on the market (Listing.status = ACTIVE)
 *   CONDITIONAL  accepted offers waiting on conditions (Transaction.status = CONDITIONAL)
 *   FIRM         conditions fulfilled or waived, waiting for completion (FIRM)
 *   CLOSED       completed this calendar month, Toronto time (CLOSED)
 *
 * Agents see their own listings and deals; staff and the managing broker see
 * everything. Columns follow each record's status: the board doesn't move
 * deals, because going firm or closing needs paperwork behind it.
 */

import type { PrismaClient, UserRole } from "@prisma/client";
import type { Actor } from "../auth.ts";
import { todayInToronto } from "../lib/dates.ts";
import { numericToCents } from "../lib/money.ts";
import { depositStatus, type DepositBadge } from "./deposit-status.ts";
import { loadBusinessCalendar } from "../lib/calendar-store.ts";

const SEE_ALL: readonly UserRole[] = ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"];

export type ColumnKey = "ACTIVE" | "CONDITIONAL" | "FIRM" | "CLOSED";

export interface PipelineCard {
  id: string;
  kind: "LISTING" | "DEAL";
  href: string;
  dealNumber: string | null;
  side: string | null;
  address: string;
  city: string;
  mlsNumber: string | null;
  agentName: string | null;
  priceCents: number;
  priceLabel: "List price" | "Sale price";
  keyDate: { label: string; date: string; daysFromToday: number } | null;
  deposit: DepositBadge | null;
  finalized: boolean; // closing statement / CDA issued
}

export interface PipelineResponse {
  today: string;
  month: string; // YYYY-MM for the Closed column
  scope: "ALL" | "MINE";
  columns: Record<ColumnKey, PipelineCard[]>;
}

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

interface DealRow {
  id: string;
  dealNumber: string;
  side: string;
  status: "CONDITIONAL" | "FIRM" | "CLOSED";
  streetAddress: string;
  unit: string | null;
  city: string;
  mlsNumber: string | null;
  salePrice: string;
  conditionsDueDate: string | null;
  closeDate: string;
  depositAmount: string;
  depositDueDate: string | null;
  trustDepositHolder: "OUR_BROKERAGE" | "COOP_BROKERAGE" | "LAWYER" | "BUILDER";
  agentName: string | null;
  finalized: boolean;
  deposits: { amount: string; receivedDate: string; depositedDate: string; receiptNumber: number | null; bankCleared: boolean }[] | null;
}

export async function getPipeline(db: PrismaClient, actor: Actor, today = todayInToronto()): Promise<PipelineResponse> {
  const calendar = await loadBusinessCalendar(db);
  const all = SEE_ALL.includes(actor.role);
  const mine = all ? null : actor.id;
  const month = today.slice(0, 7);
  const monthStart = `${month}-01`;
  const monthEnd = `${nextMonth(month)}-01`;

  const listings = await db.$queryRaw<{
    id: string; mlsNumber: string | null; streetAddress: string; unit: string | null; city: string;
    listPrice: string; listingDate: string; agentName: string;
  }[]>`
    SELECT l.id, l."mlsNumber", l."streetAddress", l.unit, l.city, l."listPrice"::text AS "listPrice",
           to_char(l."listingDate", 'YYYY-MM-DD') AS "listingDate", u."firstName" || ' ' || u."lastName" AS "agentName"
      FROM "Listing" l JOIN "User" u ON u.id = l."listingAgentId"
     WHERE l.status = 'ACTIVE' AND (${mine}::uuid IS NULL OR l."listingAgentId" = ${mine}::uuid)
     ORDER BY l."listingDate" DESC, l."streetAddress"`;

  const deals = await db.$queryRaw<DealRow[]>`
    SELECT t.id, t."dealNumber", t.side::text AS side, t.status::text AS status, t."streetAddress", t.unit, t.city,
           t."mlsNumber", t."salePrice"::text AS "salePrice",
           to_char(t."conditionsDueDate", 'YYYY-MM-DD') AS "conditionsDueDate",
           to_char(t."closeDate", 'YYYY-MM-DD') AS "closeDate",
           t."depositAmount"::text AS "depositAmount", to_char(t."depositDueDate", 'YYYY-MM-DD') AS "depositDueDate",
           t."trustDepositHolder"::text AS "trustDepositHolder",
           (SELECT u."firstName" || ' ' || u."lastName" FROM "TransactionAgent" ta JOIN "User" u ON u.id = ta."userId"
             WHERE ta."transactionId" = t.id ORDER BY (ta.role = 'PRIMARY') DESC, u."lastName" LIMIT 1) AS "agentName",
           EXISTS (SELECT 1 FROM "ClosingStatement" c WHERE c."transactionId" = t.id) AS finalized,
           (SELECT json_agg(json_build_object(
                     'amount', d.amount::text,
                     'receivedDate', to_char(d."receivedDate", 'YYYY-MM-DD'),
                     'depositedDate', to_char(d."effectiveDate", 'YYYY-MM-DD'),
                     'receiptNumber', d."receiptNumber",
                     'bankCleared', trust_entry_cleared(d.id)) ORDER BY d."createdAt")
              FROM "TrustLedgerEntry" d
             WHERE d."transactionId" = t.id AND d."entryType" = 'DEPOSIT_RECEIVED'
               AND NOT EXISTS (SELECT 1 FROM "TrustLedgerEntry" r WHERE r."reversesEntryId" = d.id)) AS deposits
      FROM "Transaction" t
     WHERE (t.status IN ('CONDITIONAL', 'FIRM')
            OR (t.status = 'CLOSED' AND t."closeDate" >= ${monthStart}::date AND t."closeDate" < ${monthEnd}::date))
       AND (${mine}::uuid IS NULL
            OR EXISTS (SELECT 1 FROM "TransactionAgent" ta WHERE ta."transactionId" = t.id AND ta."userId" = ${mine}::uuid))`;

  const dealCard = (d: DealRow): PipelineCard => {
    const keyDate =
      d.status === "CONDITIONAL"
        ? d.conditionsDueDate ? { label: "Conditions due", date: d.conditionsDueDate } : null
        : { label: d.status === "FIRM" ? "Closing" : "Closed", date: d.closeDate };
    return {
      id: d.id,
      kind: "DEAL",
      href: `/deals/${d.id}`,
      dealNumber: d.dealNumber,
      side: d.side,
      address: `${d.unit ? `${d.unit} – ` : ""}${d.streetAddress}`,
      city: d.city,
      mlsNumber: d.mlsNumber,
      agentName: d.agentName,
      priceCents: numericToCents(d.salePrice),
      priceLabel: "Sale price",
      keyDate: keyDate ? { ...keyDate, daysFromToday: daysBetween(today, keyDate.date) } : null,
      deposit: depositStatus({
        holder: d.trustDepositHolder,
        expectedCents: numericToCents(d.depositAmount),
        dueDate: d.depositDueDate,
        deposits: (d.deposits ?? []).map((x) => ({
          amountCents: numericToCents(x.amount),
          receivedDate: x.receivedDate,
          depositedDate: x.depositedDate,
          receiptNumber: x.receiptNumber,
          bankCleared: x.bankCleared,
        })),
        today,
        calendar,
      }),
      finalized: d.finalized,
    };
  };

  const byDate = (dir: 1 | -1) => (a: PipelineCard, b: PipelineCard) =>
    dir * ((a.keyDate?.date ?? "9999").localeCompare(b.keyDate?.date ?? "9999")) || a.address.localeCompare(b.address);

  return {
    today,
    month,
    scope: all ? "ALL" : "MINE",
    columns: {
      ACTIVE: listings.map((l) => ({
        id: l.id,
        kind: "LISTING",
        href: `/listings/${l.id}`,
        dealNumber: null,
        side: null,
        address: `${l.unit ? `${l.unit} – ` : ""}${l.streetAddress}`,
        city: l.city,
        mlsNumber: l.mlsNumber,
        agentName: l.agentName,
        priceCents: numericToCents(l.listPrice),
        priceLabel: "List price",
        keyDate: { label: "Listed", date: l.listingDate, daysFromToday: daysBetween(today, l.listingDate) },
        deposit: null,
        finalized: false,
      })),
      // Soonest deadline first; deals with no condition date go last so they stand out
      CONDITIONAL: deals.filter((d) => d.status === "CONDITIONAL").map(dealCard).sort(byDate(1)),
      FIRM: deals.filter((d) => d.status === "FIRM").map(dealCard).sort(byDate(1)),
      CLOSED: deals.filter((d) => d.status === "CLOSED").map(dealCard).sort(byDate(-1)),
    },
  };
}
