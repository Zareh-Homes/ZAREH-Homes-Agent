# Regulatory references: Zareh Homes back office (Ontario)

Researched 2026-10-18.

**How this was researched.** The sandbox proxy blocked direct page fetches of ontario.ca, reco.on.ca, canlii.org, fintrac-canafe.canada.ca and canada.ca. Every fact below comes from **web-search excerpts of those primary pages**, mainly e-Laws/CanLII consolidations, RECO bulletins, FINTRAC guidance, CRA and OPC pages. The full current consolidations were **not** read end-to-end. As a result, "last amended" dates could not be read from e-Laws for any instrument. Treat all subsection numbering as **verify-before-relying**.

Markers used:
- **UNVERIFIED**: could not be confirmed from a primary source.
- **PARTIAL**: the primary source was seen only as a truncated excerpt.

Key instruments under TRESA, in force 2023-12-01 (RECO bulletins effective that date):
- Trust in Real Estate Services Act, 2002, S.O. 2002, c. 30, Sch. C ("TRESA", formerly REBBA 2002).
- **O. Reg. 567/05 (General)**: registration, trust accounts, representation, multiple representation, competing offers.
- **O. Reg. 579/05 (Educational Requirements, Insurance, Records and Other Matters)**: records, reconciliation, shortfall, trade record sheet, retention.
- **O. Reg. 365/22 (Code of Ethics)**: replaced O. Reg. 580/05, which was revoked 2023-12-01.

---

## 1. Trust money and trust accounts (TRESA s.27; O. Reg. 567/05)

**Requirements**

| Rule | Citation | Notes |
|---|---|---|
| Maintain a trust account in Ontario at a bank, loan or trust corporation, credit union or Province of Ontario Savings Office. Keep trust money separate from the brokerage's own money. | TRESA s.27(1) | Having a s.27 trust account is also a registration requirement (O. Reg. 567/05). |
| Disclose the deposit terms in writing, including whether the account earns interest. Interest belongs to the beneficial owner unless a contract says otherwise. | TRESA s.27(2), (3) | PARTIAL; numbering is from the CanLII copy. |
| **Only one** s.27 trust account, **unless the registrar consents in writing**. | O. Reg. 567/05 **s.14** | |
| Account must be designated "Real Estate Trust Account". | O. Reg. 567/05 **s.15** | |
| **Deposit trust money in the s.27 account within five business days** after it comes into the brokerage's hands. | O. Reg. 567/05 **s.17(1)** | |
| "Business day" = **a day that is not a Saturday or a holiday within the meaning of s.87 of the Legislation Act, 2006**. | O. Reg. 567/05 **s.17(2)** | Sunday is itself a "holiday" under the Legislation Act. See §10. |
| Trust-account transactions need the broker of record's authorization. | O. Reg. 567/05 s.19 | PARTIAL |
| Commission trust account | **UNVERIFIED** | No regulation section on a "commission trust account" was found. RECO's annual filing lists "commission trust" as an account type alongside real estate trust, general and other (see §6), so the platform must support it as a separate account type. The legal basis and rules for it are UNVERIFIED. |

**URLs**
- https://www.canlii.org/en/on/laws/regu/o-reg-567-05/latest/o-reg-567-05.html
- https://www.ontario.ca/laws/regulation/050567
- https://www.canlii.org/en/on/laws/stat/so-2002-c-30-sch-c/latest/so-2002-c-30-sch-c.html

**Implementation**
- `trust_receipt` records: `received_at`, `deposit_due_date` (= received_at + 5 business days, excluding Saturdays and Legislation Act holidays), `deposited_at`, `account_id`. Raise an alert before the due date and flag a breach after it.
- Account register: type (real_estate_trust, commission_trust, general, other) and a registrar-consent document reference. Block creating a second real-estate trust account unless that consent reference exists.
- Each disbursement records who authorized it (broker of record).

## 2. Monthly reconciliation (O. Reg. 579/05 s.13) and shortfall (s.14)

**s.13 timing.** A trust account reconciliation must be prepared for each trust account:
- (a) if the brokerage receives a monthly statement from the financial institution: **within 30 days after the date the monthly account statement is received**;
- (b) otherwise: **within 30 days after the last day of each month.**

**s.13 contents (PARTIAL).** The reconciliation must:
- identify the differences between the brokerage's records and the institution's records as of the statement date or month-end;
- list the trust balance owed to each person;
- be signed and dated by the person who reviewed it.

