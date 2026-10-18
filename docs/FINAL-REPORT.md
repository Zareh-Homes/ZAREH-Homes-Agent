# Zareh Homes back office: final report

As of 2026-10-18. Branch: `claude/realestate-brokerage-schema-sfn0i9`.

**Bottom line:** the back end is complete and tested for what can be built without outside input. It is **ready for technical staging**. It is **not** ready for a pilot, and **not** ready to replace Lone Wolf. The reasons are below, and most of them are decisions or people, not code.

> **RECO's first annual financial filing is due 2026-10-30, 12 days from now.** Prepare it from your current books (accountant + broker of record, filed in MyWeb). Don't wait for this system.

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
| **Staff screens** for deal entry, uploads/review, trust receipts, bank import/match, reconciliation, CDA, payouts, sign-in/MFA | Back-end-first; only the dashboard, pipeline and oversight have screens | Staff can't use it day to day; this blocks a pilot | Build these screens on the existing API; add Playwright end-to-end tests |
| Professional decisions (§C) | Not mine to make | Gated features stay off; some rules use the strict reading | Send §C to each professional |
| Accounting connection (OAuth) and mapping UI | Provider not chosen; needs an app registration | Operating payouts need manual attestations | Pick QBO or Xero (§D) |
| 4 high npm audit findings (Prisma tooling) | The fix is the Prisma 7 major upgrade | Low exposure (not in a request path); still a finding | Upgrade to Prisma 7 and re-run every suite |
| Independent penetration test | External | Unknown vulnerabilities | Commission one against staging |
| Lease transactions | Different remuneration rules | Leases must be handled outside the system | Define lease commission rules, then build |
| Partial payouts | Each payout is all-or-nothing | Paying an agent in instalments isn't possible | Build if you need it |
| TRS print/PDF | JSON view only | BoR reviews on screen/export | Add a print template |
| Alert wiring to a pager | Host not chosen | Silent failures | Wire the rules in `deployment.md` |
| Docker images built and scanned | No Docker daemon here | Image issues found late | Build in CI on the first run |
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
| Backend (real PostgreSQL 16, migrated by `migrate.sh`) | 169 | 169 | 0 | 0 |
| Lone Wolf migration (with database) | 48 | 48 | 0 | 0 |
| Frontend | 24 | 24 | 0 | 0 |
| Commission engine | 6 | 6 | 0 | 0 |
| Backup → restore → manifest comparison | 1 | 1 | 0 | — |

**Backend coverage:** 96.47% lines, 84.86% branches, 93.71% functions (Node test coverage, `src/**`).

**Security findings:**
- `npm audit`, backend production dependencies: **4 high, open** (Prisma tooling: `effect`, `deepmerge-ts`). The fix is Prisma 7.
- Frontend: dev-server findings only; they don't ship.
- Typecheck is clean.
- Gitleaks runs in CI; it has not run here.

**Not tested:**
- No penetration test.
- No browser end-to-end tests.
- No image scan.
- No test on real Lone Wolf data.
- UAT A–L are automated, not run by staff (`docs/uat.md`).

## F. Readiness

| Stage | Ready? | What's missing |
|---|---|---|
| **Technical staging** | **Yes**, once a host exists | Provision the host; first green CI run; build images |
| **Controlled pilot** (real deals, Lone Wolf still the record) | **No** | Staff screens; §C decisions; commission plans entered; pen test; staff-run UAT |
| **Real financial production** (replace Lone Wolf) | **No** | Everything above, plus the real migration with tie-out, one parallel month reconciling to the cent, the first signed reconciliation, Prisma 7 or an accepted-risk decision, your written go-live approval |

## G. Financial safety

Confirmed for this whole effort:

- **No bank transfer** was made or initiated.
- **No accounting posting**: no tenant was connected.
- **No regulator filing**: RECO, FINTRAC and OPC.
- **No real trust money movement.**

All data was synthetic test data in a local, throwaway database. The system has no code path that moves money or files with a regulator.

## H. Operational walkthrough (API, until the screens exist)

1. **Create the deal:** agent `POST /api/deals` (parties, agents, deposit holder). FINTRAC and document slots are created automatically.
2. **Upload documents:** `POST /api/documents/slots/:slotId/files`. The compliance reviewer uses `POST /api/documents/slots/:slotId/review` (Approved / Needs Revision with a comment).
3. **Deposit:** a managing broker receipts it, `POST /api/trust/deposits`, within 5 business days. It can't be paid out until it has cleared the bank.
4. **Bank file:** admin `POST /api/bank/statements`. A second person verifies it (`…/verify`). Lines auto-match; others are matched with `POST /api/bank/matches`.
5. **Reconcile:** `POST /api/trust/reconciliations` (prepare), then the broker of record signs (`…/:id/sign`). Shortfalls block signing until a cause is recorded.
6. **Firm, then close:** `POST /api/deals/:dealId/firm` (all conditions resolved), then `…/close`. The TRS is signed by the agent, then the BoR.
7. **CDA:** a broker `POST /api/deals/:dealId/closing/finalize`. This posts trust distributions and freezes the CDA.
8. **Commission and payout:** `…/closing/commission-received` waits for bank verification. A different broker approves (`/api/payouts/:id/approve`). Admin records it paid after sending it in the bank portal (`…/paid`). The next verified bank file confirms it.

## I. Final gap audit: what actually stops replacing Lone Wolf

1. **No staff screens for daily work.** This is the biggest one, and it's code.
2. **Professional decisions not made** (§C): co-op routing, commission trust account, accounting map, FINTRAC policies.
3. **No real migration or parallel month.** Until both systems reconcile to the same bank balance, nothing is proven.
4. **Security sign-off:** the pen test, plus Prisma 7 or an accepted-risk decision.
5. **Lease transactions** aren't supported. Keep them on the current process if you do leases.

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
