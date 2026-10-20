/**
 * Lists and look-ups the staff screens need: who works here, which deals exist,
 * the brokerage's accounts, bank statements and reconciliations, and the two
 * work queues (approvals and document review).
 *
 * Read-only except for two set-up actions with no other route: creating a trust
 * account (managing broker) and editing a user's profile (admin). Permissions
 * follow the existing rules: staff see the brokerage, agents only their own
 * deals and a short list of colleagues. Payout and review states come from the
 * existing views (getPayouts, the document slots), not recalculated here.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient, Prisma, UserRole } from "@prisma/client";
import { loadActor, requireRole, TRUST_VIEWERS, type Actor, type ResolveUserId } from "../auth.ts";
import { DomainError, fromDatabaseError, NotFoundError } from "../errors.ts";
import { formatCents, numericToCents } from "../lib/money.ts";
import { Reader } from "../lib/reader.ts";
import { assertDealAccess } from "../deals/lifecycle.ts";
import { getPayouts, type PayoutLine } from "../closing/payouts.ts";
import { validatePathUuid } from "../trust/validation.ts";

const STAFF: readonly UserRole[] = ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"];
const BANK_STAFF: readonly UserRole[] = ["ADMIN", "MANAGING_BROKER"];
const REVIEWERS: readonly UserRole[] = ["MANAGING_BROKER", "COMPLIANCE_ADMIN"];

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const money = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : d.toFixed(2));

function rethrow(err: unknown): never {
  if (err instanceof DomainError) throw err;
  throw fromDatabaseError(err) ?? err;
}

// ── People ───────────────────────────────────────────────────────────────────

export async function listUsers(prisma: PrismaClient, actor: Actor, query: { role?: string; includeInactive?: string }) {
  const role = ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN", "AGENT"].includes(query.role ?? "") ? (query.role as UserRole) : undefined;
  if (!STAFF.includes(actor.role)) {
    // Agents pick co-agents on a deal: names and roles of active agents and brokers only
    const users = await prisma.user.findMany({
      where: { isActive: true, role: role ?? { in: ["AGENT", "MANAGING_BROKER"] } },
      select: { id: true, firstName: true, lastName: true, role: true }, orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    });
    return { users };
  }
  const users = await prisma.user.findMany({
    where: { ...(role ? { role } : {}), ...(query.includeInactive === "true" ? {} : { isActive: true }) },
    include: { credential: { select: { mfaEnabledAt: true, lockedUntil: true } } },
    orderBy: [{ isActive: "desc" }, { lastName: "asc" }, { firstName: "asc" }],
  });
  const now = new Date();
  return {
    users: users.map((u) => ({
      id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, role: u.role, phone: u.phone, isActive: u.isActive,
      recoRegistrationNo: u.recoRegistrationNo, isPrec: u.isPrec, precLegalName: u.precLegalName, hstNumber: u.hstNumber,
      passwordSet: u.credential !== null, mfaEnabled: !!u.credential?.mfaEnabledAt,
      locked: !!(u.credential?.lockedUntil && u.credential.lockedUntil > now), createdAt: u.createdAt,
    })),
  };
}

/** Admin: role, contact, RECO registration and PREC / HST details (printed on CDAs and used for payouts). */
export async function updateUserProfile(prisma: PrismaClient, actor: Actor, userId: string, body: unknown) {
  requireRole(actor, ["ADMIN"], "Editing a user's profile");
  const r = new Reader(body, ["firstName", "lastName", "phone", "role", "recoRegistrationNo", "isPrec", "precLegalName", "hstNumber"]);
  const data: Prisma.UserUpdateInput = {};
  if (r.has("firstName")) data.firstName = r.text("firstName", 100);
  if (r.has("lastName")) data.lastName = r.text("lastName", 100);
  if (r.has("phone")) data.phone = r.optionalText("phone", 40);
  if (r.has("role")) data.role = r.oneOf("role", ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN", "AGENT"] as const);
  if (r.has("recoRegistrationNo")) data.recoRegistrationNo = r.optionalText("recoRegistrationNo", 40);
  if (r.has("isPrec")) data.isPrec = r.bool("isPrec");
  if (r.has("precLegalName")) data.precLegalName = r.optionalText("precLegalName", 200);
  if (r.has("hstNumber")) data.hstNumber = r.optionalText("hstNumber", 40);
  r.check(!(data.role && userId === actor.id), "role", "you can't change your own role");
  r.check(!(data.isPrec === true && r.has("precLegalName") && !data.precLegalName), "precLegalName", "is required for a PREC");
  r.done();
  try {
    // A role change ends the person's sessions at their next request (the session records the role it was issued for)
    await prisma.user.update({ where: { id: userId }, data });
  } catch (err) {
    if ((err as { code?: string }).code === "P2025") throw new NotFoundError("User", userId);
    rethrow(err);
  }
  return listUsers(prisma, actor, { includeInactive: "true" }).then((x) => ({ user: x.users.find((u) => u.id === userId)! }));
}

// ── Deals ────────────────────────────────────────────────────────────────────

export async function listDeals(prisma: PrismaClient, actor: Actor, query: { q?: string; status?: string; side?: string }) {
  const q = (query.q ?? "").trim().slice(0, 100);
  const statuses = ["CONDITIONAL", "FIRM", "CLOSED", "COLLAPSED", "CANCELLED"];
  const where: Prisma.TransactionWhereInput = {
    ...(statuses.includes(query.status ?? "") ? { status: query.status as never } : {}),
    ...(["LISTING", "BUYER", "DUAL", "LANDLORD", "TENANT"].includes(query.side ?? "") ? { side: query.side as never } : {}),
    ...(STAFF.includes(actor.role) ? {} : { agents: { some: { userId: actor.id } } }),
    ...(q ? {
      OR: [
        { dealNumber: { contains: q, mode: "insensitive" } }, { streetAddress: { contains: q, mode: "insensitive" } },
        { city: { contains: q, mode: "insensitive" } }, { mlsNumber: { contains: q, mode: "insensitive" } },
        { parties: { some: { fullName: { contains: q, mode: "insensitive" } } } },
      ],
    } : {}),
  };
  const deals = await prisma.transaction.findMany({
    where, take: 200, orderBy: [{ closeDate: "desc" }, { dealNumber: "desc" }],
    include: { agents: { include: { user: { select: { firstName: true, lastName: true } } } } },
  });
  return {
    deals: deals.map((d) => ({
      id: d.id, dealNumber: d.dealNumber, side: d.side, status: d.status, streetAddress: d.streetAddress, unit: d.unit, city: d.city,
      mlsNumber: d.mlsNumber, offerDate: iso(d.offerDate), closeDate: iso(d.closeDate), salePrice: money(d.salePrice),
      trustDepositHolder: d.trustDepositHolder,
      agents: d.agents.sort((a, b) => (a.role === "PRIMARY" ? -1 : b.role === "PRIMARY" ? 1 : 0))
        .map((a) => `${a.user.firstName} ${a.user.lastName}`),
    })),
    truncated: deals.length === 200,
  };
}

export async function getDeal(prisma: PrismaClient, actor: Actor, dealId: string) {
  await assertDealAccess(prisma, actor, dealId);
  const d = await prisma.transaction.findUnique({
    where: { id: dealId },
    include: {
      agents: { include: { user: { select: { id: true, firstName: true, lastName: true, isPrec: true, precLegalName: true } } } },
      parties: { orderBy: [{ role: "asc" }, { fullName: "asc" }] },
      closings: { orderBy: { revision: "desc" }, take: 1, include: { void: { select: { reason: true } } } },
    },
  });
  if (!d) throw new NotFoundError("Deal", dealId);
  const cda = d.closings[0];
  return {
    deal: {
      id: d.id, dealNumber: d.dealNumber, side: d.side, status: d.status, province: d.province,
      streetAddress: d.streetAddress, unit: d.unit, city: d.city, mlsNumber: d.mlsNumber,
      salePrice: money(d.salePrice), offerDate: iso(d.offerDate), conditionsDueDate: iso(d.conditionsDueDate), closeDate: iso(d.closeDate),
      depositAmount: money(d.depositAmount), depositDueDate: iso(d.depositDueDate), trustDepositHolder: d.trustDepositHolder,
      depositStatus: d.depositStatus, totalGci: money(d.totalGci),
      listingSideGci: d.listingSideGci === null ? null : money(d.listingSideGci), buyerSideGci: d.buyerSideGci === null ? null : money(d.buyerSideGci),
      buyerSideSellerPays: d.buyerSideSellerPays === null ? null : money(d.buyerSideSellerPays), remunerationSource: d.remunerationSource,
      // Same-brokerage deals: what each client pays under their own agreement, before tax
      paidBySeller: d.listingSideGci !== null && d.buyerSideSellerPays !== null
        ? formatCents(numericToCents(d.listingSideGci.toFixed(2)) + numericToCents(d.buyerSideSellerPays.toFixed(2))) : null,
      paidByBuyer: d.buyerSideGci !== null && d.buyerSideSellerPays !== null
        ? formatCents(numericToCents(d.buyerSideGci.toFixed(2)) - numericToCents(d.buyerSideSellerPays.toFixed(2))) : null,
      sellerRemunerationVaries: d.sellerRemunerationVaries,
      coopBrokerageName: d.coopBrokerageName, coopCommission: money(d.coopCommission),
      outsideReferralPayee: d.outsideReferralPayee, outsideReferralPct: d.outsideReferralPct?.toFixed(2) ?? null,
      agents: d.agents.map((a) => ({
        userId: a.userId, name: `${a.user.firstName} ${a.user.lastName}`, role: a.role, splitPct: a.splitPct.toFixed(2),
        gciSharePct: a.gciSharePct.toFixed(2), side: a.side, isPrec: a.user.isPrec, precLegalName: a.user.precLegalName,
      })),
      parties: d.parties.map((p) => ({
        id: p.id, role: p.role, entityType: p.entityType, fullName: p.fullName, email: p.email, phone: p.phone, representation: p.representation,
      })),
      cda: cda ? { cdaNumber: cda.cdaNumber, revision: cda.revision, finalizedAt: cda.finalizedAt, voided: cda.void ? cda.void.reason : null } : null,
    },
  };
}

// ── Accounts, statements, reconciliations ────────────────────────────────────

export async function listTrustAccounts(prisma: PrismaClient, actor: Actor) {
  requireRole(actor, TRUST_VIEWERS, "Viewing trust accounts");
  const rows = await prisma.$queryRaw<{ id: string; name: string; kind: string; bankName: string; accountLast4: string; isActive: boolean; balance: string }[]>`
    SELECT a.id::text, a.name, a.kind::text AS kind, a."bankName", a."accountLast4", a."isActive",
           COALESCE((SELECT SUM(e.amount * e.direction) FROM "TrustLedgerEntry" e WHERE e."trustAccountId" = a.id), 0)::numeric(14, 2)::text AS balance
      FROM "TrustAccount" a ORDER BY a."isActive" DESC, a.name`;
  return { accounts: rows };
}

export async function createTrustAccount(prisma: PrismaClient, actor: Actor, body: unknown) {
  requireRole(actor, ["MANAGING_BROKER"], "Opening a trust account record");
  const r = new Reader(body, ["name", "bankName", "accountLast4", "kind"]);
  const input = {
    name: r.text("name", 100), bankName: r.text("bankName", 100), accountLast4: r.text("accountLast4", 4, 4),
    kind: r.has("kind") ? r.oneOf("kind", ["REAL_ESTATE_TRUST", "COMMISSION_TRUST"] as const) : ("REAL_ESTATE_TRUST" as const),
  };
  r.check(/^\d{4}$/.test(input.accountLast4), "accountLast4", "must be the last 4 digits of the account number");
  r.done();
  try {
    const a = await prisma.trustAccount.create({ data: input });
    return { account: { id: a.id, name: a.name, kind: a.kind, bankName: a.bankName, accountLast4: a.accountLast4, isActive: a.isActive, balance: "0.00" } };
  } catch (err) {
    rethrow(err);
  }
}

export async function listOperatingAccounts(prisma: PrismaClient, actor: Actor) {
  requireRole(actor, BANK_STAFF, "Viewing operating accounts");
  const accounts = await prisma.operatingAccount.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] });
  return { accounts: accounts.map((a) => ({ id: a.id, name: a.name, bankName: a.bankName, accountLast4: a.accountLast4, isActive: a.isActive })) };
}

