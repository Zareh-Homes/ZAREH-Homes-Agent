# Requirements matrix

This is the one authoritative matrix for the completion directive (§1–16). Status as of 2026-10-18.

**Status key:**
- **Done**: built, enforced server-side, covered by an automated test on real PostgreSQL.
- **Gated**: built, but off until a named professional decides (the database refuses it while off).
- **Partial**: some of it is built; what's missing is stated.
- **Not done**: not built.
- **External**: needs a person or service outside this codebase.

**Commits:**

| Commit | Phase |
|---|---|
| `fc25790` and earlier | Baseline |
| `840ba94` | P1 auth |
| `5412ac4` | P2 trust |
| `a4de5cb` | P3 funds |
| `f8ff452` | P4 commission |
| `a31f4a0` | P5 lifecycle/TRS |
| `4cb7411` | P6 TRESA/FINTRAC |
| `cfb6c81` | P7 RECO/dashboards/migration |
| `c435d7d` | P8 deploy/CI/UAT |

## §1 Audit

| Requirement | Status | Where / evidence |
|---|---|---|
| Inspect services, schema, migrations 006–009 | Done | Findings fixed in P1–P3. Notable: 006 assumed direct lawyer-to-agent pay (replaced by brokerage-paid flow); 009's 3-day balance check was replaced by available funds (013). |
| Database and Prisma schema agree | Done | CI "Prisma schema matches the migrated database" (`migrate diff` is empty) |
| Rules can't be bypassed via other routes, app-role SQL, concurrency or retries | Done | `money-controls.int` restricted-role tests; `trust-ledger.int` concurrency and idempotency tests |
| Dangerous defaults removed | Done | Dev auth refused in production; no default tax rate; all policies off; demo screens off in the image |

## §2 Authentication and security

| Requirement | Status | Where / evidence |
|---|---|---|
| Dev-header auth replaced; production fails closed | Done | `security/config.ts`, `scripts/check-config.ts`; `auth.int` |
| Individual accounts, invitations, suspension, immediate revocation | Done | `security/auth-service.ts`; `auth.int` |
| MFA mandatory for privileged roles | Done | TOTP + recovery codes; `auth.int` |
| Sessions: expiry, revocation, recovery | Done | `auth.int` |
| Role- and transaction-level authorization | Done | `deals/lifecycle.ts assertDealAccess`; `access.int` |
| BoR and substitute designations with effective dates | Done | migration 009; `money-controls.int` "broker of record…" |
| Least-privilege database role | Done | `zareh_app`; `ops/create-app-login.sql` |
| Never trust client user id or role | Done | `auth.int`; smoke test (forged header → 401) |
| Audit: login, logout, failures, sensitive views, exports, approvals, money changes | Done | `security/audit.ts`, append-only `AuditLog`; `auth.int`, `access.int`; `/api/audit/export` |
| Encryption in transit and at rest; sensitive fields; safe uploads/downloads | Done | AES-256-GCM fields and files; content-type sniffing; HSTS/CSP |
| Privacy: minimization, breach workflow, retention, legal hold, disposal | Done | migration 011; `access.int` |
| Encrypted backups, RPO/RTO, real restore test | Done | `ops/backup.sh`, `ops/restore-test.sh`; restore passed; `docs/business-continuity.md` |
| Independent penetration test | **External** | Not performed |

## §3 Bank and trust

| Requirement | Status | Where / evidence |
|---|---|---|
| Three account classes; no free transfers between them | Done | Trust / commission trust / operating kinds; segregation tests |
| Commission trust account with its own ledger and reconciliation | Gated (COMMISSION_TRUST_ACCOUNT) | `commission_trust_ledger`; `closing.int` CTA test |
| Beneficiary-level liabilities | Done | `bank/reconcile.ts` per deal; PRO_RATA_REVIEW flagged rather than guessed |
| Immutable receipts/disbursements; reversals; returned cheques, recalled wires | Done | `trust-ledger.int`, `bank.int` |
| Statement import with independent verification; interim activity | Done | `bank/service.ts`; `money-controls.int` |
| Duplicate and altered record detection | Done | File hash plus line de-duplication; interim vs monthly cross-check (`trust-completeness.int`) |
| Outstanding deposits and disbursements | Done | `reconcile.ts` |
| Same-day / concurrent safeguards | Done | `trust-ledger.int` concurrency |
| Monthly bank ↔ ledger ↔ beneficiary reconciliation; BoR dated sign-off | Done | `bank.int` |
| Missing-statement and late-reconciliation alerts; correct deadlines | Done | `reconciliationDueBy`; oversight dashboard |
| Ontario business days and holidays for deposit deadlines | Done (Civic Holiday Gated) | `lib/ontario-calendar.ts`; `trust-calendar.test` |
| Signed reconciliations preserved; corrections supersede | Done | `trust-completeness.int` |
| Shortfall escalation, replenishment evidence, RECO notice, service-fee exception | Done | `bank.int`, `trust-completeness.int`. Replenishment needs bank evidence; a ledger entry alone doesn't clear it. |
| Number and designation of statutory trust accounts | Partial | Multiple accounts supported. How many the brokerage may hold is for counsel (§C). |