RECO guidance (For the Record, June 2025): the broker of record may hire a qualified professional to prepare reconciliations but stays responsible. The broker of record **must review, sign and date all reconciliations within 30 days after the last day of each month.**

**s.14 shortfall.** If the brokerage determines there is a shortfall in a trust account, it must **immediately notify the registrar** and **deposit sufficient funds to eliminate the shortfall**.

**Service-fee exception (RECO Bulletin 8.2, effective 2023-12-01).** Quoted from the search excerpt:
> "Where the shortfall results from financial institution service fees, a brokerage is not required to notify RECO as long as the shortfall is eliminated as soon as it is discovered."

The exception has two conditions:
1. The cause is **solely** financial-institution service fees.
2. The shortfall is eliminated **as soon as it is discovered**.

RECO does not further define "service fees" (for example, whether NSF or overdraft charges qualify): **UNVERIFIED**.

**URLs**
- https://www.canlii.org/en/on/laws/regu/o-reg-579-05/latest/o-reg-579-05.html
- https://www.ontario.ca/laws/regulation/050579
- https://www.reco.on.ca/agents-and-brokerages/reco-bulletins/reco-bulletin-8-2-shortfalls-and-missing-property/
- https://www.reco.on.ca/wp-content/uploads/RECO-Bulletin-8-2-Shortfalls-and-missing-property.pdf
- https://www.reco.on.ca/news/for-the-record-brokerage-leadership-edition-june2025

**Implementation**
- Per account and month, store:
  - statement received date;
  - due date: received + 30 days, or month-end + 30 days if no statement. Also show the RECO-guidance date (month-end + 30) and use the **earlier** of the two;
  - book balance, bank balance and reconciling items;
  - client-ledger listing (balance per person) and the variance;
  - preparer;
  - broker-of-record signature and timestamp.
- If trust liabilities exceed trust assets, open a shortfall incident with these fields: cause (`bank_service_fee` or `other`), discovered_at, replenished_at, registrar_notified_at, and a notification-evidence document.
  - For `other`, require registrar notification immediately.
  - For `bank_service_fee`, require immediate replenishment; notification is not required.
- RECO enforcement frequently cites late reconciliations and unreported shortfalls (For the Record, June 2026).

## 3. Unclaimed trust money (TRESA s.27(4) and following; RECO Bulletin 8.1)

**Requirement.** If a brokerage has held trust money for **two years** and entitlement is not determined or unclear, it must pay the money to the administrative authority, RECO (TRESA **s.27(4)**; PARTIAL numbering). RECO's bulletin applies the same rule when the person entitled **cannot be located two years after becoming entitled**.

**Conditions and exceptions (Bulletin 8.1, effective 2023-12-01)**
- Before paying, the brokerage must make **reasonable efforts to locate** the person entitled. RECO expects those efforts throughout the two years.
- Interest-bearing accounts: pay the principal **plus interest accrued** until payment.
- **Less than $25.00**: the brokerage is not required to forward the money, but may.
- RECO holds the money in trust. After 5 years it goes to the Minister of Finance (s.27(8), (11)). Paying it over does not extinguish anyone's claim (s.27(13)). PARTIAL numbering.
- Annual declaration: brokers of record must declare annually whether they hold unclaimed trust money, even if none (RECO, June 2025). This is now part of the annual financial filing (§6).

**Remittance package (Bulletin 8.1):**
- the payment;
- the agreement of purchase and sale;
- the trade record sheet;
- the relevant trust account records;
- proof of unsuccessful attempts to contact the entitled person or persons during the two years. The PDF version instead says: any information on why entitlement is undetermined or unclear.

The web and PDF versions differ, so include both.

**URLs**
- https://www.reco.on.ca/agents-and-brokerages/reco-bulletins/reco-bulletin-8-1-unclaimed-money-in-the-real-estate-trust-account/
- https://www.reco.on.ca/wp-content/uploads/RECO-Bulletin-8-1-Unclaimed-money-in-the-real-estate-trust-account.pdf

**Implementation**
- Each trust ledger item tracks:
  - `held_since`;
  - `entitlement_status` (determined, unclear, disputed);
  - `entitled_party_located` (bool);
  - a contact-attempt log (date, method, outcome, evidence file);
  - accrued interest.
