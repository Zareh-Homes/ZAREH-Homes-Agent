/**
 * TRESA / O. Reg. 567/05 consumer-protection rules for one deal. Pure.
 * Citations and the unverified points are in docs/regulatory-references.md §5.
 *
 * "Services began" is taken as the earlier of the representation agreement's
 * signing and the offer date; assistance to a self-represented party as the
 * offer date. Recording a step late is a BREACH: it can't be undone, only
 * reviewed.
 */

import type { Finding, PartyFacts } from "./types.ts";

export interface DisclosureFacts {
  kind: string;
  partyId: string | null;
  offerId: string | null;
  deliveredAt: string;
  explainedAt: string | null;
  acknowledgedAt: string | null;
  bestEffortsNote: string | null;
  formVersion: string | null;
  numberDisclosed: number | null;
}

export interface AgreementFacts {
  partyId: string;
  type: "BROKERAGE" | "DESIGNATED";
  designatedRepresentativeIds: string[];
  signedAt: string;
  effectiveFrom: string;
  expiresOn: string;
}

export interface OfferFacts {
  id: string;
  receivedAt: string;
  written: boolean;
  status: string;
  acceptedAt: string | null;
  fromOurBrokerage: boolean;
  label: string;
}

export interface TresaFacts {
  side: string;
  offerDate: string; // YYYY-MM-DD
  agentIds: string[];
  /** Same-brokerage deals: the side each agent represents (LISTING, BUYER or BOTH) */
  agentSides?: { userId: string; side: string | null }[];
  parties: PartyFacts[];
  disclosures: DisclosureFacts[];
  agreements: AgreementFacts[];
  offers: OfferFacts[];
  now: string; // ISO timestamp
}

const LISTING_SIDES = new Set(["LISTING", "DUAL", "LANDLORD"]);
const endOfDay = (d: string) => `${d}T23:59:59.999Z`;
const SELLER_ROLES = ["SELLER", "LANDLORD"];
const BUYER_ROLES = ["BUYER", "TENANT"];

/**
 * Whether our brokerage acting for both a seller (landlord) and a buyer (tenant) client on this deal is
 * multiple representation, decided from their representation agreements (O. Reg. 567/05 s.22 to s.22.0.2;
 * RECO Bulletins 2.2 and 3.2):
 *   SEPARATE_DESIGNATED  both designated, with no representative in common: the brokerage represents neither
 *                        and each designated representative acts for one client only. Not multiple representation.
 *   BROKERAGE            both brokerage representation: the brokerage represents both (s.22)
 *   DESIGNATED_SAME      both designated, a representative in common acts for both (s.22.0.1)
 *   MIXED                one brokerage, one designated agreement (s.22.0.2)
 *   UNDETERMINED         an agreement isn't recorded yet: treated as multiple representation until it is
 *   NONE                 we don't act for both a seller and a buyer here
 * Two agents of this brokerage on opposite sides is not by itself multiple representation.
 */
export type RepresentationMode = "NONE" | "SEPARATE_DESIGNATED" | "BROKERAGE" | "DESIGNATED_SAME" | "MIXED" | "UNDETERMINED";

export function classifyRepresentation(f: Pick<TresaFacts, "parties" | "agreements">): { mode: RepresentationMode; citation: string; explanation: string } {
  const clients = f.parties.filter((p) => p.representation === "OUR_CLIENT");
  const sellers = clients.filter((p) => SELLER_ROLES.includes(p.role));
  const buyers = clients.filter((p) => BUYER_ROLES.includes(p.role));
  if (!sellers.length || !buyers.length) return { mode: "NONE", citation: "", explanation: "This brokerage acts for one side only." };
  const latest = (partyId: string) => f.agreements.filter((a) => a.partyId === partyId).sort((a, b) => b.signedAt.localeCompare(a.signedAt))[0];
  const sa = sellers.map((p) => latest(p.id));
  const ba = buyers.map((p) => latest(p.id));
  if ([...sa, ...ba].some((a) => !a)) {
    return { mode: "UNDETERMINED", citation: "O. Reg. 567/05 s.22; RECO Bulletin 3.2",
      explanation: "Both clients are ours and not every representation agreement is recorded: treated as multiple representation until they are." };
  }
  const agreements = [...sa, ...ba] as AgreementFacts[];
  if (agreements.every((a) => a.type === "BROKERAGE")) {
    return { mode: "BROKERAGE", citation: "O. Reg. 567/05 s.22; RECO Bulletin 3.2",
      explanation: "Brokerage representation for both clients: the brokerage represents seller and buyer, so this is multiple representation." };
  }
  if (agreements.every((a) => a.type === "DESIGNATED")) {
    const sellerReps = new Set((sa as AgreementFacts[]).flatMap((a) => a.designatedRepresentativeIds));
    const shared = (ba as AgreementFacts[]).flatMap((a) => a.designatedRepresentativeIds).filter((id) => sellerReps.has(id));
    return shared.length
      ? { mode: "DESIGNATED_SAME", citation: "O. Reg. 567/05 s.22.0.1; RECO Bulletin 3.2",
          explanation: "The same designated representative acts for both seller and buyer: multiple representation." }
      : { mode: "SEPARATE_DESIGNATED", citation: "O. Reg. 567/05 s.22.0.1; RECO Bulletins 2.2 and 3.2",
          explanation: "Separate designated representatives for seller and buyer: not multiple representation. Each keeps their client's confidential information from the other side." };
  }
  return { mode: "MIXED", citation: "O. Reg. 567/05 s.22.0.2; RECO Bulletin 3.2",
    explanation: "Brokerage representation for one client and designated representation for the other: multiple representation." };
}

