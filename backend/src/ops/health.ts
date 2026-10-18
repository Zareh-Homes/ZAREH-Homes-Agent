/**
 * Health, readiness and the audit-log export.
 *
 *   GET /healthz             the process is up (no database, no auth): for the load balancer
 *   GET /readyz              the database answers and every migration in this release is applied
 *   GET /api/audit/export    audit log for a date range, JSON or CSV (staff); the export is itself audited
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { loadActor, requireRole, type ResolveUserId } from "../auth.ts";
import { Reader } from "../lib/reader.ts";

/** The last migration this release expects. Bump it with each new file in brokerage-db/migrations. */
export const EXPECTED_MIGRATION = "017_reco_filing.sql";

export async function healthRoutes(app: FastifyInstance, opts: { prisma: PrismaClient; resolveUserId: ResolveUserId }) {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_req, reply) => {
    try {
      const [row] = await opts.prisma.$queryRaw<{ latest: string | null; tracked: boolean }[]>`
        SELECT to_regclass('zareh_meta.schema_migrations') IS NOT NULL AS tracked,
               (SELECT MAX(filename) FROM zareh_meta.schema_migrations) AS latest`;
      if (row!.tracked && row!.latest !== EXPECTED_MIGRATION) {
        return reply.code(503).send({ status: "not_ready", reason: `database is at ${row!.latest}, this release needs ${EXPECTED_MIGRATION}` });
      }
      return { status: "ready", migration: row!.latest ?? "untracked" };
    } catch {
      // The query above fails outright when the tracking schema doesn't exist; fall back to a plain ping
      try {
        await opts.prisma.$queryRaw`SELECT 1`;
        return { status: "ready", migration: "untracked" };
      } catch {
        return reply.code(503).send({ status: "not_ready", reason: "database unreachable" });
      }
    }
  });

  app.get<{ Querystring: Record<string, string> }>("/api/audit/export", async (req: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const actor = await loadActor(opts.prisma, await opts.resolveUserId(req));
    requireRole(actor, ["ADMIN", "MANAGING_BROKER", "COMPLIANCE_ADMIN"], "Exporting the audit log");
    const r = new Reader(req.query, ["from", "to", "format"]);
    const from = r.date("from");
    const to = r.date("to");
    const format = r.has("format") ? r.oneOf("format", ["json", "csv"] as const) : "json";
    r.done();
    const rows = await opts.prisma.$queryRaw<{ id: string; at: string; userId: string | null; entity: string; entityId: string; action: string;
      outcome: string | null; ip: string | null; route: string | null }[]>`
      SELECT id::text, to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, "userId"::text AS "userId", entity, "entityId",
             action, outcome, ip, route
        FROM "AuditLog"
       WHERE "createdAt" >= (${from}::date)::timestamp AT TIME ZONE 'America/Toronto'
         AND "createdAt" < ((${to}::date + 1)::timestamp AT TIME ZONE 'America/Toronto')
       ORDER BY id LIMIT 100000`;
    if (format === "csv") {
      const cell = (v: string | null) => {
        const s = v ?? "";
        const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
        return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
      };
      const head = "id,at,userId,entity,entityId,action,outcome,ip,route";
      const body = rows.map((x) => [x.id, x.at, x.userId, x.entity, x.entityId, x.action, x.outcome, x.ip, x.route].map(cell).join(",")).join("\r\n");
      return reply.header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="audit-${from}-to-${to}.csv"`).send(`${head}\r\n${body}\r\n`);
    }
    return { from, to, count: rows.length, truncated: rows.length === 100000, entries: rows };
  });
}
