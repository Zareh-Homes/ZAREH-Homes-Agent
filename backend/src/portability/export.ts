/**
 * Exports: every record the brokerage keeps, as spreadsheets (CSV) or one full backup file (JSON).
 *
 *   agents, deals, parties, trust-ledger, cdas, payouts, commission-receipts, documents   one CSV each
 *   full                                                                                  every table, as JSON
 *
 * Admins and managing brokers only, and every export is in the audit log. Home address, date of birth and payout
 * banking are left out of the agents CSV unless includePersonal=true is asked for (also logged). The full backup
 * keeps those fields encrypted, exactly as stored, so it restores with the same FIELD_ENCRYPTION_KEY; it leaves out
 * passwords, sessions and sign-in links, and the document files themselves (they're in the file store's own backup).
 *
 * Spreadsheet safety: a cell that starts with = + - @ is prefixed with ' so Excel never runs it as a formula.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, type Actor, type ResolveUserId } from "../auth.ts";
import { NotFoundError } from "../errors.ts";
import { todayInToronto } from "../lib/dates.ts";
import type { FieldCipher } from "../security/crypto.ts";
import { audit } from "../security/audit.ts";

const EXPORTERS = ["ADMIN", "MANAGING_BROKER"] as const;
type Row = Record<string, unknown>;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Row[], columns?: string[]): string {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

const DATASETS = {
  async agents(prisma: PrismaClient, cipher: FieldCipher, personal: boolean, today: string): Promise<Row[]> {
    const users = await prisma.user.findMany({ where: { role: { in: ["AGENT", "MANAGING_BROKER"] } }, include: { agentProfile: true },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }] });
    const plans = await prisma.$queryRaw<{ userId: string; splitBps: number | null; annualCap: string | null; standardPlan: string | null }[]>`
      SELECT u.id::text AS "userId", (p)."splitBps", (p)."annualCap"::text AS "annualCap", t.name AS "standardPlan"
        FROM "User" u CROSS JOIN LATERAL (SELECT plan_in_force(u.id, ${today}::date) AS p) x
        LEFT JOIN "CommissionPlanTemplate" t ON t.id = (p)."templateId"`;
    const plan = new Map(plans.map((p) => [p.userId, p]));
    // A field sealed under another key (e.g. a restored backup with a rotated key) is reported, not fatal
    const open = (v: string) => { try { return cipher.decrypt(v); } catch { return "(can't be decrypted with this server's key)"; } };
    return users.map((u) => {
      const p = u.agentProfile;
      let bank: Record<string, string> | null = null;
      try { bank = personal && p?.payoutBankingEnc ? JSON.parse(cipher.decrypt(p.payoutBankingEnc)) as Record<string, string> : null; } catch { bank = null; }
      const pl = plan.get(u.id);
      return {
        firstName: u.firstName, lastName: u.lastName, email: u.email, phone: u.phone, role: u.role, active: u.isActive,
        recoRegistrationNo: u.recoRegistrationNo, recoExpiryDate: p?.recoExpiryDate.toISOString().slice(0, 10) ?? null,
        startDate: p?.startDate.toISOString().slice(0, 10) ?? null, hstNumber: u.hstNumber, precLegalName: u.isPrec ? u.precLegalName : null,
        splitPct: pl?.splitBps != null ? pl.splitBps / 100 : null, annualCap: pl?.annualCap ?? null, standardPlan: pl?.standardPlan ?? null,
        eoInsurer: p?.eoInsurer ?? null, eoPolicyNumber: p?.eoPolicyNumber ?? null, eoExpiryDate: p?.eoExpiryDate?.toISOString().slice(0, 10) ?? null,
        emergencyContactName: p?.emergencyContactName ?? null, emergencyContactPhone: p?.emergencyContactPhone ?? null,
        billingMethod: p?.billingMethod ?? null, billingNote: p?.billingNote ?? null,
        ...(personal ? {
          address: p ? open(p.addressEnc) : null, dateOfBirth: p ? open(p.dateOfBirthEnc) : null,
          bankAccountHolder: bank?.accountHolder ?? null, bankInstitution: bank?.institutionNumber ?? null,
          bankTransit: bank?.transitNumber ?? null, bankAccount: bank?.accountNumber ?? null,
        } : {}),
      };
    });
  },

  async deals(prisma: PrismaClient): Promise<Row[]> {
    return prisma.$queryRaw<Row[]>`
      SELECT t."dealNumber", t.side::text, t.status::text, t."streetAddress", t.unit, t.city, t.province, t."mlsNumber",
             t."salePrice"::text, to_char(t."offerDate", 'YYYY-MM-DD') AS "offerDate", to_char(t."conditionsDueDate", 'YYYY-MM-DD') AS "conditionsDueDate",
             to_char(t."closeDate", 'YYYY-MM-DD') AS "closeDate", t."depositAmount"::text, to_char(t."depositDueDate", 'YYYY-MM-DD') AS "depositDueDate",
             t."trustDepositHolder"::text AS "depositHolder", t."totalGci"::text, t."listingSideGci"::text, t."buyerSideGci"::text,
             t."buyerSideSellerPays"::text, t."remunerationSource", t."coopBrokerageName", t."coopCommission"::text,
             t."outsideReferralPayee", t."outsideReferralPct"::text,
             (SELECT string_agg(u."firstName" || ' ' || u."lastName" || ' (' || a.role::text || COALESCE(', ' || a.side::text, '') || ', split ' || a."splitPct"::text
                     || '%, share ' || a."gciSharePct"::text || '%)', '; ' ORDER BY a.role) FROM "TransactionAgent" a JOIN "User" u ON u.id = a."userId"
               WHERE a."transactionId" = t.id) AS agents,
             (SELECT string_agg(p."fullName", '; ') FROM "TransactionParty" p WHERE p."transactionId" = t.id AND p.role IN ('SELLER', 'LANDLORD')) AS sellers,
             (SELECT string_agg(p."fullName", '; ') FROM "TransactionParty" p WHERE p."transactionId" = t.id AND p.role IN ('BUYER', 'TENANT')) AS buyers,
             (SELECT COALESCE(SUM(e.amount * e.direction), 0)::text FROM "TrustLedgerEntry" e WHERE e."transactionId" = t.id) AS "trustBalance"
        FROM "Transaction" t ORDER BY t."dealNumber"`;
  },

  async parties(prisma: PrismaClient): Promise<Row[]> {
    return prisma.$queryRaw<Row[]>`
      SELECT t."dealNumber", p.role::text, p."fullName", p."entityType"::text, p.email, p.phone, p.representation::text
        FROM "TransactionParty" p JOIN "Transaction" t ON t.id = p."transactionId" ORDER BY t."dealNumber", p.role, p."fullName"`;
  },

  async "trust-ledger"(prisma: PrismaClient): Promise<Row[]> {
    return prisma.$queryRaw<Row[]>`
      SELECT a.name AS "trustAccount", t."dealNumber", e."receiptNumber", e."entryType"::text, e.direction, e.amount::text, e.method::text,
             e.counterparty, e."referenceNo", to_char(e."receivedDate", 'YYYY-MM-DD') AS "receivedDate",
             to_char(e."effectiveDate", 'YYYY-MM-DD') AS "effectiveDate", e."authorizationMethod"::text, e."authorizationReference", e.memo,
             r."receiptNumber" AS "reversesReceipt", e."createdAt"
        FROM "TrustLedgerEntry" e JOIN "TrustAccount" a ON a.id = e."trustAccountId" JOIN "Transaction" t ON t.id = e."transactionId"
        LEFT JOIN "TrustLedgerEntry" r ON r.id = e."reversesEntryId"
       ORDER BY e."createdAt"`;
  },

  async cdas(prisma: PrismaClient): Promise<Row[]> {
    return prisma.$queryRaw<Row[]>`
      SELECT t."dealNumber", c."cdaNumber", c.revision, c."finalizedAt",
             (c.computation -> 'incoming' -> 'commission' ->> 'base') AS "commissionBaseCents",
             (c.computation -> 'incoming' -> 'commission' ->> 'hst') AS "commissionHstCents",
             (c.computation -> 'incoming' ->> 'totalPayable') AS "totalPayableCents",
             EXISTS (SELECT 1 FROM "ClosingVoid" v WHERE v."closingId" = c.id) AS voided, c."computationSha"
        FROM "ClosingStatement" c JOIN "Transaction" t ON t.id = c."transactionId" ORDER BY c."finalizedAt"`;
  },

  async payouts(prisma: PrismaClient): Promise<Row[]> {
    return prisma.$queryRaw<Row[]>`
      SELECT t."dealNumber", c."cdaNumber", p."payeeName", to_char(p."closeDate", 'YYYY-MM-DD') AS "closeDate", p."allocatedBaseGci"::text,
             p."agentSplitBase"::text, p."agentSplitHst"::text, p."feesBase"::text, p."feesHst"::text, p."netPayout"::text, p."carriedForward"::text,
             (SELECT e.kind::text FROM "PayoutEvent" e WHERE e."payoutId" = p.id ORDER BY e.seq DESC LIMIT 1) AS "latestStatus",
             (SELECT to_char(e."eventDate", 'YYYY-MM-DD') FROM "PayoutEvent" e WHERE e."payoutId" = p.id AND e.kind = 'PAID' ORDER BY e.seq DESC LIMIT 1) AS "paidOn",
             (SELECT e.reference FROM "PayoutEvent" e WHERE e."payoutId" = p.id AND e.kind = 'PAID' ORDER BY e.seq DESC LIMIT 1) AS "paymentReference"
        FROM "ClosingAgentPayout" p JOIN "ClosingStatement" c ON c.id = p."closingId" JOIN "Transaction" t ON t.id = c."transactionId"
       ORDER BY p."closeDate", t."dealNumber"`;
  },

  async "commission-receipts"(prisma: PrismaClient): Promise<Row[]> {
    return prisma.$queryRaw<Row[]>`
      SELECT t."dealNumber", c."cdaNumber", r.amount::text, to_char(r."receivedDate", 'YYYY-MM-DD') AS "receivedDate", r.reference,
             CASE WHEN r."trustAccountId" IS NOT NULL THEN 'COMMISSION_TRUST' ELSE 'OPERATING' END AS "account",
             EXISTS (SELECT 1 FROM "CommissionReceiptReversal" x WHERE x."receiptId" = r.id) AS reversed, r."recordedAt"
        FROM "CommissionReceipt" r JOIN "ClosingStatement" c ON c.id = r."closingId" JOIN "Transaction" t ON t.id = c."transactionId"
       ORDER BY r."receivedDate"`;
  },

  async documents(prisma: PrismaClient): Promise<Row[]> {
    return prisma.$queryRaw<Row[]>`
      SELECT t."dealNumber", d.name AS document, p."fullName" AS party, s.status::text, s."reviewComment",
             (SELECT f."fileName" FROM "DocumentFile" f WHERE f."slotId" = s.id ORDER BY f.version DESC LIMIT 1) AS "latestFile",
             (SELECT f."uploadedAt" FROM "DocumentFile" f WHERE f."slotId" = s.id ORDER BY f.version DESC LIMIT 1) AS "uploadedAt",
             s."reviewedAt"
        FROM "DocumentSlot" s JOIN "DocumentType" d ON d.id = s."documentTypeId" JOIN "Transaction" t ON t.id = s."transactionId"
        LEFT JOIN "TransactionParty" p ON p.id = s."partyId"
       ORDER BY t."dealNumber", d."sortOrder", p."fullName" NULLS FIRST`;
  },
} as const;

export type Dataset = keyof typeof DATASETS;
export const DATASET_NAMES = Object.keys(DATASETS) as Dataset[];

/** Tables left out of the full backup: sign-in secrets and short-lived tokens */
const NOT_IN_BACKUP = new Set(["UserCredential", "Session", "AuthToken", "_prisma_migrations", "SchemaMigration"]);