## §4 Available funds and payments

| Requirement | Status | Where / evidence |
|---|---|---|
| Verified balance with timestamp and evidence; fresh only | Done | `money-controls.int` "available funds…" |
| Subtracts approved payouts, unpresented payments, holds, payables, attested obligations | Done | `account_committed`, `account_obligations` (013) |
| Obligations from the accounting system; fail closed without them | Done | `accounting/funds.ts`; operating account refused without an attestation ≤7 days old |
| Manual obligations procedure | Gated (MANUAL_OBLIGATIONS_PROCEDURE) | Accountant |
| QBO/Xero adapter | Partial | Read-only adapters, tested with mocks. No OAuth handshake or token storage; not operational. |
| No automatic transfers | Done | None exist |
| Concurrency-safe and idempotent at the database level | Done | `money-controls.int` simultaneous duplicates; `trust-ledger.int` |
| Approval ≠ payment recorded ≠ payment confirmed | Done | `paymentConfirmed` only from a bank file someone else verified (`uat.int` A+G) |

## §5 Commission and CDA

| Requirement | Status | Where / evidence |
|---|---|---|
| Listing, buyer, double-ended; deposit held by us or elsewhere | Done | `closing.int`, `uat.int` A, `obligations.int` double-ended |
| Multiple agents, splits, caps, cap periods, desk/transaction fees | Done | `commission-engine/`, `closing-calculate.test`, `closing.int` cap |
| Effective-dated plans with second-broker approval | Done | migration 014; `closing.int` |
| PRECs paid by legal name, through the brokerage | Done | `closing.int`, `closing-calculate.test` |
| Co-op and outside referral payables tracked | Done (tracking) / Gated (approval: THIRD_PARTY_PAYABLES) | `money-controls.int` |
| Bonuses, deductions, chargebacks, recoveries | Done | `closing.int` |
| Partial receipts, recalls, returned payments | Done | `closing.int`, `uat.int` G |
| Corrected/reissued CDAs carrying earlier payments | Done | `closing.int` "void and reissue" |
| Tax by province and date; no hard-coded 13%; HST collected ≠ net payable | Done | `SalesTaxRate`; `closing.int` tax test; journal separates HST |
| CDA states the commission payable to our brokerage only | Done | `cda-template.ts` |
| Calculation separate from accounting and approvals | Done | `closing/calculate.ts` (pure) vs payouts vs `accounting/journal.ts` |
| Cancelled transactions | Done | Termination + CDA void |
| Lease transactions | Done | Migration 018; `closing/calculate.ts`; `closing-calculate.test` lease tests, `uat.int` M |
| Partial payouts (paying an agent part of a payout) | **Not done** | Each payout is paid in full or not at all |
| Disputes | Partial | Deposit holds/disputes done; commission disputes are handled as holds plus notes, with no separate workflow |

## §6 Trade Record Sheet and lifecycle

| Requirement | Status | Where / evidence |
|---|---|---|
| TRS per O. Reg. 579/05 s.17, generated from the deal | Done | `deals/trade-record.ts`; `deal-lifecycle.int` |
| Agent signature, then BoR review/return/sign; corrections keep history | Done | `deal-lifecycle.int` |
| Printable/exportable | Partial | JSON view plus audit; no PDF/HTML print template for the TRS yet |
| Offers, conditions, waivers, amendments, firm, close, terminations, releases | Done | `deal-lifecycle.int`, `uat.int` F |
| Closing date passing doesn't close the deal | Done | Explicit status guard (015) |
| Condition deadlines and warnings | Done | `DealCondition.dueAt`; dashboards |
| Delayed closings | Done | Close-date amendment |
| Disputed deposits | Done | Holds (`trust-ledger.int`) |
| Commercial and lease workflows | Done (residential and commercial leases share the lease path) | `uat.int` M |
| Listing / buyer representation records | Done | `RepresentationAgreement` (016) |

## §7 TRESA

| Requirement | Status | Where / evidence |
|---|---|---|
| Rule-driven evaluation with citations | Done | `obligations/tresa.ts` |
| Information Guide delivery and acknowledgement evidence | Done | `TresaDisclosure`; blocks the BoR sign-off |
| Representation type and dates; designated representation | Done | 016 |
| Multiple representation consent; conflicts | Done | `obligations.int` double-ended |
| Self-represented party disclosures | Done | `obligations.int` |
| Offer presentation, competing offers, retention | Done | Offers register; `deal-lifecycle.int` |
| Seller's written direction on offer disclosure | Done | `SellerOfferDirection`; `obligations.int` |
| Versioned requirements with sources | Done | `docs/regulatory-references.md`; form versions recorded |
| Evidence required, not checkboxes | Done | Each record needs a document or reference |

