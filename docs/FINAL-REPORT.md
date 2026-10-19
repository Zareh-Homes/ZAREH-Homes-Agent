# Zareh Homes back office: final report

As of 2026-10-19. Branch: `claude/realestate-brokerage-schema-sfn0i9`.

**Bottom line:** the back end and the staff application are built and tested for what can be done without outside input. Staff can now do the daily work in a browser, on desktop and phone. It is **ready for technical staging**. It is **not yet** ready for a controlled pilot: what's left is hosting, professional decisions, a pen test and real-data checks, not screens. It is **not** ready to replace Lone Wolf.

> **RECO's first annual financial filing is due 2026-10-30, 11 days from now.** Prepare it from your current books (accountant + broker of record, filed in MyWeb). Don't wait for this system.

---

## Local demo and improvement backlog (2026-10-19)

- `ops/local-trial.sh demo` builds the app on your own computer, fills a fictional brokerage through the real screens
  (two agents, five deals including a lease, documents, deposits, a CDA, plans, a paid payout, a signed reconciliation)
  and prints a one-time sign-in link per demo person. Walkthrough: `demo-walkthrough.md`. CI runs it on every push.
- **Fixed (found by the demo):** a half-finished sign-in in the browser (someone else's, or one abandoned before
  two-factor) blocked signing in again and using invitation or reset links ("Set up two-factor sign-in to continue").
  Regression test in `auth.int.test.ts`. Trade record items no longer show stored codes (`COOP_BROKERAGE`) or double
  numbers.
- **Backlog (not built, in this order):**
  1. Breached-password screening at invite, reset and password change: **required before production**.
  2. Sign-in rate limits shared across app instances (today in memory, correct only with one instance): **required
     before running more than one instance**. The staging plan runs one.
  3. Inline document preview in the review queue (documents download today).
- **Unchanged:** an independent penetration test of staging is required before any real data. No claim is made that
  this authentication is stronger than an established library without that assessment.

## Review follow-ups (2026-10-19)

1. **Five business days runs to the bank, not to data entry.** Before this fix, the late check compared the date received with the "date deposited" someone typed in. Now:
   - Once a bank line is matched, the bank's posting date is what's measured.
   - A deposit with no bank record 5 business days after receipt is flagged red ("Not at the bank after 5 business days").
   - The monthly reconciliation lists deposits the bank posted late that month, and counts "not at the bank yet" from receipt.
   - Bank posting dates can trail a branch deposit by a day. The broker of record reviews each flag with the deposit slip.
   - Tests: `pipeline-deposit.test.ts`, `bank.test.ts`.
2. **Shortfalls and signing.** The code already allowed a timely sign-off with the discrepancy shown. My earlier summary ("blocks signing") was wrong and is corrected above. A new test proves the sequence: `trust-completeness.int.test.ts` "an unresolved shortfall doesn't hold up the monthly sign-off…".
3. **Large cash is preparation only.** When cash or virtual currency from the same payer reaches $10,000 across the receipt day and the day before, the system opens an internal report task due 15 calendar days after receipt.
   - This is a conservative stand-in for the 24-hour rule, because receipts are recorded by date, not time. It can over-flag, never under-flag.
   - Nothing is sent to FINTRAC. The system has no code that contacts FINTRAC.
   - The report stays OPEN until compliance staff record that they filed it in FINTRAC's own system, with FINTRAC's reference number. The database refuses "filed" without one.
   - Tests: `obligations.int.test.ts`.

## Staff application (2026-10-19)

The web app (`frontend/`) now covers the daily work, on the existing API. It shows the server's figures and never computes money itself; the server checks every permission on every request.