export async function listStatements(prisma: PrismaClient, actor: Actor, query: { accountId?: string }) {
  requireRole(actor, TRUST_VIEWERS, "Viewing bank statements");
  const accountId = query.accountId && /^[0-9a-f-]{36}$/i.test(query.accountId) ? query.accountId : undefined;
  const statements = await prisma.bankStatement.findMany({
    where: accountId ? { OR: [{ trustAccountId: accountId }, { operatingAccountId: accountId }] } : {},
    orderBy: [{ periodEnd: "desc" }, { importedAt: "desc" }], take: 120,
    include: {
      importedBy: { select: { firstName: true, lastName: true } },
      verification: { include: { verifiedBy: { select: { firstName: true, lastName: true } } } },
      trustAccount: { select: { name: true } }, operatingAccount: { select: { name: true } },
    },
  });
  return {
    statements: statements.map((s) => ({
      id: s.id, kind: s.kind, account: s.trustAccount ? { type: "TRUST", id: s.trustAccountId, name: s.trustAccount.name }
        : { type: "OPERATING", id: s.operatingAccountId, name: s.operatingAccount?.name ?? "" },
      periodStart: iso(s.periodStart), periodEnd: iso(s.periodEnd), closingBalance: money(s.closingBalance), fileName: s.fileName,
      importedAt: s.importedAt, importedBy: `${s.importedBy.firstName} ${s.importedBy.lastName}`,
      verified: s.verification ? { at: s.verification.verifiedAt, by: `${s.verification.verifiedBy.firstName} ${s.verification.verifiedBy.lastName}` } : null,
    })),
  };
}