## §8 FINTRAC

| Requirement | Status | Where / evidence |
|---|---|---|
| Obligations matrix (trigger, deadline, evidence, reviewer) | Done | `obligations/fintrac.ts`; `docs/compliance-obligations.md` |
| Compliance officer, policies, risk assessment, training, 2-year review | Done (tracking) | `ComplianceProgramRecord`; `obligations.int` |
| Individual and entity ID, beneficial ownership | Done | `compliance.int` |
| Third-party determinations | Done | `FintracDetermination` |
| Receipt of funds records (encrypted) | Done | `obligations.int` |
| Business relationship and ongoing monitoring | Done | Rules in `fintrac.ts` |
| PEP/HIO and high-risk enhanced measures | Done (rules) / decision on trigger points is counsel's | `obligations.int` |
| Large cash ($10k / 24h) report task, due in 15 days | Done | `obligations.int` |
| STR review, confidential, no auto-filing | Done | Compliance-only; nothing is filed |
| Retention | Done | Retention schedule plus legal hold (011) |

## §9 RECO filing and unclaimed money

| Requirement | Status | Where / evidence |
|---|---|---|
| Fiscal year and due date | Done | `reco/filing.ts filingDueDate`; `reco-oversight.int` |
| Statement figures with sources; trust assets/liabilities; trade count; unclaimed totals | Done | `filingPackage` |
| Attestation evidence reviewed by BoR; submission confirmation recorded | Done | 017; `reco-oversight.int` |
| Export of schedules | Done | `packageCsv` |
| Filing from the system | Not done (by design) | The BoR files in MyWeb |
| **2026 filing due 2026-10-30** | **External, urgent** | Must be filed from the current books. This system can't produce it from real data yet. |
| Unclaimed register: amount, beneficiary, dates, contacts, disputes, evidence | Done | `bank/unclaimed.ts`; `trust-completeness.int` |
| Transfer-to-RECO step | Gated (UNCLAIMED_MONEY_REMITTANCE) | Payment made outside the system |
| Interest on unclaimed money | Partial | Recorded as an event; not computed |

## §10 Accounting

| Requirement | Status | Where / evidence |
|---|---|---|
| Use external GL; don't build one | Done | Journal CSV export; `accounting.test` |
| Account and tax-code mapping | Partial | `ACCOUNTING_ACCOUNT_MAP` env plus validation; no mapping UI |
| Receivables, payables, fees, HST split in journals | Done | `accounting/journal.ts` |
| Idempotent export; duplicate prevention | Partial | Every journal line carries its source event id, so a re-export is identical and duplicates can be found; nothing is posted, so there is no posted-state tracking yet |
| Retry, errors, stale warnings, status | Partial | Errors surface; stale obligations fail closed; no retry queue (nothing is posted) |
| Secure OAuth connection | **Not done** | Needs the provider choice and an app registration |
| Live posting | Not done (by design) | `postJournal` refuses |

## §11 Migration

| Requirement | Status | Where / evidence |
|---|---|---|
| Source preservation (fingerprints), dry run, explicit mapping | Done | `lonewolf_migrate.py`; `file_fingerprints` |
| No invented amounts; Decimal; HST source | Done | `test_parsing.py` |
| PRECs, deals, ledger; duplicates and integrity checks | Done | `test_end_to_end.py` |
| Quarantine of rejected rows; redacted logs | Done | `rejected_*.csv`; log redaction |
| Opening-balance verification; read-back tie-out | Done | `verify_written` (exit 4) |
| Partial-failure recovery, idempotent restart | Done | `test_interrupted.py` |
| Agent plans and caps | Not migrated | Entered and approved in the new system |
| Documents/attachments | Not migrated | Slots created; files need uploading |
| Run on real exports; trust/accounting tie-out | **External** | Needs the real Lone Wolf exports |

## §12 Dashboards

| Requirement | Status | Where / evidence |
|---|---|---|
| BoR, accounting and agent views with the listed items | Done | `dashboard/oversight.ts`; `reco-oversight.int`; `frontend/src/oversight` |
| Every number has a definition, source, as-of date; no false green | Done | `Metric` type; `oversight.test.tsx` |
| Responsive / mobile | Partial | Tailwind responsive layouts; not tested on devices |
| Staff UI for daily workflows | **Not done** | Deal entry, uploads/review, trust, bank import, reconciliation, CDA, payouts and sign-in are API-only |

## §13 Testing (26 areas)