- Set `remit_due` to held_since + 2 years, or entitled_since + 2 years. Escalate at 18, 21 and 23 months.
- Remittance record: amount, interest, date paid to RECO and attached package. Apply the under-$25 option.
- Feed the data into the annual-filing unclaimed figures (§6).

## 4. Trade record sheet and record retention (O. Reg. 579/05 s.17, s.19)

**s.17(1) requirement.** A brokerage that provides services to a client who enters into an agreement dealing with the conveyance of an interest in real estate must complete a trade record sheet that includes the following. Wording is as seen in CanLII excerpts (PARTIAL):

1. The nature of the trade.
2. A description of the property.
3. The true consideration.
4. The names of all parties to the trade.
5. The names and contact information of any lawyers acting for parties.
6. The names and contact information of any registrants representing parties.
7. The deposit: the amount if money, or a description sufficient to identify it if not money. Who holds it is UNVERIFIED.
8. The amount of the brokerage's remuneration and the name of the party paying it.
9. The amount of any remuneration payable to another brokerage and the name of that brokerage.
10. Any further items: **UNVERIFIED**. The excerpt ended at item 9, so the list may not be complete.

**Who and when**
- s.17(2): the broker or salesperson representing the client enters the information.
- s.17(3): when no conditions remain outstanding, that person reviews the sheet, corrects and initials any changes, and signs it.
- s.17(4): corrections must leave earlier entries legible.
- s.17(5): the **broker of record** reviews the sheet and signs it.

All of this is PARTIAL numbering.

**Retention, O. Reg. 579/05 s.19(1).** Keep all documents and records required under the Act and regulations for the period the registrar specifies, or **at least six years** if none is specified. Keep them at the brokerage's main office unless the registrar specifies otherwise. RECO's older Q&A cited s.18 or s.19. Destroying records after 6 years does not need RECO permission.

**Unaccepted offers, s.19(2).** A brokerage acting for a **seller** must keep a copy of each written offer that was not accepted for **at least one year after the date the brokerage received it**. RECO's older Q&A cited s.20.

**URLs**
- https://www.canlii.org/en/on/laws/regu/o-reg-579-05/latest/o-reg-579-05.html
- https://www.reco.on.ca/news/ask-the-registrar-how-long-do-i-have-to-keep-old-files-to-be-compliant-do-we-require-written-permi

**Implementation**
- The trade record sheet entity has fields for items 1 to 9, plus an "additional items" slot until item 10 onwards is verified.
- Workflow: agent completes, then waits for `conditions_cleared_at`, then the agent signs (with an audit trail of corrections and initials), then the broker of record signs.
- Corrections are append-only, never overwritten.
- Retention: `retain_until` = completion + 6 years. Unaccepted offers on seller-side deals: received + 1 year minimum, with deletion locked before that date.

## 5. Consumer-facing duties: TRESA, O. Reg. 567/05 and the Code of Ethics (O. Reg. 365/22)

Several of these duties now sit in **O. Reg. 567/05**, not in the Code. Section numbers are PARTIAL or UNVERIFIED where marked.

