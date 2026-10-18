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
| Multiple representation (s.22) | Written disclosure and each client's **written consent**, before the offer; acknowledgement or best efforts |
| Self-represented party (s.13, Code s.10) | Guide and the RECO SRP form (the right version) before assisting; acknowledgement or best efforts |
| Competing offers: number (s.22.7) | With two or more **written** offers, each offeror is told the number, after their offer and before acceptance |
| Competing offers: content (s.22.7) | Only under the seller's written direction in force at the time (enforced by the database), and then to every offeror |
| Same brokerage (s.22.0.3) | If the brokerage also represents an offering buyer, every other written offeror is told before acceptance |

**Accepting an offer is refused** while any offer disclosure is owed. Disclosures are recorded with `POST /api/deals/:id/disclosures`, agreements with `…/representation-agreements`, and directions with `…/offer-directions`.

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

- Counsel: the PEP/HIO trigger and timing; using the offer date as "the time of the transaction".
- Counsel: the exact fields of the unrepresented-party record.
- The compliance officer: the written policies these rules implement, and the yearly training and risk-assessment cadence.
