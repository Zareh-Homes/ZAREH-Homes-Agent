/**
 * Dashboard numbers, by role. Money is integer cents (fields end in `Cents`),
 * dates are YYYY-MM-DD in Toronto time, "YTD" is the calendar year to date.
 *
 *   brokerage  – ADMIN, MANAGING_BROKER, COMPLIANCE_ADMIN
 *   personal   – AGENT, MANAGING_BROKER (brokers often sell too)
 *
 * Financial figures come from finalized closings (the frozen CDA numbers), so
 * the dashboard and the CDAs can never disagree.
 */

import type { PrismaClient, UserRole } from "@prisma/client";
import type { Actor } from "../auth.ts";
import { reconciliationStatus, type AccountReconStatus } from "../bank/service.ts";
import { capYearStart } from "../closing/service.ts";
import { todayInToronto } from "../lib/dates.ts";
import { numericToCents } from "../lib/money.ts";

export const COMPLIANCE_WINDOW_DAYS = 14;

const BROKERAGE_ROLES: readonly UserRole[] = ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"];
const PERSONAL_ROLES: readonly UserRole[] = ["AGENT", "MANAGING_BROKER"];

export interface DealRef {
  id: string;
  dealNumber: string;
  address: string;
  closeDate: string;
}

export interface BrokerageDashboard {
  financials: {
    companyDollarCents: number; // brokerage's share net of HST, after agent payouts and outside referrals
    closedVolumeCents: number;
    closedDeals: number;
    hstCollectedCents: number; // on commissions invoiced
    netHstEstimateCents: number; // charged on GCI and fees − paid to agents and referrals; not the HST return, other ITCs apply
    finalizedClosings: number;
  };
  trust: {
    totalCents: number;
    accounts: { id: string; name: string; bankName: string; accountLast4: string; balanceCents: number }[];
    pastClosing: (DealRef & { balanceCents: number; daysPastClose: number; status: string; onHold: boolean })[];
    unclearedCents: number; // deposits recorded in the ledger, not yet matched to a bank statement
    reconciliations: AccountReconStatus[];
  };
  complianceQueue: (DealRef & {
    daysToClose: number; // negative = past its closing date and still not closed
    primaryAgent: string | null;
    missing: { document: string; party: string | null; status: string }[];
  })[];
}

export interface PersonalDashboard {
  volumeCents: number;
  closedDeals: number;
  grossGciCents: number; // your share of GCI, before split, excl. HST
  netPayoutsCents: number; // incl. HST, after fees
  prec: null | {
    legalName: string;
    hstNumber: string | null;
    hstReceivedCents: number;
    commissionIncomeCents: number; // net of fees, excl. HST
  };
  cap: null | {
    capCents: number;
    paidCents: number;
    yearStart: string;
    yearEnd: string; // exclusive
  };
  needsRevision: (DealRef & {
    slotId: string;
    document: string;
    party: string | null;
    comment: string;
    reviewer: string | null;
    reviewedAt: string | null;
  })[];
}

export interface DashboardResponse {
  viewer: { id: string; name: string; role: UserRole; isPrec: boolean };
  period: { year: number; today: string };
  brokerage: BrokerageDashboard | null;
  personal: PersonalDashboard | null;
}

/** NUMERIC dollars from a money column ("27500.00") to cents. */
const toCents = (text: string | null) => (text ? numericToCents(text) : 0);
/** Sums of values that are already cents (closing computation JSON). */
const centsSum = (text: string) => Number(BigInt(text));
const address = (street: string, unit: string | null, city: string) => `${unit ? `${unit} – ` : ""}${street}, ${city}`;
const nextYear = (date: string) => `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`;

// ── Brokerage ────────────────────────────────────────────────────────────────