| Topic | Requirement | Citation |
|---|---|---|
| RECO Information Guide | The registrar publishes the guide. **Before** a registrant provides services to a client, or assistance to a self-represented party, they must give the person a copy (or link) **and explain its contents**. | O. Reg. 567/05 **s.13** (13(1) guide; contents 13(2); duty to provide, subsequent subsection; PARTIAL). RECO Bulletin 2.1. Replaces old 580/05 s.10. |
| Representation agreements | Representation agreements are with the **brokerage**, as either a *brokerage representation* agreement or a *designated representation* agreement. A written buyer or seller agreement must clearly, comprehensibly and prominently set out: effective and expiry dates; how remuneration is calculated and paid; the services the brokerage will provide; and termination terms. A designated agreement must also state that the brokerage will not provide representation, name each designated representative, list their services, and set out the duties of the brokerage and of the designated representative. Implied agreements: Bulletin 2.7. | O. Reg. 567/05 **s.13.4** (per RECO Bulletin 2.3). Bulletins 2.2 and 2.3. |
| Brokerage vs designated representation | *Brokerage*: all agents of the brokerage owe the client the same duties. *Designated*: only the named agents represent the client; the brokerage and other agents stay neutral, and the designated representative protects the client's confidential information. | Bulletin 2.2 |
| Multiple representation (brokerage) | Not permitted unless the brokerage (a) gives a written disclosure (the fact of multiple representation and how duties, services and remuneration change), (b) makes best efforts to get a written acknowledgement, and (c) gets **each client's written consent**. No steps may be taken for any client until then. RECO: consent at the time an offer is submitted is "in almost all circumstances, too late". If an agreement would immediately create multiple representation, consent must be obtained **before** entering the agreement. The brokerage must treat the clients impartially. | O. Reg. 567/05 **s.22(1), s.22(5)**; Bulletin 3.2 |
| Multiple representation (designated) | Parallel rules apply to one designated representative acting for multiple clients, and to a brokerage plus designated representative acting for different clients. | O. Reg. 567/05 **s.22.0.1, s.22.0.2** (PARTIAL) |
| Seller and buyer clients in the same brokerage | Disclose this to **every other buyer who makes a written offer**, as soon as possible after receiving their offer and **before the seller accepts any offer**. | O. Reg. 567/05 **s.22.0.3** (per RECO); Bulletin 3.2 |
| Self-represented parties (SRP) | (1) Confirm the person is self-represented. (2) **Before assisting**, give and explain the RECO Information Guide **and** the RECO **"Information and Disclosure to Self-represented Party"** form. There are two versions: brokerage-representation and designated-representation. (3) Make best efforts to get a **written acknowledgement**, and give the SRP a copy. (4) Do not provide services, opinions or advice to an SRP. | O. Reg. 567/05 s.13 (PARTIAL); Code O. Reg. 365/22 **s.10** (no services or advice to SRP; PARTIAL); Bulletin 2.4 |
| Competing offers: number | The seller's brokerage must disclose the **number** of competing written offers to every buyer who has submitted a written offer. Verbal or unsubmitted offers do not count. | O. Reg. 567/05 **s.22.7** (PARTIAL; old rule was 580/05 s.26). Bulletin 4.1 |
| Competing offers: content | Content may be shared **only on the seller's written direction**. Email or text is acceptable. The direction must identify which content to share. If given, the content must be shared with **every** offeror. Personal or identifying information about an offeror may **never** be shared. The seller may change the direction at any time. | O. Reg. 567/05 s.22.7; Bulletin 4.1 |
| Registrar disclosure of offer information | The registrar may disclose offer information in specified circumstances (TRESA offer-verification regime). | O. Reg. 567/05 **s.22.8** (PARTIAL; the details are UNVERIFIED) |
| Unsuccessful offers retention | Seller's brokerage keeps each unaccepted written offer for **≥1 year from receipt**. | O. Reg. 579/05 **s.19(2)** (see §4) |

**URLs**
- https://www.canlii.org/en/on/laws/regu/o-reg-365-22/latest/o-reg-365-22.html
- https://www.ontario.ca/laws/regulation/r22365 (e-Laws path UNVERIFIED)
- RECO bulletins:
  - Bulletin 2.1: https://www.reco.on.ca/agents-and-brokerages/reco-bulletins/reco-bulletin-2-1-reco-information-guide/
  - Bulletin 2.2: https://www.reco.on.ca/agents-and-brokerages/reco-bulletins/reco-bulletin-2-2-representation/
  - Bulletin 2.3: https://www.reco.on.ca/agents-and-brokerages/reco-bulletins/reco-bulletin-2-3-representation-agreements
  - Bulletin 2.4: https://www.reco.on.ca/agents-and-brokerages/reco-bulletins/reco-bulletin-2-4-dealing-with-a-self-represented-party
  - Bulletin 3.2: https://www.reco.on.ca/agents-and-brokerages/reco-bulletins/reco-bulletin-3-2-multiple-representation
  - Bulletin 4.1: https://www.reco.on.ca/agents-and-brokerages/reco-bulletins/reco-bulletin-4-1-number-and-content-of-competing-offers
- SRP form (brokerage representation): https://www.reco.on.ca/getmedia/53843103-2d89-4da6-ae55-52dd14da1387/RECO-Information-and-Disclosure-to-Self-Represented-Party-form-brokerage-rep.pdf
- SRP form (designated representation): https://www.reco.on.ca/getmedia/087aad54-8e6a-45b9-9155-b0feca182548/RECO-Information-and-Disclosure-to-Self-Represented-Party-form-designated-rep.pdf
- Guide-sharing tool: https://www.reco.on.ca/recoinformationguide. Its links expire in 7 days and it sends email confirmations.

