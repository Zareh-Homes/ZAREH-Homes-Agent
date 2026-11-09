/**
 * Agent profiles (migration 023): what the brokerage keeps on each person who trades.
 *
 *   Required   start date, RECO registration expiry, home address, date of birth
 *   Optional   emergency contact, E&O insurance, payout banking, how the brokerage bills them, notes
 *
 * Address, date of birth and payout banking are personal information: stored encrypted (FieldCipher), shown in full
 * only to admins and managing brokers (and to the person themselves). Compliance sees the registration dates only.
 * Admins and managing brokers edit; every change is in the audit log (which fields, never the values).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, type Actor, type ResolveUserId } from "../auth.ts";
import { ForbiddenError, NotFoundError } from "../errors.ts";
import { Reader } from "../lib/reader.ts";
import { todayInToronto } from "../lib/dates.ts";
import type { FieldCipher } from "../security/crypto.ts";
import { audit } from "../security/audit.ts";
import { validatePathUuid } from "../trust/validation.ts";

const EDITORS = ["ADMIN", "MANAGING_BROKER"] as const;
const BILLING = ["PRE_AUTHORIZED_DEBIT", "BANK_TRANSFER", "CHEQUE", "DEDUCT_FROM_COMMISSION", "OTHER"] as const;
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export interface PayoutBanking { accountHolder: string; institutionNumber: string; transitNumber: string; accountNumber: string }

/** Where a registration stands today: ok, expiring within 30 days, or expired (can't trade, from the expiry date on) */
export function registrationStatus(expiry: string | null, today: string): { status: "MISSING" | "OK" | "EXPIRING" | "EXPIRED"; daysLeft: number | null } {
  if (!expiry) return { status: "MISSING", daysLeft: null };
  const daysLeft = Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  // On the expiry date itself the registration is treated as expired (the stricter reading; the expiry email goes that day)
  return { status: daysLeft <= 0 ? "EXPIRED" : daysLeft <= 30 ? "EXPIRING" : "OK", daysLeft };
}

export async function getAgentProfile(prisma: PrismaClient, cipher: FieldCipher, actor: Actor, userId: string, today: string) {
  const full = (EDITORS as readonly string[]).includes(actor.role) || actor.id === userId;
  if (!full && actor.role !== "COMPLIANCE_ADMIN") throw new ForbiddenError("Agent profiles are for admins, managing brokers and the person themselves");
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, firstName: true, lastName: true, role: true, agentProfile: true } });
  if (!user) throw new NotFoundError("User", userId);
  const p = user.agentProfile;
  const reco = registrationStatus(iso(p?.recoExpiryDate ?? null), today);
  if (!p) return { userId, complete: false, registration: reco, profile: null };
  const dates = { startDate: iso(p.startDate), recoExpiryDate: iso(p.recoExpiryDate), eoExpiryDate: iso(p.eoExpiryDate) };
  if (!full) return { userId, complete: true, registration: reco, profile: dates };
  return {
    userId, complete: true, registration: reco,
    profile: {
      ...dates,
      address: cipher.decrypt(p.addressEnc), dateOfBirth: cipher.decrypt(p.dateOfBirthEnc),
      emergencyContactName: p.emergencyContactName, emergencyContactPhone: p.emergencyContactPhone,
      eoInsurer: p.eoInsurer, eoPolicyNumber: p.eoPolicyNumber,
      payoutBanking: p.payoutBankingEnc ? JSON.parse(cipher.decrypt(p.payoutBankingEnc)) as PayoutBanking : null,
      billingMethod: p.billingMethod, billingNote: p.billingNote, notes: p.notes, updatedAt: p.updatedAt.toISOString(),
    },
  };
}