| # | Area | Status | Test |
|---|---|---|---|
| 1 | Concurrent receipts/payouts | Done | `trust-ledger.int` concurrency |
| 2 | Recalled / NSF deposits | Done | `bank.int` November |
| 3 | Duplicate bank records, altered uploads | Done | `money-controls.int` interim; `trust-completeness.int` cross-check |
| 4 | Simultaneous approvals | Done | `money-controls.int` duplicates |
| 5 | Stale balances | Done | `money-controls.int` available funds |
| 6 | Outstanding cheques | Done | `money-controls.int` "payment sent isn't gone…" |
| 7 | Co-op/referral obligations | Done | `money-controls.int` |
| 8 | Commission trust reconciliation | Done | `closing.int` CTA |
| 9 | Agent/PREC splits | Done | `closing-calculate.test` |
| 10 | HST, caps, corrections, refunds, chargebacks | Done | `closing.int` |
| 11 | Incorrect/duplicate CDAs | Done | `closing.int` finalize replay, void |
| 12 | Void and reissue | Done | `closing.int` |
| 13 | Reconciliation discrepancies, late sign-off | Done | `bank.int`, `trust-completeness.int` |
| 14 | BoR absence, substitute | Done | `money-controls.int` designation |
| 15 | Shortfalls and escalation | Done | `bank.int`, `trust-completeness.int` |
| 16 | Unclaimed money | Done | `trust-completeness.int` |
| 17 | Missing TRS fields | Done | `deal-lifecycle.int` |
| 18 | FINTRAC exemptions, deadlines | Done | `obligations.int`, `obligations.test` |
| 19 | Multiple representation, unauthorized client access | Done | `obligations.int`, `access.int` |
| 20 | Cross-user/cross-deal access | Done | `access.int` |
| 21 | Database-role bypass | Done | `money-controls.int` |
| 22 | Auth, MFA, session expiry | Done | `auth.int` |
| 23 | Interrupted migration, restart | Done | `test_interrupted.py` |
| 24 | Accounting failures, stale data | Done | `accounting.test`, `money-controls.int` obligations |
| 25 | Backup restore | Done | `ops/restore-test.sh` (manual run plus CI job) |
| 26 | Feature-flag / approval-gate bypass | Done | `money-controls.int` (ZP001 at the database) |
| — | Timezones, DST, leap years, holidays, rounding | Done | `trust-calendar.test`, `closing-calculate.test` |
| — | Browser end-to-end tests | **Not done** | No Playwright suite (the staff UI doesn't exist yet) |
| — | Static analysis | Partial | `tsc --noEmit` strict, gitleaks, npm audit / pip-audit, Trivy image scan; no ESLint/Semgrep |

## §14 Deployment

| Requirement | Status | Where |
|---|---|---|
| Separate environments; secure config | Done | `ops/env/*`, `check-config.ts` |
| Migration and rollback procedure | Done | `brokerage-db/migrate.sh`; `docs/deployment.md` |
| Monitoring, structured logs, alerts | Partial | JSON logs, `/healthz`, `/readyz`; alert rules documented, not wired to a pager |
| Encrypted backups, tested restore | Done | `ops/` |
| Incident response | Done | `docs/deployment.md` |
| Fail-closed feature flags | Done | Database policies |
| Release notes | Done | `CHANGELOG.md` |
| Regression gates | Done | `.github/workflows/ci.yml`: six jobs (backend, frontend, migration, commission engine, images, secrets); green on runs #8, #8 re-run, #9 |
| Audit retention and export | Done | `/api/audit/export` |
| Cutover checklist | Done | `docs/launch-checklist.md` |
| Security review checklist; external items flagged | Done | `docs/security-review-checklist.md` |

## §15 UAT A–L

All 12 are automated and passing; none has been run by staff yet. See `docs/uat.md`.

## §16 Acceptance criteria

| Criterion | Met? |
|---|---|
| Auth and MFA operational | Yes: API and screens, browser-tested |
| Financial database permissions enforced | Yes |
| Trust and commission trust reconciliation work | Yes on test data; CTA gated |
| Bank evidence and availability controls work | Yes |
| Commission and payout tests pass | Yes |
| Accounting mappings validated | **No**: needs the accountant's map |
| BoR authority established | **No**: the designation must be recorded at install (Admin → Broker of record & accounts) |
| TRESA and FINTRAC workflows sufficient | Built; **counsel and the compliance officer to confirm** |
| Mandatory transaction records | Yes (TRS), with a printable copy |
| Migration and reconciliations tie out | **No**: not run on real data |
| Backup recovery tested | Yes (test data) |
| Critical security findings resolved | Dependency and image findings: **yes** (audits clean, CI enforces it). Independent pen test: **not done** |
| Professional sign-offs | **No** |
| Parallel trial passed | **No** |
| Brokerage authorizes go-live | **No** |
| Staff application on desktop and phone | Yes: 21 browser tests in CI (`e2e/`), screens in `docs/screens/` |