export async function listReconciliations(prisma: PrismaClient, actor: Actor, query: { trustAccountId?: string }) {
  requireRole(actor, TRUST_VIEWERS, "Viewing trust reconciliations");
  const accountId = query.trustAccountId && /^[0-9a-f-]{36}$/i.test(query.trustAccountId) ? query.trustAccountId : undefined;
  const rows = await prisma.trustReconciliation.findMany({
    where: accountId ? { trustAccountId: accountId } : {}, orderBy: [{ periodEnd: "desc" }, { preparedAt: "desc" }], take: 120,
    include: {
      trustAccount: { select: { name: true } }, supersededBy: { select: { id: true, signedAt: true } },
      preparedBy: { select: { firstName: true, lastName: true } }, signedBy: { select: { firstName: true, lastName: true } },
    },
  });
  return {
    reconciliations: rows.map((r) => ({
      id: r.id, trustAccountId: r.trustAccountId, trustAccountName: r.trustAccount.name, statementId: r.statementId, periodEnd: iso(r.periodEnd),
      isBalanced: r.isBalanced, difference: money(r.difference),
      status: r.supersededBy?.signedAt ? "SUPERSEDED" : !r.signedAt ? "PREPARED" : r.isBalanced ? "SIGNED" : "SIGNED_WITH_DISCREPANCY",
      preparedAt: r.preparedAt, preparedBy: `${r.preparedBy.firstName} ${r.preparedBy.lastName}`,
      signedAt: r.signedAt, signedBy: r.signedBy ? `${r.signedBy.firstName} ${r.signedBy.lastName}` : null,
    })),
  };
}