| Area | Screens |
|---|---|
| Access | Sign in; two-factor setup (QR code, recovery codes) and verify; recovery-code sign-in; invitation and admin-issued password reset links; account page (change password, sessions, sign out elsewhere) |
| Deals | List with search and filters; new deal (sale or lease, agents, people, commission); deal workspace with tabs: overview (conditions, amendments, firm/close/terminate), documents (upload, FINTRAC records, review), TRESA & FINTRAC, offers, trust, closing & CDA, trade record |
| Compliance | Review queue (approve / send back with a comment), FINTRAC reports (records the acknowledgement of a report filed in FINTRAC's own system), FINTRAC compliance program |
| Trust | Per-deal ledger with running balance, deposits, payments out, reversals, holds, receipt-of-funds records; brokerage-wide account status, shortfall/discrepancy incidents, unclaimed money |
| Bank | CSV import, independent verification, matching, live three-way reconciliation, prepare and sign, correction of a signed month |
| Closing | Commission statement, CDA (lawyer and internal copies, printable), finalize, void, bonuses/deductions, commission received, payout approve / record paid / returned / cancel |
| Oversight | Dashboards, pipeline, broker/accounting/agent oversight, approvals queue |
| Admin | People and invitations, roles, suspend/reactivate, two-factor reset; broker of record; financial policies; trust and operating accounts; commission plans; business calendar |
| Records | Printable Trade Record Sheet with every correction and initials |

**Browser tests:** 31 Playwright tests (`e2e/`), Chromium, against the real API running as the **restricted database login** and a freshly migrated database, in CI on every push (`e2e` job). They cover: invitation → password → two-factor; wrong password, wrong code and reused recovery code refused; each role invited; sign-out ends the server session; deal entry with field errors; upload → send back → approve; trade record prepare, print, and a readable refusal to sign an incomplete sheet; permissions on screen and at the API (403, CSRF, ignored client identity); broker of record; deposit; bank import with segregation of duties; reconciliation signed by the broker of record; **CDA preview, finalize with a double-click (one CDA), lawyer copy, void and reissue (-R1)**; operating account and an attested obligations figure; **commission received in two parts (duplicate and over-receipt refused, payouts wait for the rest)**; bank verification; **payout approval (not by the admin), cancellation, re-approval, payment recorded once despite a double-click, returned payment and its replacement**; the lease gate; error screens; phone layout.

**Staging rehearsal (CI job `staging`, `ops/staging-rehearsal.sh`):** the production images with a TLS-only database and the restricted login, HTTPS in front (HTTP redirected), the first admin created with the script inside the image, the whole browser suite over HTTPS, then: Secure / HttpOnly / SameSite=Strict session cookie and HSTS; the app login can't alter the ledger or audit log; no password, authenticator secret, recovery code or ID number in the API log or stored in clear; sign-ins and failures audited; an encrypted backup restored into a scratch database and compared. Green on runs #22 and #23.

**Real bugs these checks found and fixed:**
- **Production-only:** under the restricted login, voiding a CDA (and trade record signing, payout events, incident and recovery steps) failed with "permission denied": database triggers lock rows the login couldn't update. Migration 020; a test now checks every lock a trigger takes.
- After voiding a CDA, "Finalize" replayed the voided CDA (same request key) instead of issuing the correction.
- A mistyped two-factor code or current password signed you out; the deposit button was hidden on our-brokerage deals; header overflow at 1366px; raw JSON in trade record messages and CDA warnings.
- The same commission cheque could be recorded twice for one closing (now refused, migration 019).

**Pilot guards (migration 019, `docs/pilot-scope.md`):**
- **Lease settlement is off** (`LEASE_SETTLEMENT`): a lease's CDA and payments out of trust are refused until counsel signs off on commission from first and last month's rent, the tenant's entitlement to that deposit (RTA s.106), and the signed commission agreement. Receiving and refunding the deposit stay allowed.
- **Partial payouts** aren't supported: with part of the commission in, payouts wait and approval is refused with that reason. Partial receipts are recorded.
- Deals needing an unsupported workflow (lease settlement, builder-held deposit, outside referral) say "Outside the pilot".
- New screen: Bank → Available funds (what the database checks before approving a payout; obligations entered under the accountant's procedure and attested by a second person). Without it no payout could be approved from the app.

**Before a controlled pilot (outside this code):**
1. Hosting: managed PostgreSQL 16 with PITR, container host, TLS, secret store, alerting.
2. Confirm the legal brokerage entity, broker of record, trust/operating bank accounts and RECO registration all match: same legal name and registration number on the CDA settings (`BROKERAGE_*`), the BoR designation recorded in Admin, and each account's bank and last four digits. I can't verify these; they need your RECO record and bank letters.
3. Professional decisions (§C).
4. Independent penetration test against staging.
5. Commission plans entered and approved by a second broker.
6. Staff run UAT on staging with real (copied) deals; Lone Wolf export dry run and tie-out.
7. RECO filing for 2026 by **2026-10-30**, from current books, in MyWeb (not this system).

---

## A. Completed

The full list, with code location, commit and test for each item, is in `docs/requirements-matrix.md`. In summary:

| Area | Commit | Main code | Tests |
|---|---|---|---|
| Authentication, MFA, sessions, CSRF, audit, encryption, privacy | `840ba94` | `backend/src/security/`, migrations 010–011 | `auth.int`, `access.int` |
| Trust: holidays, beneficiaries, altered records, shortfalls, amended reconciliations, commission trust ledger, unclaimed money | `5412ac4` | `backend/src/bank/`, `lib/ontario-calendar.ts`, 012 | `trust-completeness.int`, `trust-calendar`, `bank.int`, `trust-ledger.int` |
| Available funds, payment confirmation, accounting adapters (read-only), journal export | `a4de5cb` | `backend/src/accounting/`, 013 | `money-controls.int`, `accounting.test` |
| Commission plans, adjustments, recoveries, tax by province/date | `f8ff452` | `backend/src/commission/`, `closing/calculate.ts`, 014 | `closing.int`, `closing-calculate` |
| Lifecycle, offers, conditions, Trade Record Sheet | `a31f4a0` | `backend/src/deals/`, 015 | `deal-lifecycle.int` |
| TRESA and FINTRAC obligations | `4cb7411` | `backend/src/obligations/`, 016 | `obligations.int`, `obligations.test` |
| RECO filing prep, oversight dashboards, migration hardening | `cfb6c81` | `backend/src/reco/`, `dashboard/oversight.ts`, `frontend/src/oversight/`, `migration/`, 017 | `reco-oversight.int`, `oversight.test.tsx`, migration tests |
| Migration runner, deployment, CI, backup/restore, UAT | `c435d7d` | `brokerage-db/migrate.sh`, `ops/`, `.github/workflows/ci.yml` | `uat.int`, `test_interrupted.py`, restore test |

## B. Incomplete

| Item | Why | Risk if ignored | Next action |
|---|---|---|---|
| Professional decisions (§C) | Not mine to make | Gated features stay off; some rules use the strict reading | Send §C to each professional |
| Accounting connection (OAuth) and mapping UI | Provider not chosen; needs an app registration | Operating payouts need manual attestations | Pick QBO or Xero (§D) |
| Independent penetration test | External | Unknown vulnerabilities | Commission one against staging |
| Partial payouts | Each payout is all-or-nothing | Paying an agent in instalments isn't possible | Build if you need it |
| Alert wiring to a pager | Host not chosen | Silent failures | Wire the rules in `deployment.md` |
| Prisma 7 upgrade | Not needed for security now (§E); breaking change | Falling behind on the ORM | Separate change, plan in `deployment.md` |
| Real Lone Wolf migration and parallel month | Needs real exports and staff time | Can't prove tie-out | See §F |
| Interest on unclaimed money | Recorded, not computed | Manual calculation | Confirm the rule with counsel first |

## C. Professional decision sheet

Duplicate questions are merged. Each answer turns on a policy or changes a rule; until then the safe side applies.

**Brokerage counsel**

1. Commission trust account: is there a legal basis to use one? Under which rules? (No regulation section was found.) → `COMMISSION_TRUST_ACCOUNT`
2. Co-op and referral money that arrives with our commission: which account holds it, and when may it be paid? (Also for the accountant.) → `THIRD_PARTY_PAYABLES`
3. Is the Civic Holiday a "holiday" under Legislation Act s.87 for the 5-business-day deposit rule? → `CIVIC_HOLIDAY_IS_HOLIDAY` (until then, the earlier deadline applies)
4. Do NSF/overdraft charges count as "service fees" under RECO's shortfall exception? (Until then: reportable.)
5. O. Reg. 579/05 s.17: are there TRS items beyond the nine we found? Who must be shown as the deposit holder?
6. FINTRAC: what is the PEP/HIO trigger and timing for real estate? (Until then, a determination is required for every client.) Is the offer date "the time of the transaction"?
7. FINTRAC: the exact fields of the unrepresented-party record.
8. Unclaimed trust money: interest treatment, and RECO's current remittance process. → `UNCLAIMED_MONEY_REMITTANCE` (also BoR)
9. How many statutory trust accounts may the brokerage hold, and how must they be designated?
10. Privacy: confirm the retention schedule and breach-notification steps.

**Accountant**

1. Co-op/referral routing (same as counsel #2).
2. The written procedure for manual operating-account obligations. → `MANUAL_OBLIGATIONS_PROCEDURE`
3. Chart of accounts: a code for each account role in `ACCOUNTING_ACCOUNT_MAP`.
4. HST: the tax point (we use the close date), and the treatment of bonuses and deductions.
5. QuickBooks Online or Xero?
6. Fiscal year end, and the figures for the RECO filing (the 2026 one from current books now).

**Broker of record**

1. Record your BoR designation (a second person records it), plus an alternate.
2. After counsel and the accountant answer, turn the matching policies on (each with a reason).
3. Approve each agent's commission plan (a second broker approves).
4. Proclaimed holidays, when they happen.
5. Confirm RPO/RTO (`business-continuity.md`) and hold the offline backup key.
6. **File the 2026 RECO annual filing by 2026-10-30.**

**FINTRAC compliance officer**

1. Appoint them formally, and record it in the compliance program.
2. Written policies and procedures that match the rules engine.
3. Business risk assessment; cadence for training and the two-year effectiveness review.
4. Who may open and see suspicious-transaction reviews.

## D. Integrations

No secrets are needed in chat. Each item goes into the host's secret store.

| Integration | Status | Remaining steps |
|---|---|---|
| Bank | File upload only (by design) | Download monthly and interim statements as CSV from the bank portal and upload them. No bank API, no transfers. |
| QuickBooks Online / Xero | Adapter built, mocked, **not operational** | 1) Choose the provider. 2) Register an app in the provider's developer portal; set the redirect URI to the staging host. 3) Store the client id/secret in the secret store. 4) Build the OAuth connect screen and token storage (not built). 5) Accountant fills `ACCOUNTING_ACCOUNT_MAP`. 6) Accountant reviews a first read against the books. Posting stays off. |
| Email | **Not built** | Invitations and password resets are issued by an admin and delivered out of band; notifications are in-app only. Add an email provider (sending domain + API key in the secret store) if wanted. |
| Hosting | Not provisioned | Managed PostgreSQL 16 with PITR, container host, TLS certificate, secret store, log/uptime alerting |
| RECO MyWeb, FINTRAC, OPC | Manual by design | Filed by people in each portal. The system records the confirmation. |

## E. Test results (actual)

| Suite | Total | Passed | Failed | Skipped |
|---|---|---|---|---|
| Backend (real PostgreSQL 16, migrated by `migrate.sh`) | 185 | 185 | 0 | 0 |
| Browser end-to-end (Playwright, Chromium, real API as the restricted login) | 31 | 31 | 0 | 0 |
| Lone Wolf migration (with database) | 48 | 48 | 0 | 0 |
| Frontend (Node runner 10 + vitest 24) | 34 | 34 | 0 | 0 |
| Commission engine | 6 | 6 | 0 | 0 |
| Backup → restore → manifest comparison | 1 | 1 | 0 | — |

**Backend coverage:** 96.47% lines, 84.86% branches, 93.71% functions (Node test coverage, `src/**`).

**Security findings:**
- Dependency audits, dev tools included: backend 0, frontend 0, Python migration tool 0. CI fails on any high or critical advisory, with no allow-list.
- Container images: built, started and scanned (Trivy) on every push; see the CI section below.
- Typecheck is clean. Gitleaks passes on every push.

**Not tested:**
- No penetration test.
- No test on a real staging host (none exists yet); the CI rehearsal stands in for it.
- No test on real Lone Wolf data.
- UAT A–L are automated, not run by staff (`docs/uat.md`).

### CI on GitHub

**Why the backend job failed (runs #1 and #2):** one test, "restricted database role: the application works end to end as zareh_app", logged in as a test database user that had no password. The local test database trusts local connections, so it passed here. GitHub's PostgreSQL requires a password over the network (scram-sha-256), so it failed with `Authentication failed ... credentials for zareh_app_test are not valid`. That was 167 passed and 1 failed out of 168. No application code was wrong.

**Fix:** `5e53f4d`. The test sets a fresh random password for that user each run. Before fixing, I reproduced the failure against a local database configured like CI; afterwards the full suite passed there twice in a row.

**What the new image job then found and fixed:**
- `b74c2e6`: the API image crashed on its first database query (OpenSSL missing at build time). A real deployment bug.
- `4fe3f77`: 10 high advisories inside the npm bundled with the Node base image. npm was removed from the runtime image.

**Result:** run #8 on `4fe3f77` passed all six jobs (backend, frontend, migration, commission engine, images, secrets). The same commit was re-run to check for intermittent failures and passed again, and run #9 on `5e35c52` (docs only) passed too: three green runs in a row.

## F. Readiness

| Stage | Ready? | What's missing |
|---|---|---|
| **Technical staging** | **Yes**, once a host exists | Provision the host |
| **Controlled pilot** (real deals, Lone Wolf still the record) | **No** | Hosting; entity/BoR/bank/RECO match confirmed; §C decisions; commission plans entered; pen test; staff-run UAT |
| **Real financial production** (replace Lone Wolf) | **No** | Everything above, plus the real migration with tie-out, one parallel month reconciling to the cent, the first signed reconciliation, Prisma 7 or an accepted-risk decision, your written go-live approval |

## G. Financial safety

Confirmed for this whole effort:

- **No bank transfer** was made or initiated.
- **No accounting posting**: no tenant was connected.
- **No regulator filing**: RECO, FINTRAC and OPC.
- **No real trust money movement.**

All data was synthetic test data in a local, throwaway database. The system has no code path that moves money or files with a regulator.

## H. Operational walkthrough (each step has a screen; API routes shown for reference)

1. **Create the deal:** agent `POST /api/deals` (parties, agents, deposit holder). FINTRAC and document slots are created automatically.
2. **Upload documents:** `POST /api/documents/slots/:slotId/files`. The compliance reviewer uses `POST /api/documents/slots/:slotId/review` (Approved / Needs Revision with a comment).
3. **Deposit:** a managing broker records the receipt (`POST /api/trust/deposits`), then takes the money to the bank. O. Reg. 567/05 s.17 requires the deposit *into the trust account* within 5 business days after the money comes into the brokerage's hands. The system measures that from the date received to the bank's posting date once the bank file is matched, and flags it if there's no bank record 5 business days after receipt. Recording the receipt alone doesn't satisfy it. The money can't be paid out until it has cleared the bank.
4. **Bank file:** admin `POST /api/bank/statements`. A second person verifies it (`…/verify`). Lines auto-match; others are matched with `POST /api/bank/matches`.
5. **Reconcile:** `POST /api/trust/reconciliations` (prepare), then the broker of record signs (`…/:id/sign`). A shortfall doesn't hold up the monthly sign-off. At preparation it opens a trust incident and alerts the brokers, so the s.14 response starts immediately. The broker of record then signs on time with a written explanation of every exception. The record shows "signed with discrepancy", and the incident stays open until the registrar is notified and the money is replenished. A month with a shortfall can't be signed if no incident is recorded, and nothing can be signed without the explanation.
6. **Firm, then close:** `POST /api/deals/:dealId/firm` (all conditions resolved), then `…/close`. The TRS is signed by the agent, then the BoR.
7. **CDA:** a broker `POST /api/deals/:dealId/closing/finalize`. This posts trust distributions and freezes the CDA.
8. **Commission and payout:** `…/closing/commission-received` waits for bank verification. A different broker approves (`/api/payouts/:id/approve`). Admin records it paid after sending it in the bank portal (`…/paid`). The next verified bank file confirms it.

## I. Final gap audit: what actually stops replacing Lone Wolf

1. ~~No staff screens~~: built and browser-tested as of 2026-10-19.
2. **Professional decisions not made** (§C): co-op routing, commission trust account, accounting map, FINTRAC policies.
3. **No real migration or parallel month.** Until both systems reconcile to the same bank balance, nothing is proven.
4. **Security sign-off:** the independent pen test.
5. ~~Lease transactions~~: supported as of 2026-10-19 (migration 018).

Everything else is done, or is a configuration step.

## J. Documentation

| Topic | File |
|---|---|
| Architecture and data model | `docs/architecture.md` |
| Deployment, rollback, monitoring, incidents, flags, audit retention | `docs/deployment.md` |
| Business continuity (RPO/RTO, manual fallback, keys) | `docs/business-continuity.md` |
| Launch checklist (three gates) | `docs/launch-checklist.md` |
| Security review checklist | `docs/security-review-checklist.md` |
| UAT A–L | `docs/uat.md` |
| Requirements matrix | `docs/requirements-matrix.md` |
| Regulatory references | `docs/regulatory-references.md` |
| Module runbooks | `docs/monthly-trust-reconciliation.md`, `accounting-integration.md`, `commission-engine.md`, `deal-lifecycle.md`, `compliance-obligations.md`, `reco-annual-filing.md`, `migration/README.md` |
| Release notes | `CHANGELOG.md` |
