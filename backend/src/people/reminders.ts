/**
 * RECO registration renewal reminders. Once a day, for every active agent and broker with a profile:
 *
 *   30 days before expiry   "renew now"           to the registrant, copied to the managing brokers
 *   14 days before expiry   "renew now, urgent"
 *   on and after expiry     "expired: you can't trade"
 *
 * Each reminder is sent once per expiry date (RegistrationReminder's key), whichever server runs the check; a
 * profile entered late gets only the most urgent one that applies. Updating the expiry date after renewal starts
 * the cycle again for the new date. The registrant also gets an in-app notification.
 *
 * Penalties quoted: TRESA, S.O. 2002, c. 30, Sched. C, s.4 (no trading unless registered) and s.40(3) (on conviction,
 * an individual up to $50,000 and/or two years less a day; a corporation up to $250,000). Counsel to confirm the
 * wording before the first real email goes out.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, type ResolveUserId } from "../auth.ts";
import { todayInToronto } from "../lib/dates.ts";
import { deliverQueued, queueEmail, type EmailSender } from "../notify/email.ts";
import { registrationStatus } from "./profile.ts";

type Kind = "DAYS_30" | "DAYS_14" | "EXPIRED";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const longDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });

export function reminderKind(daysLeft: number): Kind | null {
  if (daysLeft < 0 || daysLeft === 0) return "EXPIRED";
  if (daysLeft <= 14) return "DAYS_14";
  if (daysLeft <= 30) return "DAYS_30";
  return null;
}

const PENALTIES =
  "You can't trade in real estate without a current RECO registration (Trust in Real Estate Services Act, 2002, s.4). " +
  "Trading while unregistered is an offence: on conviction, an individual can be fined up to $50,000, jailed for up to " +
  "two years less a day, or both, and a brokerage can be fined up to $250,000 (s.40).";

export function reminderEmail(kind: Kind, p: { firstName: string; expiry: string; daysLeft: number }, brokerage: string): { subject: string; text: string } {
  const when = longDate(p.expiry);
  if (kind === "EXPIRED") {
    return {
      subject: `Your RECO registration expired on ${when}: you can't trade`,
      text: [
        `Hi ${p.firstName},`,
        `Our records show your RECO registration expired on ${when}.`,
        "Until RECO renews or reinstates it, stop all trading: no listing or buyer agreements, showings, offers, negotiations or advice to clients on a trade.",
        PENALTIES,
        "If you've already renewed, send the office your new expiry date today so we can update your profile. If not, renew or apply for reinstatement in RECO's MyWeb now (reinstatement must happen within 24 months of expiry).",
        `${brokerage}`,
      ].join("\n\n"),
    };
  }
  return {
    subject: `${kind === "DAYS_14" ? "Urgent: " : ""}your RECO registration expires on ${when} (${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"})`,
    text: [
      `Hi ${p.firstName},`,
      `Your RECO registration expires on ${when}, ${p.daysLeft} day${p.daysLeft === 1 ? "" : "s"} from today.`,
      "Renew it in RECO's MyWeb before that date. If RECO receives your complete renewal (application, fee and documents) before it expires, your registration continues while they process it.",
      PENALTIES,
      "Once you've renewed, send the office your new expiry date so we can update your profile.",
      `${brokerage}`,
    ].join("\n\n"),
  };
}

/** Queues the reminders due today. Safe to run as often as you like. */
export async function runRegistrationReminders(prisma: PrismaClient, today: string, brokerage: string) {
  const [people, brokers] = await Promise.all([
    prisma.user.findMany({
      where: { isActive: true, role: { in: ["AGENT", "MANAGING_BROKER"] }, agentProfile: { isNot: null } },
      select: { id: true, email: true, firstName: true, agentProfile: { select: { recoExpiryDate: true } } },
    }),
    prisma.user.findMany({ where: { isActive: true, role: "MANAGING_BROKER" }, select: { id: true, email: true } }),
  ]);
  let queued = 0;
  for (const person of people) {
    const expiry = iso(person.agentProfile!.recoExpiryDate);
    const { daysLeft } = registrationStatus(expiry, today);
    const kind = reminderKind(daysLeft!);
    if (!kind) continue;
    const content = reminderEmail(kind, { firstName: person.firstName, expiry, daysLeft: daysLeft! }, brokerage);
    const sentNow = await prisma.$transaction(async (tx) => {
      const already = await tx.registrationReminder.findUnique({
        where: { userId_expiryDate_kind: { userId: person.id, expiryDate: new Date(`${expiry}T00:00:00Z`), kind } } });
      if (already) return false;
      const emailId = await queueEmail(tx, { kind: `RECO_${kind}`, to: [person.email],
        cc: brokers.filter((b) => b.id !== person.id).map((b) => b.email), subject: content.subject, text: content.text, relatedUserId: person.id });
      // The primary key makes this the guard: a second server running the same check at the same moment rolls back here
      await tx.$executeRaw`
        INSERT INTO "RegistrationReminder" ("userId", "expiryDate", kind, "emailId") VALUES (${person.id}::uuid, ${expiry}::date, ${kind}, ${emailId}::uuid)`;
      await tx.notification.create({ data: { userId: person.id, type: `RECO_${kind}`, title: content.subject,
        body: kind === "EXPIRED" ? "You can't trade until your registration is renewed or reinstated." : "Renew in RECO's MyWeb, then send the office your new expiry date." } });
      return true;
    }).catch((err: { code?: string; meta?: { code?: string } }) => {
      if (err?.code === "P2010" || err?.meta?.code === "23505") return false; // another run got there first
      throw err;
    });
    if (sentNow) queued++;
  }
  return { checked: people.length, queued };
}