// ── Work queues ──────────────────────────────────────────────────────────────

const PAYOUT_ACTION: Partial<Record<PayoutLine["status"], string>> = {
  AWAITING_BANK_VERIFICATION: "Commission received: verify it against a bank file",
  AWAITING_POLICY_APPROVAL: "Needs the broker of record's policy decision (co-op / referral payables)",
  READY_FOR_APPROVAL: "Ready for a managing broker's approval",
  APPROVED: "Approved: send the payment in the bank portal, then record it",
  PAYMENT_RETURNED: "Payment came back: send it again and record it",
};

/** Everything waiting on a broker or admin: payouts, receipts, plans, adjustments, statements, reconciliations. */
export async function approvalsQueue(prisma: PrismaClient, actor: Actor) {
  requireRole(actor, BANK_STAFF, "Viewing the approvals queue");
  const closed = await prisma.transaction.findMany({
    where: { closings: { some: {} } }, select: { id: true, dealNumber: true, streetAddress: true, city: true }, orderBy: { dealNumber: "desc" }, take: 300,
  });
  const payouts: { dealId: string; dealNumber: string; address: string; line: PayoutLine; action: string }[] = [];
  for (const d of closed) {
    let view;
    try {
      view = await getPayouts({ prisma }, actor, d.id);
    } catch (err) {
      if (err instanceof NotFoundError) continue; // voided and not reissued
      throw err;
    }
    for (const line of view.payouts) {
      const unconfirmed = line.status === "PAID" && line.paymentConfirmed === false;
      const action = PAYOUT_ACTION[line.status] ?? (unconfirmed ? "Paid: waiting for a bank file to confirm it" : null);
      if (action) payouts.push({ dealId: d.id, dealNumber: d.dealNumber, address: `${d.streetAddress}, ${d.city}`, line, action });
    }
  }
  const plans = await prisma.commissionPlanVersion.findMany({
    where: { approvedAt: null }, orderBy: { createdAt: "asc" },
    include: { user: { select: { firstName: true, lastName: true } }, createdBy: { select: { firstName: true, lastName: true } } },
  });
  const adjustments = await prisma.commissionAdjustment.findMany({
    where: { approvedAt: null, withdrawnAt: null }, orderBy: { createdAt: "asc" },
    include: { user: { select: { firstName: true, lastName: true } }, transaction: { select: { id: true, dealNumber: true } } },
  });
  const statements = await prisma.bankStatement.findMany({
    where: { verification: null }, orderBy: { importedAt: "asc" },
    include: { importedBy: { select: { id: true, firstName: true, lastName: true } }, trustAccount: { select: { name: true } }, operatingAccount: { select: { name: true } } },
  });
  const reconciliations = await listReconciliations(prisma, actor, {});
  return {
    payouts,
    plans: plans.map((p) => ({
      id: p.id, userId: p.userId, agent: `${p.user.firstName} ${p.user.lastName}`, effectiveFrom: iso(p.effectiveFrom),
      splitBps: p.splitBps, annualCap: money(p.annualCap), reason: p.reason, createdById: p.createdById,
      createdBy: p.createdBy ? `${p.createdBy.firstName} ${p.createdBy.lastName}` : null, createdAt: p.createdAt,
    })),
    adjustments: adjustments.map((a) => ({
      id: a.id, dealId: a.transaction.id, dealNumber: a.transaction.dealNumber, agent: `${a.user.firstName} ${a.user.lastName}`, kind: a.kind,
      description: a.description, amount: money(a.amount), taxable: a.taxable, createdById: a.createdById, createdAt: a.createdAt,
    })),
    statements: statements.map((s) => ({
      id: s.id, kind: s.kind, account: s.trustAccount?.name ?? s.operatingAccount?.name ?? "", periodStart: iso(s.periodStart), periodEnd: iso(s.periodEnd),
      importedAt: s.importedAt, importedById: s.importedBy.id, importedBy: `${s.importedBy.firstName} ${s.importedBy.lastName}`,
    })),
    reconciliationsToSign: reconciliations.reconciliations.filter((r) => r.status === "PREPARED"),
  };
}

