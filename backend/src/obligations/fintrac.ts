/**
 * FINTRAC obligations for one deal (PCMLTFA; docs/regulatory-references.md §7). Pure.
 *
 * Who must be identified: each client, and since 2025-10-01 each unrepresented
 * party. Persons are verified at the time of the transaction (taken as the
 * offer date); entities within 30 days after it. Every deposit needs a receipt
 * of funds record, whatever the amount. PEP/HIO determinations are required
 * for every client here: the real-estate trigger isn't confirmed, so the
 * engine takes the strict reading. Report tasks carry their own deadlines.
 */

import type { Finding, PartyFacts } from "./types.ts";

export const UNREPRESENTED_RULE_FROM = "2025-10-01";

export interface FintracFacts {
  side: string;
  offerDate: string;
  parties: PartyFacts[];
  records: { partyId: string; kind: "FINTRAC_INDIVIDUAL" | "FINTRAC_CORPORATE"; status: string; verificationDate: string | null }[];
  determinations: { partyId: string; kind: string; result: string; riskRating: string | null; determinedAt: string }[];
  deposits: { entryId: string; amount: string; receivedDate: string; method: string; hasReceiptOfFunds: boolean }[];
  reports: { id: string; kind: string; dueAt: string; status: "OPEN" | "FILED" | "NOT_REQUIRED" }[];
  today: string;
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function evaluateFintrac(f: FintracFacts): Finding[] {
  const out: Finding[] = [];
  if (f.side === "LANDLORD" || f.side === "TENANT") return out; // FINTRAC covers purchases and sales
  const principals = f.parties.filter((p) => ["BUYER", "SELLER"].includes(p.role));
  const unrepresentedApplies = f.offerDate >= UNREPRESENTED_RULE_FROM;
  const subjects = principals.filter((p) => p.representation === "OUR_CLIENT" || (unrepresentedApplies && p.representation === "SELF_REPRESENTED"));

  for (const p of subjects) {
    const who = p.representation === "SELF_REPRESENTED" ? `${p.name} (unrepresented party)` : p.name;
    const kind = p.entityType === "CORPORATION" ? "FINTRAC_CORPORATE" : "FINTRAC_INDIVIDUAL";
    const record = f.records.find((r) => r.partyId === p.id && r.kind === kind);
    const due = p.entityType === "CORPORATION" ? addDays(f.offerDate, 30) : f.offerDate;
    const citation = p.representation === "SELF_REPRESENTED"
      ? "PCMLTFR: unrepresented parties (in force 2025-10-01)" : "PCMLTFR: information record and identity verification";
    if (!record || record.status !== "APPROVED") {
      out.push({ rule: "IDENTITY_VERIFICATION", citation, partyId: p.id, dueBy: due,
        severity: f.today > due ? "BREACH" : "BLOCKING",
        message: `${who}: ${record ? "the identification record is " + record.status.toLowerCase().replaceAll("_", " ") : "no identification record"}` +
          (p.entityType === "CORPORATION" ? ` (entities: within 30 days, by ${due})` : " (persons: at the time of the transaction)") });
    } else if (record.verificationDate && record.verificationDate > due) {
      out.push({ rule: "IDENTITY_VERIFICATION_LATE", citation, severity: "BREACH", partyId: p.id,
        message: `${who} was verified on ${record.verificationDate}, after the ${due} deadline` });
    }
    const latest = (k: string) => f.determinations.filter((d) => d.partyId === p.id && d.kind === k).sort((a, b) => b.determinedAt.localeCompare(a.determinedAt))[0];
    if (p.entityType === "CORPORATION" && !latest("BENEFICIAL_OWNERSHIP_CONFIRMED")) {
      out.push({ rule: "BENEFICIAL_OWNERSHIP", citation: "PCMLTFR: beneficial ownership, reasonable measures to confirm", severity: f.today > due ? "BREACH" : "BLOCKING",
        partyId: p.id, dueBy: due, message: `${who}: record the measures taken to confirm beneficial ownership (directors, 25%+ owners, structure)` });
    }
    if (p.representation === "OUR_CLIENT") {
      const pep = latest("PEP_HIO");
      if (!pep) {
        out.push({ rule: "PEP_HIO", citation: "PCMLTFR: politically exposed persons and heads of international organizations", severity: "BLOCKING",
          partyId: p.id, message: `${who}: record the PEP / HIO determination and risk rating` });
      } else if (pep.result === "FOREIGN_PEP" || pep.riskRating === "HIGH") {
        out.push({ rule: "ENHANCED_MEASURES", citation: "PCMLTFR: enhanced measures for high risk", severity: "WARNING", partyId: p.id,
          message: `${who} is high risk${pep.result === "FOREIGN_PEP" ? " (foreign PEP)" : ""}: take enhanced measures, establish the source of funds and get senior management review` });
      }
      if (!latest("BUSINESS_RELATIONSHIP")) {
        const by = addDays(f.offerDate, 30);
        out.push({ rule: "BUSINESS_RELATIONSHIP", citation: "PCMLTFR: business relationship record and ongoing monitoring", partyId: p.id, dueBy: by,
          severity: f.today > by ? "BREACH" : "BLOCKING", message: `${who}: record the purpose and intended nature of the business relationship` });
      }
    }
  }

  for (const d of f.deposits.filter((x) => !x.hasReceiptOfFunds)) {
    out.push({ rule: "RECEIPT_OF_FUNDS", citation: "PCMLTFR: receipt of funds record (real estate: any amount)", severity: "BLOCKING",
      message: `Deposit of $${d.amount} received ${d.receivedDate}: complete the receipt of funds record` });
  }

  for (const r of f.reports.filter((x) => x.status === "OPEN")) {
    const label = { LARGE_CASH: "Large cash transaction report", LARGE_VIRTUAL_CURRENCY: "Large virtual currency transaction report",
      SUSPICIOUS_TRANSACTION: "Suspicious transaction report", LISTED_PERSON_PROPERTY: "Listed person / terrorist property report" }[r.kind] ?? r.kind;
    out.push({ rule: `REPORT_${r.kind}`, citation: "PCMLTFA s.7, s.7.1; PCMLTFR reporting", dueBy: r.dueAt.slice(0, 10),
      severity: f.today > r.dueAt.slice(0, 10) ? "BREACH" : "BLOCKING", message: `${label} to file in FINTRAC's system by ${r.dueAt.slice(0, 16).replace("T", " ")} UTC, then record the reference` });
  }
  return out;
}

/** Compliance program status (brokerage-wide). */
export interface ProgramFacts {
  officer: { name: string; since: string } | null;
  policiesApprovedOn: string | null;
  riskAssessmentOn: string | null;
  lastReviewOn: string | null;
  agents: { id: string; name: string; lastTrainedOn: string | null }[];
  today: string;
}

const yearsAgo = (d: string, n: number) => `${Number(d.slice(0, 4)) - n}${d.slice(4)}`;

export function evaluateProgram(p: ProgramFacts): Finding[] {
  const out: Finding[] = [];
  const c = "PCMLTFR: compliance program (FINTRAC Guide 4)";
  if (!p.officer) out.push({ rule: "COMPLIANCE_OFFICER", citation: c, severity: "BLOCKING", message: "Appoint a compliance officer and record it" });
  if (!p.policiesApprovedOn) out.push({ rule: "POLICIES", citation: c, severity: "BLOCKING", message: "Record approval of the written compliance policies and procedures" });
  if (!p.riskAssessmentOn) out.push({ rule: "RISK_ASSESSMENT", citation: c, severity: "BLOCKING", message: "Document the brokerage's risk assessment" });
  else if (p.riskAssessmentOn < yearsAgo(p.today, 1)) {
    out.push({ rule: "RISK_ASSESSMENT_STALE", citation: c, severity: "WARNING", message: `The risk assessment is from ${p.riskAssessmentOn}; review it (brokerage policy: yearly)` });
  }
  const reviewDue = p.lastReviewOn ? `${Number(p.lastReviewOn.slice(0, 4)) + 2}${p.lastReviewOn.slice(4)}` : null;
  if (!p.lastReviewOn) out.push({ rule: "EFFECTIVENESS_REVIEW", citation: c, severity: "BLOCKING", message: "No two-year effectiveness review on record" });
  else if (reviewDue! < p.today) out.push({ rule: "EFFECTIVENESS_REVIEW_OVERDUE", citation: c, severity: "BREACH", dueBy: reviewDue!, message: `The two-year effectiveness review was due ${reviewDue}` });
  for (const a of p.agents) {
    if (!a.lastTrainedOn || a.lastTrainedOn < yearsAgo(p.today, 1)) {
      out.push({ rule: "TRAINING", citation: c, severity: "WARNING",
        message: `${a.name}: ${a.lastTrainedOn ? `last trained ${a.lastTrainedOn}` : "no FINTRAC training on record"} (brokerage policy: yearly)` });
    }
  }
  return out;
}
