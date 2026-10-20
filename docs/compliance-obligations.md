# TRESA and FINTRAC obligations

Each deal is checked against two rule sets, and the result is shown at `GET /api/deals/:id/obligations`:

- `backend/src/obligations/tresa.ts`
- `backend/src/obligations/fintrac.ts`

Each finding gives the rule, its citation and a severity:

| Severity | Meaning |
|---|---|
| **BLOCKING** | Must be done. Blocks the broker of record's trade record sheet signature. The offer rules also block accepting an offer. |
| **BREACH** | Already happened too late. It can't be fixed, only reviewed by the broker of record. |
| **WARNING** | Should be done or checked. |

Citations and the points still unverified are in `regulatory-references.md` §5 and §7.

## Who is who

- **How each buyer and seller is represented:**
  - our client: the deal's side, or both sides on a double-ended deal;
  - represented by another brokerage: the default when a co-operating brokerage is on the deal;
  - self-represented.
- **Unknown representation** (no co-operating brokerage, nothing recorded) is BLOCKING until someone records it: `POST /api/deals/:id/parties/:partyId/representation`.
- **Self-represented parties:** marking a party self-represented also adds their FINTRAC identification record. Unrepresented parties have been in scope since 2025-10-01.

## TRESA rules

| Rule | What's checked |
|---|---|
| Information Guide (s.13) | Delivered **and explained** to each client before services began (the earlier of the agreement and the offer date) |
| Representation agreement (s.13.4) | On file with dates, remuneration, services and termination terms; in force on the offer date; designated agreements name the agents |
| Multiple representation (s.22–22.0.2) | Decided from the representation agreements in force on the offer date (see below). Written disclosure that explains the changes in duties, services and remuneration and advises independent advice; acknowledgement or best efforts; each client's **signed written consent**, uploaded, with the date the multiple representation arose. A consent signed after that date is flagged for the broker of record's review (not declared a breach) |
| Our buyers' offers (s.22–22.0.2, Bulletin 3.2) | Each offer from a buyer we represent records how they're represented. Multiple representation only where they share a designated agent with another of our buyers or with our seller, or either is under brokerage representation: then a signed consent against that offer before acceptance. Not recorded: "representation not verified", acceptance waits |
| Remuneration under both agreements (Bulletin 3.3) | When we act for seller and buyer (any mode), each client gets the remuneration terms of both agreements in writing before the deal goes firm |
| Variable commission (counsel to confirm the section) | If the seller's commission changes with who represents the buyer, every written offeror is told before acceptance |
| Self-represented party (s.13, Code s.10) | Guide and the RECO SRP form (the right version) before assisting; acknowledgement or best efforts |
| Competing offers: number (s.22.7) | With two or more **written** offers, each offeror is told the number, after their offer and before acceptance |
| Competing offers: content (s.22.7) | Only under the seller's written direction in force at the time (enforced by the database), and then to every offeror |
| Same brokerage (s.22.0.3) | If the brokerage also represents an offering buyer, every other written offeror is told before acceptance |

**Accepting an offer is refused** while any offer disclosure or consent is owed, or a buyer's representation isn't recorded. **Marking a deal firm is refused** while representation is unverified, multiple-representation consent is owed, or the remuneration disclosure is owed. The broker of record can't sign the trade record while anything is blocking. What the software can't stop is an agent acting outside the app before consent: that stays a matter of policy and supervision.

## Same-brokerage deals (both sides ours)

A deal where we act for seller and buyer is classified from the latest representation agreement of each client:

| Agreements | Result | Consent needed |
|---|---|---|
| Each client designates different agents (every co-designated agent compared) | Separate designated representatives: **not** multiple representation (s.22.0.1) | No; each agent keeps their client's information from the other side |
| Brokerage representation for both | Multiple representation, brokerage (s.22) | Yes |
| The same agent designated for both | Multiple representation, designated (s.22.0.1) | Yes |
| One brokerage, one designated | Mixed (s.22.0.2) | Yes |
| An agreement not recorded yet | Representation not verified: further activity requires review (not called multiple representation) | Record both agreements first |

- **Who records consent:** only an active managing broker or compliance admin, with the signed copy uploaded to the deal's "Multiple representation: signed disclosures and consents" slot (it appears when consent is needed). The database refuses an agent, a missing file, a file from another deal, or a missing "arose on" date (migrations 021, 022).
- **Other buyers (s.22.0.3):** told before acceptance whenever we act for the seller and also represent an offering buyer, including separate designated representatives.
- **Confidential information:** on a same-brokerage deal, an agent acting for one side reaches only their own client's documents, FINTRAC records, findings, disclosures and agreements. The buyer's agent sees only their own buyer's offer, never competing offers, and can't record offers, outcomes or the seller's direction. Compliance and the broker of record see everything (supervision). The office admin can't open client files or full FINTRAC details. All of this is enforced in the API and tested by direct requests. The app stores no negotiating instructions, motivations or price limits; if notes are ever added they must follow the same side rules.
- **Commission:** each side's commission is entered separately (`listingSideGci`, `buyerSideGci`), counted once, and who pays the buyer side is recorded, never assumed (`buyerSideSellerPays`, `remunerationSource`). See `commission-engine.md`. Disclosures are recorded with `POST /api/deals/:id/disclosures`, agreements with `…/representation-agreements`, and directions with `…/offer-directions`.

## FINTRAC rules

| Rule | What's checked |
|---|---|
| Identity | Approved identification record for each client and each unrepresented party. Persons are verified at the time of the transaction (taken as the offer date); entities within 30 days |
| Beneficial ownership | Entities: measures taken to confirm it |
| PEP / HIO | A determination with a risk rating for each client. A foreign PEP is always high risk (database check). High risk means enhanced measures |
| Business relationship | Purpose and intended nature, within 30 days |
| Receipt of funds | A record for **every** deposit, any amount. The payer's personal details are encrypted. Funds from a financial entity or public body need the exemption stated |
| Large cash / virtual currency | $10,000+ from the same payer within 24 hours (across deals) **opens a report task automatically**, due 15 days later |
| Suspicious transaction / listed person property | Opened by the compliance officer or a managing broker, due immediately |
| Reports | Filed by a person in FINTRAC's own system, then closed here with FINTRAC's acknowledgement number. **Nothing is sent from this system** |

**The PEP/HIO trigger for real estate is unverified.** The engine requires a determination for every client (the strict reading) until counsel confirms otherwise.

## Compliance program (`GET /api/fintrac/program`)

- the compliance officer;
- approved policies;
- a risk assessment (reviewed yearly, a brokerage policy);
- training for each agent (yearly, a brokerage policy);
- the two-year effectiveness review.

Each is recorded with `POST /api/fintrac/program`, by the compliance officer or a managing broker.

## Needs sign-off

- Counsel: the reading of O. Reg. 567/05 s.22–22.0.5 and the subsection citations shown on screen. The e-Laws text and RECO Bulletins couldn't be fetched from the build environment, so they come from the earlier research notes (`regulatory-references.md`).
- Counsel: that separate designated representatives at one brokerage need no consent; that a late consent is for review rather than an automatic breach; the RECO Bulletin 3.3 remuneration disclosure; and the section for the variable-commission disclosure to offerors (the reviewer cited s.23(4); not verified here).
- Broker of record: the wording of the competing-buyer consent and of the written disclosure to other buyers.
- Counsel: the PEP/HIO trigger and timing; using the offer date as "the time of the transaction".
- Counsel: the exact fields of the unrepresented-party record.
- The compliance officer: the written policies these rules implement, and the yearly training and risk-assessment cadence.