**Implementation**
- Per contact and deal, record:
  - `info_guide_delivered_at`, method and `explained_at`, which must precede any `services_started_at` or `agreement_signed_at`;
  - SRP form version, delivered and explained, `acknowledgement_received_at` or a log of best efforts;
  - representation type (brokerage or designated) and designated representatives;
  - agreement dates, remuneration terms, services and termination terms;
  - for multiple representation: disclosure date, acknowledgement, and each client's written consent date, which must come before any step for either client;
  - same-brokerage seller and buyer disclosure to other offerors, timestamped before acceptance.
- Offers log per listing: received_at, written (bool), status, and the seller's content-sharing direction (document, scope, version history). Record each disclosure to each offeror, with fields redacted to exclude identifying information.

## 6. RECO annual financial filing (launched 2026)

**Authority.** RECO's Registrar Request for Information and Compliance Bulletin says the filing is requested under **TRESA s.48.1**. Whether a separate regulation amendment exists: **UNVERIFIED**.

**Deadlines**
- Filing opens in **MyWeb from 2026-10-01**.
- **Initial filing**: fiscal years ending **2025-08-01 to 2026-07-31**, due **2026-10-30**.
- **Ongoing**: fiscal year-ends on or after 2026-08-01 are due **no later than 90 days after fiscal year-end**.
- Brokerages with no trading activity file a **Non-trading Report** instead.
- Non-filers face prosecution, fines, suspension, refusal to renew or revocation.

**Information required.** Per RECO's "Submission and information requirements" page; check MyWeb for the final form.

| Area | Items |
|---|---|
| Balance sheet | cash, total assets, liabilities, equity |
| Income statement | revenue, gross profit, expenses, net income |
| Trust | total trust liabilities, total trust assets, trust asset balance, **interest retained by the brokerage** |
| Unclaimed trust funds | split by **unclear entitlement** vs **owner cannot be located**; and funds **held more than 2 years at fiscal year-end** |
| Bank accounts (each) | institution name and branch, account number, type (**real estate trust, commission trust, general, other**), and whether opened, closed or maintained during the year |
| Activity | **number of trades in real estate closed during the fiscal year** |
| Broker of record attestations | sufficiency of trust funds; separation of trust and brokerage money; monthly trust reconciliations performed; shortfalls immediately reported and replenished; prompt notice to RECO of financial distress or changes in directors, officers or shareholders; accuracy of the submitted information |

**Next step.** RECO "plans to introduce **monthly trust reconciliation reporting** requirements in **2027**". Format and dates: **UNVERIFIED**, not yet published as far as found.

**URLs**
- https://www.reco.on.ca/agents-and-brokerages/annual-financial-filing
- https://www.reco.on.ca/agents-and-brokerages/annual-financial-filing/submission-and-information-requirements
- https://www.reco.on.ca/news/reco-announces-new-financial-filing-requirements-to-strengthen-consumer-protection/

**Implementation**
- Store `fiscal_year_end`.
- `filing_due`: 2026-10-30 for the initial window, otherwise FYE + 90 days.
- Generate an export with every field above from the GL, trust ledger, bank-account register, unclaimed-funds module and closed-trade count.
- Attestation checklist backed by evidence: reconciliation sign-offs and shortfall incidents.
- Design the reconciliation data model so a monthly submission can be added in 2027.

## 7. FINTRAC: real estate brokers and sales representatives (PCMLTFA)

Source pages: FINTRAC real estate sector pages. Brokers and representatives are covered when acting as agent or mandatary in the purchase or sale of real estate.

**Compliance program** (Compliance program requirements, Guide 4). There are five elements:
1. Appoint a **compliance officer** with the necessary authority and access to senior management.
2. Keep **written, up-to-date policies and procedures**, approved by a senior officer if you are an entity.
3. Carry out a documented **risk assessment**.
4. Run a written, ongoing **compliance training program**, with a plan for delivering it.
5. Have an **effectiveness review at least every two years**, by an internal or external auditor, covering policies, risk assessment and training.

**Know your client: identity verification**
- Required for:
  - information records (each person or entity you act for and, **since 2025-10-01, unrepresented parties**);
  - receipt of funds;
  - large cash transactions;
  - large virtual currency transactions;
  - suspicious transactions (reasonable measures).
- **Timing** (FINTRAC real estate pages, PARTIAL):
  - **persons**: verify **at the time the transaction takes place**;
  - **corporations and other entities**: **within 30 days after the day the transaction is conducted**;
  - large cash and LVCTR: at the time of the transaction, subject to the 24-hour rule.
  - Exact timing for information records: PARTIAL. The guidance excerpt says "verify the identity of every person or entity for which an information record is kept" but the deadline was not visible: **UNVERIFIED**.