export function evaluateTresa(f: TresaFacts, opts: { acceptingOfferId?: string } = {}): Finding[] {
  const out: Finding[] = [];
  const of = (partyId: string, kind: string) => f.disclosures.filter((d) => d.partyId === partyId && d.kind === kind);
  const principals = f.parties.filter((p) => ["BUYER", "SELLER", "LANDLORD", "TENANT"].includes(p.role));

  for (const p of principals) {
    if (p.representation === "UNKNOWN") {
      out.push({ rule: "REPRESENTATION_UNKNOWN", citation: "O. Reg. 567/05 s.13; Code of Ethics s.10", severity: "BLOCKING", partyId: p.id,
        message: `Record whether ${p.name} is represented by another brokerage or self-represented` });
    }
  }

  // ── Clients: Information Guide before services, and a compliant agreement ──
  for (const p of principals.filter((x) => x.representation === "OUR_CLIENT")) {
    const agreement = f.agreements.filter((a) => a.partyId === p.id).sort((a, b) => a.signedAt.localeCompare(b.signedAt))[0];
    const servicesBegan = [agreement?.signedAt, endOfDay(f.offerDate)].filter(Boolean).sort()[0]!;
    const guide = of(p.id, "INFORMATION_GUIDE").filter((d) => d.explainedAt).sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt))[0];
    if (!guide) {
      out.push({ rule: "INFORMATION_GUIDE", citation: "O. Reg. 567/05 s.13; RECO Bulletin 2.1", severity: "BLOCKING", partyId: p.id,
        message: `Give ${p.name} the RECO Information Guide and explain it (record both)` });
    } else if (guide.deliveredAt > servicesBegan || guide.explainedAt! > servicesBegan) {
      out.push({ rule: "INFORMATION_GUIDE_LATE", citation: "O. Reg. 567/05 s.13", severity: "BREACH", partyId: p.id,
        message: `The Information Guide reached ${p.name} after services began; broker of record to review` });
    }
    if (!agreement) {
      out.push({ rule: "REPRESENTATION_AGREEMENT", citation: "O. Reg. 567/05 s.13.4; RECO Bulletin 2.3", severity: "BLOCKING", partyId: p.id,
        message: `Record ${p.name}'s representation agreement (dates, remuneration, services, termination terms)` });
    } else {
      if (agreement.expiresOn < f.offerDate || agreement.effectiveFrom > f.offerDate) {
        out.push({ rule: "AGREEMENT_NOT_IN_FORCE", citation: "O. Reg. 567/05 s.13.4", severity: "BREACH", partyId: p.id,
          message: `${p.name}'s representation agreement wasn't in force on the offer date (${agreement.effectiveFrom} to ${agreement.expiresOn})` });
      }
      if (agreement.type === "DESIGNATED") {
        // On a same-brokerage deal only the agents on this client's side act for them
        const mySide = SELLER_ROLES.includes(p.role) ? "LISTING" : "BUYER";
        const actingFor = f.side === "DUAL" && f.agentSides
          ? f.agentSides.filter((a) => a.side === mySide || a.side === "BOTH").map((a) => a.userId)
          : f.agentIds;
        const undesignated = actingFor.filter((id) => !agreement.designatedRepresentativeIds.includes(id));
        if (undesignated.length) {
          out.push({ rule: "DESIGNATED_REPRESENTATIVES", citation: "O. Reg. 567/05 s.13.4; RECO Bulletin 2.2", severity: "WARNING", partyId: p.id,
            message: `An agent on the deal isn't named as ${p.name}'s designated representative` });
        }
      }
    }
  }

  // ── Multiple representation: disclosure and written consent before any step ──
  // Decided from the agreements, not from the deal type: separate designated representatives aren't multiple
  // representation. Consent is recorded by a managing broker or compliance admin (database rule, migration 021).
  const clients = principals.filter((x) => x.representation === "OUR_CLIENT");
  const mode = classifyRepresentation(f);
  const multiple = !["NONE", "SEPARATE_DESIGNATED"].includes(mode.mode);
  if (multiple) {
    const kind = { BROKERAGE: "brokerage", DESIGNATED_SAME: "designated", MIXED: "mixed brokerage and designated", UNDETERMINED: "possible" }[mode.mode as "BROKERAGE"];
    for (const p of clients) {
      const disclosed = of(p.id, "MULTIPLE_REPRESENTATION_DISCLOSURE")[0];
      const consent = of(p.id, "MULTIPLE_REPRESENTATION_CONSENT")[0];
      if (!disclosed || !consent) {
        out.push({ rule: "MULTIPLE_REPRESENTATION", citation: mode.citation, severity: "BLOCKING", partyId: p.id,
          message: `Multiple representation (${kind}): give ${p.name} the written disclosure and get their written consent before any further step` });
        continue;
      }
      if (consent.acknowledgedAt! > endOfDay(f.offerDate)) {
        out.push({ rule: "MULTIPLE_REPRESENTATION_LATE", citation: mode.citation, severity: "BREACH", partyId: p.id,
          message: `${p.name}'s consent to multiple representation is dated after the offer; RECO considers consent at offer time almost always too late` });
      }
      if (!disclosed.acknowledgedAt && !disclosed.bestEffortsNote) {
        out.push({ rule: "MULTIPLE_REPRESENTATION_ACKNOWLEDGEMENT", citation: `${mode.citation}; s.22(5)`, severity: "WARNING", partyId: p.id,
          message: `Record ${p.name}'s written acknowledgement of the disclosure, or the best efforts made to get it` });
      }
    }
  }

  // ── Self-represented parties: guide and the SRP form before assisting; no advice ──
  for (const p of principals.filter((x) => x.representation === "SELF_REPRESENTED")) {
    const assisted = endOfDay(f.offerDate);
    const guide = of(p.id, "INFORMATION_GUIDE").find((d) => d.explainedAt);
    const form = of(p.id, "SELF_REPRESENTED_PARTY_FORM").find((d) => d.explainedAt);
    if (!guide || !form) {
      out.push({ rule: "SELF_REPRESENTED_PARTY", citation: "O. Reg. 567/05 s.13; Code of Ethics s.10; RECO Bulletin 2.4", severity: "BLOCKING", partyId: p.id,
        message: `${p.name} is self-represented: give and explain the Information Guide and the RECO self-represented party form` });
      continue;
    }
    if (guide.deliveredAt > assisted || form.deliveredAt > assisted) {
      out.push({ rule: "SELF_REPRESENTED_PARTY_LATE", citation: "O. Reg. 567/05 s.13", severity: "BREACH", partyId: p.id,
        message: `${p.name} received the self-represented party disclosures after the offer` });
    }
    const clientAgreement = f.agreements.find((a) => clients.some((c) => c.id === a.partyId));
    const expected = clientAgreement?.type === "DESIGNATED" ? "DESIGNATED_REPRESENTATION" : "BROKERAGE_REPRESENTATION";
    if (form.formVersion !== expected) {
      out.push({ rule: "SELF_REPRESENTED_FORM_VERSION", citation: "RECO Bulletin 2.4", severity: "WARNING", partyId: p.id,
        message: `${p.name} was given the ${form.formVersion?.toLowerCase().replaceAll("_", " ")} form; our client's agreement calls for the ${expected.toLowerCase().replaceAll("_", " ")} form` });
    }
    if (!form.acknowledgedAt && !form.bestEffortsNote) {
      out.push({ rule: "SELF_REPRESENTED_ACKNOWLEDGEMENT", citation: "RECO Bulletin 2.4", severity: "WARNING", partyId: p.id,
        message: `Record ${p.name}'s written acknowledgement of the self-represented party form, or the best efforts made` });
    }
  }

  // ── Competing offers (listing side) ─────────────────────────────────────────
  if (LISTING_SIDES.has(f.side)) {
    const accepted = f.offers.find((o) => o.status === "ACCEPTED");
    const acceptance = accepted?.acceptedAt ?? (opts.acceptingOfferId ? f.now : null);
    const written = f.offers.filter((o) => o.written && (!acceptance || o.receivedAt <= acceptance));
    const offerOf = (o: OfferFacts, kind: string) => f.disclosures.filter((d) => d.offerId === o.id && d.kind === kind);
    const check = (o: OfferFacts, kind: string, rule: string, citation: string, what: string) => {
      const done = offerOf(o, kind).filter((d) => d.deliveredAt >= o.receivedAt);
      if (done.length === 0) {
        out.push({ rule, citation, severity: accepted ? "BREACH" : "BLOCKING", offerId: o.id,
          message: accepted ? `${what} wasn't disclosed to ${o.label} before acceptance` : `Disclose ${what} to ${o.label} before any offer is accepted` });
        return null;
      }
      if (acceptance && done.every((d) => d.deliveredAt > acceptance)) {
        out.push({ rule: `${rule}_LATE`, citation, severity: "BREACH", offerId: o.id, message: `${what} reached ${o.label} after acceptance` });
      }
      return done;
    };
    if (written.length >= 2) {
      for (const o of written) {
        const done = check(o, "COMPETING_OFFERS_NUMBER", "COMPETING_OFFERS_NUMBER", "O. Reg. 567/05 s.22.7; RECO Bulletin 4.1", "the number of competing written offers");
        const latest = done?.sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt))[0];
        if (latest) {
          const atTime = written.filter((x) => x.receivedAt <= latest.deliveredAt).length;
          if (latest.numberDisclosed !== atTime) {
            out.push({ rule: "COMPETING_OFFERS_COUNT", citation: "O. Reg. 567/05 s.22.7", severity: "WARNING", offerId: o.id,
              message: `${o.label} was told ${latest.numberDisclosed} offers; ${atTime} written offers had been received by then` });
          }
        }
      }
      // Content: shared with one means shared with all
      if (f.disclosures.some((d) => d.kind === "COMPETING_OFFERS_CONTENT")) {
        for (const o of written) check(o, "COMPETING_OFFERS_CONTENT", "COMPETING_OFFERS_CONTENT", "O. Reg. 567/05 s.22.7", "the offer content the seller directed be shared");
      }
    }
    // Seller and buyer clients in this brokerage (a same-brokerage deal, or a buyer client's offer on our
    // listing): every other buyer making a written offer is told, before any offer is accepted (s.22.0.3).
    // This applies whatever the representation mode, separate designated representatives included.
    const bothClients = mode.mode !== "NONE" || written.some((o) => o.fromOurBrokerage);
    if (bothClients) {
      for (const o of written.filter((x) => !x.fromOurBrokerage)) {
        check(o, "SAME_BROKERAGE_REPRESENTATION", "SAME_BROKERAGE_REPRESENTATION", "O. Reg. 567/05 s.22.0.3; RECO Bulletin 3.2",
          "that this brokerage represents both the seller and a buyer making an offer");
      }
    }
    // Two buyers this brokerage represents competing for the property: each buyer's consent to that multiple
    // representation (or confirmation that they have separate designated representatives), recorded against
    // their offer by a managing broker or compliance admin before any offer is accepted
    const ours = written.filter((o) => o.fromOurBrokerage);
    if (ours.length >= 2) {
      for (const o of ours) {
        const consent = offerOf(o, "COMPETING_BUYERS_CONSENT");
        if (consent.length === 0) {
          out.push({ rule: "COMPETING_BUYER_CLIENTS", citation: "O. Reg. 567/05 s.22 to s.22.0.2; RECO Bulletin 3.2", severity: accepted ? "BREACH" : "BLOCKING", offerId: o.id,
            message: accepted
              ? `${o.label} was one of ${ours.length} competing buyers this brokerage represents; their consent wasn't recorded before acceptance`
              : `${ours.length} buyers this brokerage represents are competing: record ${o.label}'s written consent to multiple representation (or that they have separate designated representatives) before any offer is accepted` });
        }
      }
    }
  }
  return out;
}
