/**
 * Dependency gate for CI: fails on any high or critical advisory in production
 * dependencies, except the ones listed here. Each accepted advisory is a recorded,
 * open finding (docs/security-review-checklist.md), not a fix. Remove an entry once
 * the upgrade lands; an entry that no longer matches anything also fails the gate.
 *
 *   npm audit --omit=dev --json | node scripts/audit-gate.ts
 */
import { readFileSync } from "node:fs";

const ACCEPTED: Record<string, string> = {
  "GHSA-ggr8-5vv4-36mx": "deepmerge-ts via Prisma 6 tooling (@prisma/config); fixed by the Prisma 7 upgrade",
  "GHSA-38f7-945m-qr2g": "effect via Prisma 6 tooling (@prisma/config); fixed by the Prisma 7 upgrade",
};

type Via = string | { url: string; severity: string; title: string };
const report = JSON.parse(readFileSync(0, "utf8")) as { vulnerabilities: Record<string, { severity: string; via: Via[] }> };

const blocking: string[] = [];
const seen = new Set<string>();
for (const [pkg, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via === "string") continue; // reached through another package, reported there
    if (via.severity !== "high" && via.severity !== "critical") continue;
    const id = via.url.split("/").pop()!;
    if (id in ACCEPTED) seen.add(id);
    else blocking.push(`${via.severity} ${pkg}: ${via.title} (${via.url})`);
  }
}
for (const id of seen) console.log(`accepted (open finding): ${id} ${ACCEPTED[id]}`);
const stale = Object.keys(ACCEPTED).filter((id) => !seen.has(id));
for (const id of stale) console.log(`no longer present, remove from the accepted list: ${id}`);
for (const b of blocking) console.log(`BLOCKING ${b}`);
process.exit(blocking.length || stale.length ? 1 : 0);