export async function reminderRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId; brokerage: string;
  mail: { sender: EmailSender; from: string } | null; today?: () => string }) {
  const actorOf = async (req: FastifyRequest) => loadActor(opts.prisma, await opts.resolveUserId(req));
  const today = () => opts.today?.() ?? todayInToronto();
  // What the system has emailed (or is waiting to email), newest first
  app.get("/api/email-outbox", async (req) => {
    requireRole(await actorOf(req), ["ADMIN", "MANAGING_BROKER"], "Viewing sent emails");
    const rows = await opts.prisma.emailOutbox.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
    return {
      emailConfigured: opts.mail !== null,
      emails: rows.map((e) => ({ id: e.id, kind: e.kind, to: e.toAddresses, cc: e.ccAddresses, subject: e.subject, body: e.bodyText,
        status: e.status, attempts: e.attempts, lastError: e.lastError, createdAt: e.createdAt.toISOString(), sentAt: e.sentAt?.toISOString() ?? null })),
    };
  });
  // Runs today's check now (it also runs on its own every hour)
  app.post("/api/registrations/reminders/run", async (req) => {
    requireRole(await actorOf(req), ["ADMIN", "MANAGING_BROKER"], "Running the renewal reminders");
    const reminders = await runRegistrationReminders(opts.prisma, today(), opts.brokerage);
    return { ...reminders, delivery: await deliverQueued(opts.prisma, opts.mail) };
  });
}

/** Hourly: today's reminders, then delivery of anything queued. Errors are logged, never fatal. */
export function startReminderSchedule(prisma: PrismaClient, brokerage: string, mail: { sender: EmailSender; from: string } | null,
  log: (msg: string, err?: unknown) => void, everyMs = 60 * 60_000) {
  const tick = async () => {
    try {
      const r = await runRegistrationReminders(prisma, todayInToronto(), brokerage);
      const d = await deliverQueued(prisma, mail);
      if (r.queued || d.sent || d.failed) log(`renewal reminders: ${r.queued} queued, ${d.sent} sent, ${d.failed} failed, ${d.waiting} waiting`);
    } catch (err) {
      log("renewal reminders failed", err);
    }
  };
  void tick();
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
