# Launch checklist

Three separate gates. Pass each one before starting the next.

## 1. Technical staging

- [x] Migrations apply from scratch through `migrate.sh`; a re-run changes nothing; a changed file is refused
- [x] All automated suites green (backend 168, migration 48, frontend 24, commission engine 6)
- [x] Encrypted backup → restore → manifest comparison passed
- [x] Production config check refuses unsafe settings; the app refuses superuser
- [ ] CI run green on GitHub (the workflow is committed; confirm the first run)
- [ ] Docker images built and scanned (no Docker daemon in this environment)
- [ ] Staging host provisioned: TLS certificate, managed PostgreSQL 16 with PITR, secret store, uptime + log alerts
- [ ] Prisma 7 upgrade, or a recorded decision to accept the 4 high audit findings for the pilot

## 2. Controlled pilot (real deals, Lone Wolf still the system of record)

- [ ] Staff UI for daily work. Today the frontend covers dashboard, pipeline and oversight only. Deal entry, document upload/review, trust receipts, bank file import/match, reconciliation, CDA and payouts are API-only.
- [ ] Sign-in/MFA screens in the frontend
- [ ] Professional decisions recorded (see `FINAL-REPORT.md` §C); policies set to match
- [ ] Accountant's chart-of-accounts map in `ACCOUNTING_ACCOUNT_MAP`
- [ ] Commission plans entered and approved for all 10 agents; caps and YTD carried over
- [ ] UAT A–L run by the broker of record, admin and one agent with real (redacted) documents
- [ ] Lone Wolf dry run on real exports; every rejected row resolved
- [ ] Independent penetration test of staging
- [ ] Staff trained; manual fallback (`business-continuity.md`) printed

## 3. Real financial production (replaces Lone Wolf)

- [ ] One full month in parallel: the same deals in both systems, and both reconciliations agree with the bank to the cent
- [ ] Migration run for real, with read-back verification (exit 0) and opening balances signed by the broker of record
- [ ] First monthly reconciliation signed in the new system
- [ ] Lone Wolf set to read-only; exports archived encrypted
- [ ] Alerts tested by firing each one
- [ ] Restore drill on production-sized data, timed against the RTO

Live bank transfers, accounting writes and regulator submissions stay off even at this stage. They aren't part of this release.