export async function fullBackup(prisma: PrismaClient): Promise<Record<string, unknown>> {
  const tables = await prisma.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const out: Record<string, unknown> = {};
  for (const { name } of tables) {
    if (NOT_IN_BACKUP.has(name)) continue;
    // Table names come from the catalogue, quoted as identifiers
    out[name] = await prisma.$queryRawUnsafe<Row[]>(`SELECT * FROM "${name.replace(/"/g, '""')}"`);
  }
  return out;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 0);

export async function exportRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; fieldCipher: FieldCipher; today?: () => string }) {
  const actorOf = async (req: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(req));
  const today = () => opts.today?.() ?? todayInToronto();
  const logged = (actor: Actor, req: FastifyRequest, what: string, extra: Record<string, unknown> = {}) =>
    audit(opts.prisma, { userId: actor.id, entity: "Export", entityId: what, action: "DATA_EXPORTED", outcome: "SUCCESS", changes: extra,
      ip: req.ip, userAgent: req.headers["user-agent"] ?? null });
  const download = (reply: FastifyReply, name: string, type: string, body: string) =>
    reply.header("content-type", type).header("content-disposition", `attachment; filename="${name}"`).header("cache-control", "no-store").send(body);

  app.get("/api/exports", async (req) => {
    requireRole(await actorOf(req), EXPORTERS, "Exporting data");
    return { datasets: DATASET_NAMES, full: "/api/exports/full.json" };
  });
  app.get<{ Params: { name: string }; Querystring: { includePersonal?: string } }>("/api/exports/:name", async (req, reply) => {
    const actor = await actorOf(req);
    requireRole(actor, EXPORTERS, "Exporting data");
    const stamp = today();
    if (req.params.name === "full.json") {
      await logged(actor, req, "full");
      return download(reply, `zareh-backup-${stamp}.json`, "application/json",
        json({ exportedAt: new Date().toISOString(), note: "Encrypted fields stay encrypted; restore with the same FIELD_ENCRYPTION_KEY", tables: await fullBackup(opts.prisma) }));
    }
    const name = req.params.name.replace(/\.csv$/, "") as Dataset;
    if (!DATASET_NAMES.includes(name)) throw new NotFoundError("Export", req.params.name);
    const personal = name === "agents" && req.query.includePersonal === "true";
    const rows = name === "agents" ? await DATASETS.agents(opts.prisma, opts.fieldCipher, personal, stamp) : await DATASETS[name](opts.prisma);
    await logged(actor, req, name, { rows: rows.length, ...(personal ? { includePersonal: true } : {}) });
    return download(reply, `zareh-${name}-${stamp}.csv`, "text/csv; charset=utf-8", "﻿" + toCsv(rows));
  });
}
