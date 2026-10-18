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
  parties: PartyFacts[];
  disclosures: DisclosureFacts[];
  agreements: AgreementFacts[];
  offers: OfferFacts[];
  now: string; // ISO timestamp
}

const LISTING_SIDES = new Set(["LISTING", "DUAL", "LANDLORD"]);
const endOfDay = (d: string) => `${d}T23:59:59.999Z`;

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
        const undesignated = f.agentIds.filter((id) => !agreement.designatedRepresentativeIds.includes(id));
        if (undesignated.length) {
          out.push({ rule: "DESIGNATED_REPRESENTATIVES", citation: "O. Reg. 567/05 s.13.4; RECO Bulletin 2.2", severity: "WARNING", partyId: p.id,
            message: `An agent on the deal isn't named as ${p.name}'s designated representative` });
        }
      }
    }
  }

  // ── Multiple representation: disclosure and written consent before any step ──
  const clients = principals.filter((x) => x.representation === "OUR_CLIENT");
  const multiple = f.side === "DUAL" || (clients.some((c) => ["SELLER", "LANDLORD"].includes(c.role)) && clients.some((c) => ["BUYER", "TENANT"].includes(c.role)));
  if (multiple) {
    for (const p of clients) {
      const disclosed = of(p.id, "MULTIPLE_REPRESENTATION_DISCLOSURE")[0];
      const consent = of(p.id, "MULTIPLE_REPRESENTATION_CONSENT")[0];
      if (!disclosed || !consent) {
        out.push({ rule: "MULTIPLE_REPRESENTATION", citation: "O. Reg. 567/05 s.22; RECO Bulletin 3.2", severity: "BLOCKING", partyId: p.id,
          message: `Multiple representation: give ${p.name} the written disclosure and get their written consent` });
        continue;
      }
      if (consent.acknowledgedAt! > endOfDay(f.offerDate)) {
        out.push({ rule: "MULTIPLE_REPRESENTATION_LATE", citation: "O. Reg. 567/05 s.22; RECO Bulletin 3.2", severity: "BREACH", partyId: p.id,
          message: `${p.name}'s consent to multiple representation is dated after the offer; RECO considers consent at offer time almost always too late` });
      }
      if (!disclosed.acknowledgedAt && !disclosed.bestEffortsNote) {
        out.push({ rule: "MULTIPLE_REPRESENTATION_ACKNOWLEDGEMENT", citation: "O. Reg. 567/05 s.22(5)", severity: "WARNING", partyId: p.id,
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
    if (f.side !== "DUAL" && written.some((o) => o.fromOurBrokerage)) {
      for (const o of written.filter((x) => !x.fromOurBrokerage)) {
        check(o, "SAME_BROKERAGE_REPRESENTATION", "SAME_BROKERAGE_REPRESENTATION", "O. Reg. 567/05 s.22.0.3; RECO Bulletin 3.2",
          "that this brokerage also represents a buyer making an offer");
      }
    }
  }
  return out;
}