- Methods: government-issued photo ID, credit file, dual-process, affiliate or member reliance, agent or mandatary. These are the general FINTRAC methods; the real estate page confirms the regulation methods apply. Detail: UNVERIFIED.
- Funds received from a financial entity or public body are exempt from verification. Public bodies, and corporations or trusts with ≥ $75M net assets, are exempt from receipt-of-funds and information records.
- Where the other side has its own broker, the broker who holds the relationship with the client providing the funds does the identification.

**Unrepresented parties (in force 2025-10-01).** Keep an information record and verify the identity of any party who is **not represented** by a broker or sales representative. Make the associated third-party determination. Failure is listed as a minor violation. The exact required fields of the "reasonable measures" record are **UNVERIFIED**.

**Beneficial ownership.** For entities, obtain and take **reasonable measures to confirm** beneficial ownership information: directors, persons owning or controlling ≥25%, and ownership and control structure (the 25% threshold is general FINTRAC BOR guidance). Keep a record of the measures taken.

**Third-party determination.** Take reasonable measures, **at the time you create the information record**, to determine whether a third party is instructing. If one is, obtain their information. If you cannot determine it but suspect one, record why. Document the steps in your policies.

**PEP and HIO.** Brokers must take reasonable measures to make PEP and HIO determinations "for certain activities or transactions".
- **Real-estate-specific trigger and timing: UNVERIFIED.** The $100,000 / 30-day rule found is for life insurance, **not** real estate.
- Foreign PEP: always high risk, and remains a PEP for life.
- Domestic PEP or HIO: assess the risk. Enhanced measures apply only if high risk. Status ends 5 years after leaving office or the role.
- FINTRAC penalized HomeLife New World Realty (2025-11-20) for missing PEP/HIO determinations or records in 19 of 50 files.

**Business relationship and ongoing monitoring.** A business relationship is formed the first time you must verify a client's identity. You must then conduct ongoing monitoring and keep the relationship purpose record. FINTRAC best practice: make the determination within 30 calendar days.

**Records**
- **Receipt of funds record: required for funds received in ANY amount (real estate)**, not only at $3,000. The $3,000 threshold is for other sectors.
- Contents: date received; amount and how much was cash; method of receipt; currency type and amount; payer details (person or entity); and related account and other details per guidance (PARTIAL).

**Reports**

| Report | Threshold | Deadline |
|---|---|---|
| Large Cash Transaction Report (LCTR) | ≥ $10,000 cash, single or aggregated in 24 h | **within 15 calendar days** after the transaction |
| Large Virtual Currency Transaction Report (LVCTR) | ≥ $10,000 in virtual currency, single or aggregated in 24 h | **within 15 calendar days** |
| Suspicious Transaction Report (STR) | reasonable grounds to suspect, no threshold, including attempted transactions | **"as soon as practicable"** (priority over other tasks) |
| Listed/Terrorist Property Report | property owned or controlled by or for a terrorist, terrorist group or listed person | **immediately**, without any delay |

**Retention.** **At least 5 years**, including copies of reports from the day submitted. Records must be producible to FINTRAC **within 30 days** of a request.

**Ministerial directives.** These apply to all reporting-entity sectors. Check FINTRAC's ministerial directives page for the current list: **UNVERIFIED** (no list retrieved).

**URLs**
- Sector page: https://fintrac-canafe.canada.ca/re-ed/real-eng
- When to verify identity: https://fintrac-canafe.canada.ca/guidance-directives/client-clientele/client/real-eng
- Record keeping: https://fintrac-canafe.canada.ca/guidance-directives/recordkeeping-document/record/real-eng
- Compliance program: https://fintrac-canafe.canada.ca/guidance-directives/compliance-conformite/guide4/4-eng
- Beneficial ownership: https://fintrac-canafe.canada.ca/guidance-directives/client-clientele/bor-eng
- Third-party determination: https://fintrac-canafe.canada.ca/guidance-directives/client-clientele/tpdr-eng
- Business relationship: https://fintrac-canafe.canada.ca/guidance-directives/client-clientele/brr-eng
- PEP/HIO: https://fintrac-canafe.canada.ca/guidance-directives/client-clientele/pep/pep-eng
- Suspicious transaction reports: https://fintrac-canafe.canada.ca/guidance-directives/transaction-operation/str-dod/str-dod-eng.php
- Listed person or entity property: https://fintrac-canafe.canada.ca/guidance-directives/transaction-operation/guide5/5-eng
- Modernization and upcoming changes: https://fintrac-canafe.canada.ca/businesses-entreprises/changes-changements-eng