export async function saveAgentProfile(prisma: PrismaClient, cipher: FieldCipher, actor: Actor, userId: string, body: unknown, today: string,
  info: { ip?: string | null; userAgent?: string | null } = {}) {
  requireRole(actor, EDITORS, "Editing an agent profile");
  const r = new Reader(body, ["startDate", "recoExpiryDate", "address", "dateOfBirth", "emergencyContactName", "emergencyContactPhone",
    "eoInsurer", "eoPolicyNumber", "eoExpiryDate", "payoutBanking", "billingMethod", "billingNote", "notes"]);
  const input = {
    startDate: r.date("startDate"),
    recoExpiryDate: r.date("recoExpiryDate"),
    address: r.text("address", 300),
    dateOfBirth: r.pastDate("dateOfBirth", today),
    emergencyContactName: r.optionalText("emergencyContactName", 200),
    emergencyContactPhone: r.optionalText("emergencyContactPhone", 40),
    eoInsurer: r.optionalText("eoInsurer", 200),
    eoPolicyNumber: r.optionalText("eoPolicyNumber", 100),
    eoExpiryDate: r.optionalDate("eoExpiryDate"),
    billingMethod: r.has("billingMethod") && r.raw("billingMethod") !== null && r.raw("billingMethod") !== "" ? r.oneOf("billingMethod", BILLING) : null,
    billingNote: r.optionalText("billingNote", 500),
    notes: r.optionalText("notes", 2000),
  };
  let banking: PayoutBanking | null = null;
  if (r.has("payoutBanking") && r.raw("payoutBanking") !== null) {
    const b = r.nested("payoutBanking", ["accountHolder", "institutionNumber", "transitNumber", "accountNumber"]);
    banking = { accountHolder: b.text("accountHolder", 200), institutionNumber: b.text("institutionNumber", 3, 3),
      transitNumber: b.text("transitNumber", 5, 5), accountNumber: b.text("accountNumber", 12, 5) };
    b.check(/^\d{3}$/.test(banking.institutionNumber), "institutionNumber", "is the bank's 3-digit institution number");
    b.check(/^\d{5}$/.test(banking.transitNumber), "transitNumber", "is the 5-digit branch transit number");
    b.check(/^\d{5,12}$/.test(banking.accountNumber), "accountNumber", "is 5 to 12 digits");
  }
  if (input.dateOfBirth) {
    const age = Number(today.slice(0, 4)) - Number(input.dateOfBirth.slice(0, 4));
    r.check(age >= 18 && age < 110, "dateOfBirth", "check the date of birth");
  }
  r.done();

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new NotFoundError("User", userId);
  const data = {
    startDate: new Date(`${input.startDate}T00:00:00Z`), recoExpiryDate: new Date(`${input.recoExpiryDate}T00:00:00Z`),
    addressEnc: cipher.encrypt(input.address), dateOfBirthEnc: cipher.encrypt(input.dateOfBirth),
    emergencyContactName: input.emergencyContactName, emergencyContactPhone: input.emergencyContactPhone,
    eoInsurer: input.eoInsurer, eoPolicyNumber: input.eoPolicyNumber,
    eoExpiryDate: input.eoExpiryDate ? new Date(`${input.eoExpiryDate}T00:00:00Z`) : null,
    payoutBankingEnc: banking ? cipher.encrypt(JSON.stringify(banking)) : null,
    billingMethod: input.billingMethod, billingNote: input.billingNote, notes: input.notes,
    updatedById: actor.id, updatedAt: new Date(),
  };
  await prisma.agentProfile.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  await audit(prisma, { userId: actor.id, entity: "AgentProfile", entityId: userId, action: "AGENT_PROFILE_SAVED", outcome: "SUCCESS",
    changes: { fields: Object.entries(input).filter(([, v]) => v !== null).map(([k]) => k).concat(banking ? ["payoutBanking"] : []) }, ...info });
  return getAgentProfile(prisma, cipher, actor, userId, today);
}

/** Every active person who trades, with where their registration stands (for the people list and oversight) */
export async function registrationOverview(prisma: PrismaClient, today: string) {
  const people = await prisma.user.findMany({
    where: { isActive: true, role: { in: ["AGENT", "MANAGING_BROKER"] } },
    select: { id: true, firstName: true, lastName: true, agentProfile: { select: { recoExpiryDate: true } } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  return people.map((p) => ({ userId: p.id, name: `${p.firstName} ${p.lastName}`,
    recoExpiryDate: iso(p.agentProfile?.recoExpiryDate ?? null), ...registrationStatus(iso(p.agentProfile?.recoExpiryDate ?? null), today) }));
}

export async function profileRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; fieldCipher: FieldCipher; today?: () => string }) {
  const actorOf = async (req: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(req));
  const today = () => opts.today?.() ?? todayInToronto();
  type P = { Params: { id: string } };
  app.get<P>("/api/users/:id/agent-profile", async (req) =>
    getAgentProfile(opts.prisma, opts.fieldCipher, await actorOf(req), validatePathUuid(req.params.id, "id"), today()));
  app.post<P>("/api/users/:id/agent-profile", async (req) =>
    saveAgentProfile(opts.prisma, opts.fieldCipher, await actorOf(req), validatePathUuid(req.params.id, "id"), req.body, today(),
      { ip: req.ip, userAgent: req.headers["user-agent"] ?? null }));
  app.get("/api/registrations", async (req) => {
    requireRole(await actorOf(req), ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"], "Viewing registrations");
    return { registrations: await registrationOverview(opts.prisma, today()) };
  });
}