async function brokerageDashboard(db: PrismaClient, today: string): Promise<BrokerageDashboard> {
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const yearEnd = nextYear(yearStart);

  const [money] = await db.$queryRaw<{ companyDollar: string; netHst: string; hstCollected: string; n: number }[]>`
    SELECT COALESCE(SUM((c.computation #>> '{brokerage,netEarnedShare,base}')::bigint
                        - COALESCE((c.computation #>> '{brokerage,referral,base}')::bigint, 0)), 0)::text AS "companyDollar",
           COALESCE(SUM(COALESCE(c.computation #>> '{brokerage,netHstEstimate}', c.computation #>> '{brokerage,hstRemittance}')::bigint), 0)::text AS "netHst",
           COALESCE(SUM((c.computation #>> '{incoming,commission,hst}')::bigint), 0)::text AS "hstCollected",
           COUNT(*)::int AS n
      FROM "ClosingStatement" c JOIN "Transaction" t ON t.id = c."transactionId"
     WHERE t."closeDate" >= ${yearStart}::date AND t."closeDate" < ${yearEnd}::date
       AND NOT EXISTS (SELECT 1 FROM "ClosingVoid" v WHERE v."closingId" = c.id)`;

  const [uncleared] = await db.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM(d.amount), 0)::text AS total
      FROM "TrustLedgerEntry" d JOIN "TrustAccount" a ON a.id = d."trustAccountId"
     WHERE a."isActive" AND d."entryType" = 'DEPOSIT_RECEIVED'
       AND NOT trust_entry_cleared(d.id)
       AND NOT EXISTS (SELECT 1 FROM "TrustLedgerEntry" r WHERE r."reversesEntryId" = d.id)`;

  const [volume] = await db.$queryRaw<{ total: string; n: number }[]>`
    SELECT COALESCE(SUM("salePrice"), 0)::text AS total, COUNT(*)::int AS n FROM "Transaction"
     WHERE status = 'CLOSED' AND "closeDate" >= ${yearStart}::date AND "closeDate" < ${yearEnd}::date`;

  const accounts = await db.$queryRaw<{ id: string; name: string; bankName: string; accountLast4: string; balance: string }[]>`
    SELECT a.id, a.name, a."bankName", a."accountLast4", COALESCE(SUM(e.amount * e.direction), 0)::text AS balance
      FROM "TrustAccount" a LEFT JOIN "TrustLedgerEntry" e ON e."trustAccountId" = a.id
     WHERE a."isActive"
     GROUP BY a.id ORDER BY a.name`;

  const pastClosing = await db.$queryRaw<{
    id: string; dealNumber: string; streetAddress: string; unit: string | null; city: string;
    closeDate: string; status: string; balance: string; daysPastClose: number; onHold: boolean;
  }[]>`
    SELECT t.id, t."dealNumber", t."streetAddress", t.unit, t.city, to_char(t."closeDate", 'YYYY-MM-DD') AS "closeDate",
           t.status::text AS status, b.balance::text AS balance, (${today}::date - t."closeDate")::int AS "daysPastClose",
           EXISTS (SELECT 1 FROM "TrustHold" h WHERE h."transactionId" = t.id AND h."releasedAt" IS NULL) AS "onHold"
      FROM (SELECT "transactionId", SUM(amount * direction) AS balance FROM "TrustLedgerEntry"
             GROUP BY "transactionId" HAVING SUM(amount * direction) <> 0) b
      JOIN "Transaction" t ON t.id = b."transactionId"
     WHERE t."closeDate" < ${today}::date
     ORDER BY t."closeDate", t."dealNumber"`;

  // Firm deals closing within the window (or already past it) without full FINTRAC approval
  const queue = await db.$queryRaw<{
    id: string; dealNumber: string; streetAddress: string; unit: string | null; city: string; closeDate: string;
    daysToClose: number; primaryAgent: string | null;
    missing: { document: string; party: string | null; status: string }[] | null; fintracSlots: number;
  }[]>`
    SELECT t.id, t."dealNumber", t."streetAddress", t.unit, t.city, to_char(t."closeDate", 'YYYY-MM-DD') AS "closeDate",
           (t."closeDate" - ${today}::date)::int AS "daysToClose",
           (SELECT u."firstName" || ' ' || u."lastName" FROM "TransactionAgent" ta JOIN "User" u ON u.id = ta."userId"
             WHERE ta."transactionId" = t.id ORDER BY (ta.role = 'PRIMARY') DESC LIMIT 1) AS "primaryAgent",
           (SELECT json_agg(json_build_object('document', dt.name, 'party', p."fullName", 'status', s.status::text)
                            ORDER BY dt."sortOrder", p."fullName")
              FROM "DocumentSlot" s JOIN "DocumentType" dt ON dt.id = s."documentTypeId"
              LEFT JOIN "TransactionParty" p ON p.id = s."partyId"
             WHERE s."transactionId" = t.id AND dt."metadataKind" <> 'NONE' AND s.status <> 'APPROVED') AS missing,
           (SELECT COUNT(*)::int FROM "DocumentSlot" s JOIN "DocumentType" dt ON dt.id = s."documentTypeId"
             WHERE s."transactionId" = t.id AND dt."metadataKind" <> 'NONE') AS "fintracSlots"
      FROM "Transaction" t
     WHERE t.status = 'FIRM' AND t."closeDate" <= ${today}::date + ${COMPLIANCE_WINDOW_DAYS}::int
     ORDER BY t."closeDate", t."dealNumber"`;

  return {
    financials: {
      companyDollarCents: centsSum(money!.companyDollar),
      closedVolumeCents: toCents(volume!.total),
      closedDeals: volume!.n,
      hstCollectedCents: centsSum(money!.hstCollected),
      netHstEstimateCents: centsSum(money!.netHst),
      finalizedClosings: money!.n,
    },
    trust: {
      totalCents: accounts.reduce((s, a) => s + toCents(a.balance), 0),
      accounts: accounts.map(({ balance, ...a }) => ({ ...a, balanceCents: toCents(balance) })),
      pastClosing: pastClosing.map((d) => ({
        id: d.id, dealNumber: d.dealNumber, address: address(d.streetAddress, d.unit, d.city), closeDate: d.closeDate,
        status: d.status, balanceCents: toCents(d.balance), daysPastClose: d.daysPastClose, onHold: d.onHold,
      })),
      unclearedCents: toCents(uncleared!.total),
      reconciliations: await reconciliationStatus(db, today),
    },
    complianceQueue: queue
      .filter((d) => d.fintracSlots === 0 || (d.missing?.length ?? 0) > 0)
      .map((d) => ({
        id: d.id, dealNumber: d.dealNumber, address: address(d.streetAddress, d.unit, d.city), closeDate: d.closeDate,
        daysToClose: d.daysToClose, primaryAgent: d.primaryAgent,
        missing: d.fintracSlots === 0
          ? [{ document: "FINTRAC records", party: null, status: "NOT_SET_UP" }]
          : d.missing!,
      })),
  };
}

// ── Personal ─────────────────────────────────────────────────────────────────

async function personalDashboard(db: PrismaClient, userId: string, today: string): Promise<PersonalDashboard> {
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const yearEnd = nextYear(yearStart);

  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { isPrec: true, precLegalName: true, hstNumber: true },
  });

  const [volume] = await db.$queryRaw<{ total: string; n: number }[]>`
    SELECT COALESCE(ROUND(SUM(t."salePrice" * ta."gciSharePct" / 100), 2), 0)::text AS total, COUNT(*)::int AS n
      FROM "Transaction" t JOIN "TransactionAgent" ta ON ta."transactionId" = t.id
     WHERE ta."userId" = ${userId}::uuid AND t.status = 'CLOSED'
       AND t."closeDate" >= ${yearStart}::date AND t."closeDate" < ${yearEnd}::date`;

  const [paid] = await db.$queryRaw<{ gci: string; net: string; hst: string; income: string }[]>`
    SELECT COALESCE(SUM("allocatedBaseGci"), 0)::text AS gci,
           COALESCE(SUM("netPayout"), 0)::text AS net,
           COALESCE(SUM("agentSplitHst" - "feesHst"), 0)::text AS hst,
           COALESCE(SUM("agentSplitBase" - "feesBase"), 0)::text AS income
      FROM "ClosingAgentPayout" p
     WHERE "userId" = ${userId}::uuid AND "closeDate" >= ${yearStart}::date AND "closeDate" < ${yearEnd}::date
       AND NOT EXISTS (SELECT 1 FROM "ClosingVoid" v WHERE v."closingId" = p."closingId")`;

  let cap: PersonalDashboard["cap"] = null;
  // The plan in force today (migration 014)
  const [plan] = await db.$queryRaw<{ annualCap: string | null; capYearStartMonth: number; capYearStartDay: number }[]>`
    SELECT (p)."annualCap"::text AS "annualCap", (p)."capYearStartMonth" AS "capYearStartMonth", (p)."capYearStartDay" AS "capYearStartDay"
      FROM (SELECT plan_in_force(${userId}::uuid, ${today}::date) AS p) x WHERE (p).id IS NOT NULL`;
  if (plan?.annualCap) {
    const start = capYearStart(today, plan.capYearStartMonth, plan.capYearStartDay);
    const [row] = await db.$queryRaw<{ total: string }[]>`
      SELECT COALESCE(SUM("houseSplitBase"), 0)::text AS total FROM "ClosingAgentPayout" p
       WHERE "userId" = ${userId}::uuid AND "closeDate" >= ${start}::date AND "closeDate" < ${nextYear(start)}::date
         AND NOT EXISTS (SELECT 1 FROM "ClosingVoid" v WHERE v."closingId" = p."closingId")`;
    cap = { capCents: toCents(plan.annualCap), paidCents: toCents(row!.total), yearStart: start, yearEnd: nextYear(start) };
  }

  // Sent back by a reviewer, on deals that are still being worked
  const revisions = await db.$queryRaw<{
    slotId: string; id: string; dealNumber: string; streetAddress: string; unit: string | null; city: string;
    closeDate: string; document: string; party: string | null; comment: string; reviewer: string | null; reviewedAt: string | null;
  }[]>`
    SELECT s.id AS "slotId", t.id, t."dealNumber", t."streetAddress", t.unit, t.city,
           to_char(t."closeDate", 'YYYY-MM-DD') AS "closeDate", dt.name AS document, p."fullName" AS party,
           s."reviewComment" AS comment, r."firstName" || ' ' || r."lastName" AS reviewer,
           to_char(s."reviewedAt" AT TIME ZONE 'America/Toronto', 'YYYY-MM-DD') AS "reviewedAt"
      FROM "DocumentSlot" s
      JOIN "Transaction" t ON t.id = s."transactionId"
      JOIN "TransactionAgent" ta ON ta."transactionId" = t.id AND ta."userId" = ${userId}::uuid
      JOIN "DocumentType" dt ON dt.id = s."documentTypeId"
      LEFT JOIN "TransactionParty" p ON p.id = s."partyId"
      LEFT JOIN "User" r ON r.id = s."reviewerId"
     WHERE s.status = 'NEEDS_REVISION' AND t.status IN ('CONDITIONAL', 'FIRM', 'CLOSED')
       AND NOT EXISTS (SELECT 1 FROM "ClosingStatement" c WHERE c."transactionId" = t.id)
     ORDER BY t."closeDate", dt."sortOrder"`;

  return {
    volumeCents: toCents(volume!.total),
    closedDeals: volume!.n,
    grossGciCents: toCents(paid!.gci),
    netPayoutsCents: toCents(paid!.net),
    prec: user.isPrec
      ? {
          legalName: user.precLegalName ?? "",
          hstNumber: user.hstNumber,
          hstReceivedCents: toCents(paid!.hst),
          commissionIncomeCents: toCents(paid!.income),
        }
      : null,
    cap,
    needsRevision: revisions.map(({ streetAddress, unit, city, ...r }) => ({ ...r, address: address(streetAddress, unit, city) })),
  };
}

export async function getDashboard(db: PrismaClient, actor: Actor, today = todayInToronto()): Promise<DashboardResponse> {
  const user = await db.user.findUniqueOrThrow({ where: { id: actor.id }, select: { firstName: true, lastName: true, isPrec: true } });
  return {
    viewer: { id: actor.id, name: `${user.firstName} ${user.lastName}`, role: actor.role, isPrec: user.isPrec },
    period: { year: Number(today.slice(0, 4)), today },
    brokerage: BROKERAGE_ROLES.includes(actor.role) ? await brokerageDashboard(db, today) : null,
    personal: PERSONAL_ROLES.includes(actor.role) ? await personalDashboard(db, actor.id, today) : null,
  };
}