**Implementation**
- KYC record per party, **including unrepresented parties**: method, document type, number, jurisdiction, expiry, verified_at, verifier.
- Entity records: existence confirmation (due date = transaction + 30 days) and beneficial owners with the measures taken.
- Third-party determination, captured at information-record creation.
- PEP/HIO determination, risk rating and business-relationship purpose.
- Receipt-of-funds record on **every** receipt.
- 24-hour aggregation of cash and virtual currency, generating LCTR or LVCTR tasks due +15 calendar days.
- STR workflow with timestamps; terrorist-property reports flagged immediate.
- `retain_until` = +5 years.
- Compliance-program module: officer, policy versions and approvals, risk assessment, training log, two-year review due date.

## 8. GST/HST rates (2026) and place of supply

| Jurisdiction | Rate | Notes |
|---|---|---|
| Ontario | HST 13% | |
| Nova Scotia | **HST 14%** (5% + 9%) | **Effective 2025-04-01**, down from 15% (CRA Notice 342) |
| New Brunswick, Newfoundland and Labrador, Prince Edward Island | HST 15% | |
| Alberta, BC, Manitoba, Saskatchewan, Quebec, YT, NT, NU | GST 5% | PST or QST is separate and does not apply to this analysis |

The CRA rates page shows no 2026 rate change. Effective dates for the unchanged rates were not retrieved (Ontario 13% since 2010-07-01: UNVERIFIED in this pass).

**Place of supply.** A service *in relation to real property* is supplied in the participating province where the real property is situated. If the property is mostly in participating provinces, the province with the greatest proportion by **physical size** applies. If the property is not primarily in participating provinces, GST only applies.
- Citation: New Harmonized Value-added Tax System Regulations, No. 2, s.14; CRA **GST/HST Memorandum 3-3-6-1** (April 2026).
- CRA: services of a registered real estate agent related to selling or renting real property are generally taxable, even when the property sale itself is exempt.
- The memorandum's Example 30 (Nova Scotia broker selling a Nova Scotia home) confirms the analysis, but its conclusion text was not retrieved. "Commission is taxed at the province-of-property rate" is the stated rule applied to agents: **verify Example 30**.

**URLs**
- https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html
- https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/notice342/nova-scotia-hst-rate-decrease-questions-answers-general-transitional-rules-personal-property-services.html
- https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/3-3-6-1/plc-spply-prvnc-prsnl-srvcs-srvcs-rltn-prprty-nd-tlcmmnctn-srvcs.html
- https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-special-cases.html

**Implementation**
- Use a tax-rate table keyed by province with `effective_from` and `effective_to`.
- The commission invoice rate is determined by the **property's province** and the **invoice or supply date**, not the brokerage's location.

## 9. PIPEDA breach of security safeguards

| Duty | Citation |
|---|---|
| Report to the OPC any breach involving personal information under the organization's control if it is reasonable to believe it creates a **real risk of significant harm (RROSH)**. Report as soon as feasible after determining the breach occurred. | PIPEDA **s.10.1(1)–(2)** |
| **Notify affected individuals** if RROSH (unless prohibited by law), as soon as feasible | s.10.1(3), (6) |
| "Significant harm" includes bodily harm, humiliation, damage to reputation or relationships, loss of employment, business or professional opportunities, financial loss, identity theft, negative effects on credit record, and damage to or loss of property | s.10.1(7) |
| RROSH factors: **sensitivity** of the information, and **probability** of misuse | s.10.1(8) |
| Notify other organizations or government institutions that may reduce the harm | s.10.2 (numbering not re-verified) |
| **Keep a record of every breach**, whether reportable or not. Provide it to the OPC on request. | s.10.3 (text not retrieved; the OPC describes it) |
| Keep the breach record for **24 months after the day the organization determines the breach occurred** | **Breach of Security Safeguards Regulations, SOR/2018-64, s.6(1)** (in force 2018-11-01) |

The contents of the report and of the individual notice are in the Regulations, ss.2–3. The OPC breach report form lists them. Detailed field list: UNVERIFIED in this pass.