/** Documents waiting for a reviewer, oldest upload first. */
export async function reviewQueue(prisma: PrismaClient, actor: Actor) {
  requireRole(actor, REVIEWERS, "Viewing the document review queue");
  const slots = await prisma.documentSlot.findMany({
    where: { status: "PENDING_REVIEW", transactionId: { not: null } },
    include: {
      documentType: { select: { name: true, metadataKind: true } }, party: { select: { fullName: true } },
      transaction: { select: { id: true, dealNumber: true, streetAddress: true, city: true, closeDate: true } },
      files: { orderBy: { version: "desc" }, take: 1, include: { uploadedBy: { select: { firstName: true, lastName: true } } } },
    },
  });
  const items = slots.map((s) => ({
    slotId: s.id, document: s.documentType.name, fintrac: s.documentType.metadataKind !== "NONE", party: s.party?.fullName ?? null,
    dealId: s.transaction!.id, dealNumber: s.transaction!.dealNumber, address: `${s.transaction!.streetAddress}, ${s.transaction!.city}`,
    closeDate: iso(s.transaction!.closeDate), uploadedAt: s.files[0]?.uploadedAt ?? null,
    uploadedBy: s.files[0] ? `${s.files[0].uploadedBy.firstName} ${s.files[0].uploadedBy.lastName}` : null, fileId: s.files[0]?.id ?? null,
  })).sort((a, b) => (a.uploadedAt?.getTime() ?? 0) - (b.uploadedAt?.getTime() ?? 0));
  return { items };
}

// ── Routes ───────────────────────────────────────────────────────────────────

export async function directoryRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId }) {
  const actorOf = async (req: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(req));
  type Q = { Querystring: Record<string, string> };
  type P = { Params: Record<string, string> };

  app.get<Q>("/api/users", async (req) => listUsers(opts.prisma, await actorOf(req), req.query));
  app.post<P>("/api/users/:id/profile", async (req) =>
    updateUserProfile(opts.prisma, await actorOf(req), validatePathUuid(req.params.id!, "id"), req.body));
  app.get<Q>("/api/deals", async (req) => listDeals(opts.prisma, await actorOf(req), req.query));
  app.get<P>("/api/deals/:dealId", async (req) => getDeal(opts.prisma, await actorOf(req), validatePathUuid(req.params.dealId!, "dealId")));
  app.get("/api/trust/accounts", async (req) => listTrustAccounts(opts.prisma, await actorOf(req)));
  app.post("/api/trust/accounts", async (req, reply) => reply.code(201).send(await createTrustAccount(opts.prisma, await actorOf(req), req.body)));
  app.get("/api/operating-accounts", async (req) => listOperatingAccounts(opts.prisma, await actorOf(req)));
  app.get<Q>("/api/bank/statements", async (req) => listStatements(opts.prisma, await actorOf(req), req.query));
  app.get<Q>("/api/trust/reconciliations", async (req) => listReconciliations(opts.prisma, await actorOf(req), req.query));
  app.get("/api/work/approvals", async (req) => approvalsQueue(opts.prisma, await actorOf(req)));
  app.get("/api/work/reviews", async (req) => reviewQueue(opts.prisma, await actorOf(req)));
}
