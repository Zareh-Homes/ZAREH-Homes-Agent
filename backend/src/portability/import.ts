/**
 * Imports from a spreadsheet (CSV): agents and deals. Always previewed first: a dry run checks every row with the
 * same rules as the screens and shows what would be added, updated or skipped, and why a row can't be taken. Only
 * then does the admin import, and only the rows that passed are saved. Re-running the same file adds nothing twice.
 *
 *   agents   one row per person; creates the person (they get their invitation link from People) or updates them,
 *            with their agent profile; a "standardPlan" name proposes that plan for them (a second broker approves)
 *   deals    one row per open deal (conditional or firm), up to two agents, the parties and lawyers
 *
 * Closed deals with their trust history come over with the Lone Wolf cutover tool (migration/), which carries the
 * trust ledger through its own controls; this import refuses them rather than create half a history.
 * Column names match the exports, so an export can be edited and imported back. Admins only.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, type Actor, type ResolveUserId } from "../auth.ts";
import { DomainError, ValidationError } from "../errors.ts";
import { Reader } from "../lib/reader.ts";
import { todayInToronto } from "../lib/dates.ts";
import { parseCsv } from "../bank/csv.ts";
import { createDeal, type ComplianceDeps } from "../compliance/service.ts";
import { validateCreateDeal } from "../compliance/validation.ts";
import { audit } from "../security/audit.ts";
import type { FieldCipher } from "../security/crypto.ts";

const MAX_ROWS = 2000;
type Outcome = { row: number; label: string; action: "CREATE" | "UPDATE" | "SKIP" | "ERROR"; detail: string };

/** Header names matched loosely (case, spaces and punctuation ignored), so "First Name" and "firstName" both work */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function readTable(csv: string): { rows: Record<string, string>[] } {
  const grid = parseCsv(csv.replace(/^﻿/, ""));
  const [head, ...body] = grid.filter((r) => r.some((c) => c.trim() !== ""));
  if (!head) throw new ValidationError([{ field: "csv", message: "the file is empty" }]);
  if (body.length > MAX_ROWS) throw new ValidationError([{ field: "csv", message: `at most ${MAX_ROWS} rows at a time` }]);
  const keys = head.map(norm);
  return { rows: body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim().replace(/^'(?=[=+\-@])/, "")]))) };
}

const issuesOf = (err: unknown) =>
  err instanceof ValidationError ? (err.details as { issues: { field: string; message: string }[] }).issues.map((i) => `${i.field} ${i.message}`).join("; ")
    : err instanceof DomainError ? err.message : String((err as Error)?.message ?? err);

// ── Agents ───────────────────────────────────────────────────────────────────

export async function importAgents(prisma: PrismaClient, cipher: FieldCipher, actor: Actor, csv: string, dryRun: boolean, today: string) {
  requireRole(actor, ["ADMIN"], "Importing agents");
  const { rows } = readTable(csv);
  const templates = await prisma.commissionPlanTemplate.findMany({ where: { isActive: true } });
  const seen = new Set<string>();
  const out: Outcome[] = [];
  for (const [i, raw] of rows.entries()) {
    const n = i + 2; // spreadsheet row number (row 1 is the header)
    const g = (k: string) => raw[norm(k)] ?? "";
    const label = `${g("firstName")} ${g("lastName")}`.trim() || g("email") || `row ${n}`;
    try {
      const r = new Reader(Object.fromEntries(Object.entries({
        email: g("email").toLowerCase(), firstName: g("firstName"), lastName: g("lastName"), phone: g("phone"), role: g("role").toUpperCase() || "AGENT",
        recoRegistrationNo: g("recoRegistrationNo"), hstNumber: g("hstNumber"), precLegalName: g("precLegalName"),
        startDate: g("startDate"), recoExpiryDate: g("recoExpiryDate"), address: g("address"), dateOfBirth: g("dateOfBirth"),
        emergencyContactName: g("emergencyContactName"), emergencyContactPhone: g("emergencyContactPhone"),
        eoInsurer: g("eoInsurer"), eoPolicyNumber: g("eoPolicyNumber"), eoExpiryDate: g("eoExpiryDate"), billingMethod: g("billingMethod").toUpperCase(),
        billingNote: g("billingNote"), standardPlan: g("standardPlan"),
      }).filter(([, v]) => v !== "")), ["email", "firstName", "lastName", "phone", "role", "recoRegistrationNo", "hstNumber", "precLegalName",
        "startDate", "recoExpiryDate", "address", "dateOfBirth", "emergencyContactName", "emergencyContactPhone", "eoInsurer", "eoPolicyNumber",
        "eoExpiryDate", "billingMethod", "billingNote", "standardPlan"]);
      const v = {
        email: r.text("email", 320), firstName: r.text("firstName", 100), lastName: r.text("lastName", 100), phone: r.optionalText("phone", 40),
        role: r.oneOf("role", ["AGENT", "MANAGING_BROKER", "COMPLIANCE_ADMIN", "ADMIN"] as const),
        recoRegistrationNo: r.optionalText("recoRegistrationNo", 40), hstNumber: r.optionalText("hstNumber", 40), precLegalName: r.optionalText("precLegalName", 200),
        startDate: r.optionalDate("startDate"), recoExpiryDate: r.optionalDate("recoExpiryDate"), address: r.optionalText("address", 300),
        dateOfBirth: r.optionalPastDate("dateOfBirth", today),
        emergencyContactName: r.optionalText("emergencyContactName", 200), emergencyContactPhone: r.optionalText("emergencyContactPhone", 40),
        eoInsurer: r.optionalText("eoInsurer", 200), eoPolicyNumber: r.optionalText("eoPolicyNumber", 100), eoExpiryDate: r.optionalDate("eoExpiryDate"),
        billingMethod: r.has("billingMethod") ? r.oneOf("billingMethod", ["PRE_AUTHORIZED_DEBIT", "BANK_TRANSFER", "CHEQUE", "DEDUCT_FROM_COMMISSION", "OTHER"] as const) : null,
        billingNote: r.optionalText("billingNote", 500), standardPlan: r.optionalText("standardPlan", 100),
      };
      r.check(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email), "email", "must be an email address");
      const profileGiven = [v.startDate, v.recoExpiryDate, v.address, v.dateOfBirth].some(Boolean);
      const trades = v.role === "AGENT" || v.role === "MANAGING_BROKER";
      if (trades || profileGiven) {
        for (const k of ["startDate", "recoExpiryDate", "address", "dateOfBirth"] as const) r.check(!!v[k], k, "is required for an agent's profile");
      }
      const template = v.standardPlan ? templates.find((t) => t.name.toLowerCase() === v.standardPlan!.toLowerCase()) : null;
      r.check(!v.standardPlan || !!template, "standardPlan", "isn't one of the active standard plans");
      r.check(!seen.has(v.email), "email", "appears twice in this file");
      r.done();
      seen.add(v.email);

      const existing = await prisma.user.findFirst({ where: { email: { equals: v.email, mode: "insensitive" } }, include: { agentProfile: true } });
      if (v.recoRegistrationNo) {
        const holder = await prisma.user.findFirst({ where: { recoRegistrationNo: v.recoRegistrationNo, ...(existing ? { id: { not: existing.id } } : {}) } });
        if (holder) throw new ValidationError([{ field: "recoRegistrationNo", message: `${v.recoRegistrationNo} is already on file for ${holder.firstName} ${holder.lastName}` }]);
      }
      const action = existing ? "UPDATE" : "CREATE";
      if (!dryRun) {
        await prisma.$transaction(async (tx) => {
          const user = existing
            ? await tx.user.update({ where: { id: existing.id }, data: { firstName: v.firstName, lastName: v.lastName, phone: v.phone ?? existing.phone,
                recoRegistrationNo: v.recoRegistrationNo ?? existing.recoRegistrationNo, hstNumber: v.hstNumber ?? existing.hstNumber,
                ...(v.precLegalName ? { isPrec: true, precLegalName: v.precLegalName } : {}) } })
            : await tx.user.create({ data: { email: v.email, firstName: v.firstName, lastName: v.lastName, phone: v.phone, role: v.role,
                recoRegistrationNo: v.recoRegistrationNo, hstNumber: v.hstNumber, isPrec: !!v.precLegalName, precLegalName: v.precLegalName } });
          if (v.startDate && v.recoExpiryDate && v.address && v.dateOfBirth) {
            const data = {
              startDate: new Date(`${v.startDate}T00:00:00Z`), recoExpiryDate: new Date(`${v.recoExpiryDate}T00:00:00Z`),
              addressEnc: cipher.encrypt(v.address), dateOfBirthEnc: cipher.encrypt(v.dateOfBirth),
              emergencyContactName: v.emergencyContactName, emergencyContactPhone: v.emergencyContactPhone, eoInsurer: v.eoInsurer,
              eoPolicyNumber: v.eoPolicyNumber, eoExpiryDate: v.eoExpiryDate ? new Date(`${v.eoExpiryDate}T00:00:00Z`) : null,
              billingMethod: v.billingMethod, billingNote: v.billingNote, updatedById: actor.id, updatedAt: new Date(),
            };
            await tx.agentProfile.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
          }
          if (template) {
            await tx.$executeRaw`
              INSERT INTO "CommissionPlanVersion" (id, "userId", "effectiveFrom", "splitBps", "annualCap", "capYearStartMonth", "capYearStartDay",
                                                   fees, reason, "createdById", "templateId")
              VALUES (${randomUUID()}::uuid, ${user.id}::uuid, ${v.startDate ?? today}::date, ${template.splitBps}, ${template.annualCap?.toFixed(2) ?? null}::numeric,
                      ${template.capYearStartMonth}, ${template.capYearStartDay}, ${JSON.stringify(template.fees)}::jsonb,
                      ${"Imported: standard plan " + template.name}, ${actor.id}::uuid, ${template.id}::uuid)
              ON CONFLICT ("userId", "effectiveFrom") DO NOTHING`;
          }
        });
      }
      out.push({ row: n, label, action, detail: [
        existing ? "updates the person and their profile" : "adds the person (send their invitation from People)",
        template ? `proposes the "${template.name}" plan for approval` : "",
      ].filter(Boolean).join("; ") });
    } catch (err) {
      out.push({ row: n, label, action: "ERROR", detail: issuesOf(err) });
    }
  }
  return summary(out, dryRun);
}

// ── Deals ────────────────────────────────────────────────────────────────────

const HOLDER: Record<string, string> = { ourbrokerage: "OUR_BROKERAGE", coopbrokerage: "COOP_BROKERAGE", lawyer: "LAWYER", builder: "BUILDER" };

export async function importDeals(deps: ComplianceDeps, actor: Actor, csv: string, dryRun: boolean) {
  requireRole(actor, ["ADMIN"], "Importing deals");
  const { rows } = readTable(csv);
  const people = await deps.prisma.user.findMany({ where: { isActive: true }, select: { id: true, email: true } });
  const byEmail = new Map(people.map((p) => [p.email.toLowerCase(), p.id]));
  const out: Outcome[] = [];
  for (const [i, raw] of rows.entries()) {
    const n = i + 2;
    const g = (k: string) => raw[norm(k)] ?? "";
    const label = [g("streetAddress"), g("city")].filter(Boolean).join(", ") || `row ${n}`;
    try {
      const status = g("status").toUpperCase() || "CONDITIONAL";
      if (!["CONDITIONAL", "FIRM"].includes(status)) {
        throw new ValidationError([{ field: "status", message: "only open deals (conditional or firm) are imported here; closed deals and their trust history come over with the Lone Wolf cutover tool" }]);
      }
      const agents = [1, 2].flatMap((k) => {
        const email = g(k === 1 ? "agentEmail" : "agent2Email").toLowerCase();
        if (!email) return [];
        const userId = byEmail.get(email);
        if (!userId) throw new ValidationError([{ field: k === 1 ? "agentEmail" : "agent2Email", message: `no active person with the email ${email}` }]);
        const split = g(k === 1 ? "agentSplitPct" : "agent2SplitPct");
        const side = g(k === 1 ? "agentSide" : "agent2Side").toUpperCase();
        const share = g(k === 1 ? "agentSharePct" : "agent2SharePct");
        return [{ userId, role: k === 1 ? "PRIMARY" : "CO_AGENT", splitPct: split === "" ? split : Number(split), ...(side ? { side } : {}),
          ...(share ? { gciSharePct: Number(share) } : {}) }];
      });
      const names = (k: string) => g(k).split(";").map((x) => x.trim()).filter(Boolean);
      const lease = ["LANDLORD", "TENANT"].includes(g("side").toUpperCase());
      const parties = [
        ...names("sellers").map((fullName) => ({ role: lease ? "LANDLORD" : "SELLER", fullName })),
        ...names("buyers").map((fullName) => ({ role: lease ? "TENANT" : "BUYER", fullName })),
        ...(g("sellerLawyer") ? [{ role: "SELLER_LAWYER", fullName: g("sellerLawyer"), ...(g("sellerLawyerEmail") ? { email: g("sellerLawyerEmail") } : {}) }] : []),
        ...(g("buyerLawyer") ? [{ role: "BUYER_LAWYER", fullName: g("buyerLawyer"), ...(g("buyerLawyerEmail") ? { email: g("buyerLawyerEmail") } : {}) }] : []),
      ];
      const body = Object.fromEntries(Object.entries({
        side: g("side").toUpperCase(), status, streetAddress: g("streetAddress"), unit: g("unit"), city: g("city"), mlsNumber: g("mlsNumber"),
        salePrice: g("salePrice"), offerDate: g("offerDate"), conditionsDueDate: g("conditionsDueDate"), closeDate: g("closeDate"),
        depositAmount: g("depositAmount"), depositDueDate: g("depositDueDate"),
        trustDepositHolder: HOLDER[norm(g("depositHolder"))] ?? g("depositHolder").toUpperCase(),
        totalGci: g("totalGci"), listingSideGci: g("listingSideGci"), buyerSideGci: g("buyerSideGci"), buyerSideSellerPays: g("buyerSideSellerPays"),
        remunerationSource: g("remunerationSource"), coopBrokerageName: g("coopBrokerageName"), coopCommission: g("coopCommission"),
        outsideReferralPayee: g("outsideReferralPayee"), outsideReferralPct: g("outsideReferralPct") === "" ? "" : Number(g("outsideReferralPct")),
      }).filter(([, v]) => v !== ""));
      const input = validateCreateDeal({ ...body, agents, parties });
      const dup = await deps.prisma.transaction.findFirst({ where: { streetAddress: { equals: input.streetAddress, mode: "insensitive" },
        city: { equals: input.city, mode: "insensitive" }, offerDate: new Date(`${input.offerDate}T00:00:00Z`) }, select: { dealNumber: true } });
      if (dup) {
        out.push({ row: n, label, action: "SKIP", detail: `already here as deal ${dup.dealNumber}` });
        continue;
      }
      if (!dryRun) {
        const created = await createDeal(deps, actor, input);
        out.push({ row: n, label, action: "CREATE", detail: `deal ${created.deal.dealNumber}` });
      } else {
        out.push({ row: n, label, action: "CREATE", detail: `${input.side.toLowerCase()} deal, ${agents.length} agent(s), ${parties.length} people` });
      }
    } catch (err) {
      out.push({ row: n, label, action: "ERROR", detail: issuesOf(err) });
    }
  }
  return summary(out, dryRun);
}

function summary(rows: Outcome[], dryRun: boolean) {
  const count = (a: Outcome["action"]) => rows.filter((r) => r.action === a).length;
  return { dryRun, counts: { create: count("CREATE"), update: count("UPDATE"), skip: count("SKIP"), error: count("ERROR") }, rows };
}

export async function importRoutes(app: FastifyInstance, opts: { deps: ComplianceDeps; resolveUserId: ResolveUserId; today?: () => string }) {
  const prisma = opts.deps.prisma;
  const actorOf = async (req: FastifyRequest) => loadActor(prisma, await opts.resolveUserId(req));
  const today = () => opts.today?.() ?? todayInToronto();
  const read = (body: unknown) => {
    const r = new Reader(body, ["csv", "dryRun"]);
    const v = { csv: r.text("csv", 5_000_000), dryRun: r.has("dryRun") ? r.bool("dryRun") : true };
    r.done();
    return v;
  };
  const logged = async (actor: Actor, req: FastifyRequest, what: string, result: ReturnType<typeof summary>) => {
    if (!result.dryRun) await audit(prisma, { userId: actor.id, entity: "Import", entityId: what, action: "DATA_IMPORTED", outcome: "SUCCESS",
      changes: result.counts, ip: req.ip, userAgent: req.headers["user-agent"] ?? null });
    return result;
  };
  app.post("/api/imports/agents", { bodyLimit: 6_000_000 }, async (req) => {
    const actor = await actorOf(req);
    const { csv, dryRun } = read(req.body);
    return logged(actor, req, "agents", await importAgents(prisma, opts.deps.fieldCipher, actor, csv, dryRun, today()));
  });
  app.post("/api/imports/deals", { bodyLimit: 6_000_000 }, async (req) => {
    const actor = await actorOf(req);
    const { csv, dryRun } = read(req.body);
    return logged(actor, req, "deals", await importDeals(opts.deps, actor, csv, dryRun));
  });
}