**URLs**
- https://www.priv.gc.ca/en/privacy-topics/privacy-for-businesses/privacy-breaches-at-your-business/gd_pb_201810/
- https://laws-lois.justice.gc.ca/eng/acts/p-8.6/page-3.html
- https://www.priv.gc.ca/media/4844/pipeda_pb_form_e.pdf

**Implementation**
- Breach register with:
  - `determined_at`;
  - description, data types and number of individuals;
  - RROSH assessment (sensitivity, probability, reasoning, including *why not* reported);
  - `opc_reported_at`, `individuals_notified_at`, other organizations notified.
- `retain_until` ≥ determined_at + 24 months. Longer if other laws apply; FINTRAC is 5 years and TRESA 6 years.

## 10. Ontario holidays for business-day calculations (Legislation Act, 2006, S.O. 2006, c. 21, Sch. F, ss.87–88)

**List.** "Holiday" in s.87, as reproduced in secondary commentary. The e-Laws text was **not** retrieved.

1. Sunday
2. New Year's Day
2.1 Family Day
3. Good Friday
4. **Easter Monday**: included
5. Victoria Day
6. Canada Day
7. **Civic Holiday: UNVERIFIED** (see note)
8. Labour Day
9. Thanksgiving Day
10. Remembrance Day
11. Christmas Day
12. Boxing Day
13. Any day fixed by proclamation of the Governor General or Lieutenant Governor as a public holiday, or for general prayer, mourning or thanksgiving

**Civic Holiday note.** Search summaries of the statute did not list the Civic Holiday. However, the same commentary numbers Remembrance Day as para. 10 and Boxing Day as para. 12. That numbering only works if a seventh item, such as the Civic Holiday, sits between Canada Day and Labour Day. Inclusion is therefore **UNVERIFIED**.

**Safe default:** do **not** exclude the Civic Holiday when computing the 5-business-day deposit deadline. Counting it as a business day gives an earlier, and therefore conservative, deadline. Make the holiday table configurable. The Civic Holiday is **not** an ESA public holiday, and Easter Monday is not an ESA holiday either; that is irrelevant here.

**Weekend rules, s.88** (s.88(1): the section applies to the s.87 definition). Subsection numbers are from secondary sources:
- New Year's Day on a **Sunday**: the following **Monday** is also a holiday (s.88(3)).
- Canada Day: if July 1 is a **Sunday**, Canada Day is **July 2** (s.88(4)).
- Christmas Day on a **Saturday**: the following **Monday** is also a holiday. Christmas on a **Sunday**: the following **Tuesday** is also a holiday, in addition to Boxing Day on Monday (s.88(5)).
- No substitution rule was found for other holidays falling on a weekend, for example Remembrance Day on a Saturday: **UNVERIFIED**.
- **Saturday** is not a "holiday", but O. Reg. 567/05 s.17(2) separately excludes Saturdays from "business day".

**URLs**
- https://www.ontario.ca/laws/statute/06l21 (not retrieved)
- https://www.canlii.org/en/on/laws/stat/so-2006-c-21-sch-f/latest/so-2006-c-21-sch-f.html
- Secondary: https://www.ottawaemploymentlaw.com/2018/07/holidays-on-sunday.html

**Implementation**
- Business-day function = not Saturday, not Sunday, not in `holidays[year]`.
- Generate the table each year from the rules above:
  - Easter-based dates: Good Friday and Easter Monday;
  - Family Day: 3rd Monday in February;
  - Victoria Day: the Monday before May 25;
  - Civic Holiday: 1st Monday in August (behind a flag, default off for deadline calculations);
  - Labour Day: 1st Monday in September;
  - Thanksgiving: 2nd Monday in October;
  - the fixed-date holidays, plus the Sunday and Saturday substitutions above;
  - an admin-editable list of proclaimed days.

---

## Open items to verify on e-Laws before production

1. The O. Reg. 579/05 s.17(1) item list after item 9, and s.13(2) and (3) wording, including whether the 30-day sign-off is in the regulation.
2. Whether the Legislation Act s.87 list includes the Civic Holiday.
3. The regulation basis for commission trust accounts.
4. The real-estate-specific FINTRAC PEP/HIO trigger and timing, and the timing for verifying identity for information records.
5. Exact O. Reg. 567/05 subsection numbers for s.13, s.22.0.1–22.0.3, s.22.7 and s.22.8.
6. The last-amended dates of all instruments.
