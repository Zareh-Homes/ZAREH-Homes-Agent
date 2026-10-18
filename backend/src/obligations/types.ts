/** A rule's result for one deal. */
export interface Finding {
  rule: string;
  citation: string;
  /**
   * BLOCKING  must be done; blocks the broker of record's trade record signature (and, for offer
   *           rules, accepting an offer)
   * BREACH    already happened too late; can't be fixed, only reviewed and recorded
   * WARNING   should be done or checked
   */
  severity: "BLOCKING" | "BREACH" | "WARNING";
  message: string;
  partyId?: string;
  offerId?: string;
  dueBy?: string;
}

export type Representation = "OUR_CLIENT" | "REPRESENTED_ELSEWHERE" | "SELF_REPRESENTED" | "UNKNOWN";

export interface PartyFacts {
  id: string;
  role: string;
  name: string;
  entityType: "INDIVIDUAL" | "CORPORATION";
  representation: Representation;
}

export const summarize = (findings: Finding[]) => ({
  blocking: findings.filter((f) => f.severity === "BLOCKING").length,
  breaches: findings.filter((f) => f.severity === "BREACH").length,
  warnings: findings.filter((f) => f.severity === "WARNING").length,
});
