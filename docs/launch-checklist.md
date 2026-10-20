# Launch checklist

Three separate gates. Pass each one before starting the next.

## 1. Technical staging

- [x] Migrations apply from scratch through `migrate.sh`; a re-run changes nothing; a changed file is refused
- [x] All automated suites green (backend 186, migration 48, frontend 34, commission engine 6, browser end-to-end 37)
- [x] Encrypted backup → restore → manifest comparison passed
- [x] Production config check refuses unsafe settings; the app refuses superuser
- [x] CI green on GitHub: all six jobs on runs #8 (`4fe3f77`), #8 re-run, and #9 (`5e35c52`)
- [x] Docker images built, started against a TLS database as the restricted login, and scanned (CI `images` job)
- [x] Staging deployment rehearsed in CI on every push (HTTPS, TLS database, restricted login, cookies, logs, audit, backup restore)
- [x] Local demo brokerage (`ops/local-trial.sh demo`) fills itself and hands over every account (CI)
- [ ] Staging host provisioned: TLS certificate, managed PostgreSQL 16 with PITR, secret store, uptime + log alerts
- [x] Dependency advisories: backend, frontend and migration audits all clean (CI enforces it)

## 2. Controlled pilot (real deals, Lone Wolf still the system of record)

- [x] Staff UI for daily work: deal entry, documents and review, trust receipts, bank import/match, reconciliation, CDA, payouts, approvals, admin, printable TRS (browser-tested, `e2e/`)
- [x] Sign-in, two-factor, invitation and reset screens
- [ ] Legal brokerage entity, broker of record, bank accounts and RECO registration confirmed to match (CDA settings, BoR designation in Admin, account bank/last four)
- [ ] Sales-only scope agreed for the pilot (partial payouts unsupported)
- [ ] Professional decisions recorded (see `FINAL-REPORT.md` §C); policies set to match
- [ ] Counsel confirms the multiple-representation rules and citations (`compliance-obligations.md`, same-brokerage deals), the consent, remuneration and variable-commission disclosure wording, and trade record item 10 against e-Laws
- [ ] Accountant's chart-of-accounts map in `ACCOUNTING_ACCOUNT_MAP`
- [ ] Commission plans entered and approved for all 10 agents; caps and YTD carried over
- [ ] UAT A–L run by the broker of record, admin and one agent with real (redacted) documents
- [ ] Lone Wolf dry run on real exports; every rejected row resolved
- [ ] Independent penetration test of staging
- [ ] Breached-password screening at invite, reset and password change (backlog item 1)
- [ ] Sign-in rate limits shared across instances, or the deployment fixed at one app instance (backlog item 2)
- [ ] Staff trained; manual fallback (`business-continuity.md`) printed

## 3. Real financial production (replaces Lone Wolf)

- [ ] One full month in parallel: the same deals in both systems, and both reconciliations agree with the bank to the cent
- [ ] Migration run for real, with read-back verification (exit 0) and opening balances signed by the broker of record
- [ ] First monthly reconciliation signed in the new system
- [ ] Lone Wolf set to read-only; exports archived encrypted
- [ ] Alerts tested by firing each one
- [ ] Restore drill on production-sized data, timed against the RTO

Live bank transfers, accounting writes and regulator submissions stay off even at this stage. They aren't part of this release.
