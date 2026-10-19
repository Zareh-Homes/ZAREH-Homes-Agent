# Changelog

Versions are the database migration level. The app checks for it at `/readyz`.

## 0.18.1 (2026-10-19): Pilot acceptance checks

- **Migration 019:** `LEASE_SETTLEMENT` policy (off): no lease CDA or payment out of trust until counsel signs off; duplicate commission receipt references refused.
- **Migration 020:** the restricted app login can take the row locks its triggers need (voiding a CDA failed in production; found by the staging rehearsal). Records stay unchangeable through their triggers.
- Bank → Available funds screen; partial receipts and payout statuses explained; "Outside the pilot" notices; readable trade record and CDA messages; finalize after a void issues a new CDA.
- Browser tests 21 → 31 (CDA, payouts, partial receipts, lease gate, trade record), run as the restricted login; CI `staging` job rehearses an HTTPS production deployment, then checks cookies, permissions, logs, audit and backup restore.
- Docs: `pilot-scope.md`, `staff-onboarding.md`, `pilot-test-checklist.md`.

## 0.18.0 (2026-10-19): Staff application, leases, browser tests

Not released to production. Staging-ready only.

- **Review fixes (`0e1dda1`):** the 5-business-day deposit rule is measured to the bank's posting date; a shortfall month can be signed on time with the discrepancy shown and the incident open; large cash opens an internal preparation task only.
- **Leases (`09fdb34`, migration 018):** landlord/tenant deals end to end: documents, commission, CDA wording, balance to the landlord.
- **Directory and work queues (`f1a0059`):** list endpoints for deals, users, accounts, statements and reconciliations; approvals and review queues; first-admin script.
- **Staff application (`62552fd` and later):** sign-in with two-factor, invitations and resets; deals and the deal workspace; document and compliance review; trust ledger, holds and receipt-of-funds; bank import, verification, matching and reconciliation; CDA and payouts; approvals; admin; printable Trade Record Sheet. Desktop and phone. Figures are the server's; the app sends no money and files nothing.
- **Browser tests (`e2e/`):** 21 Playwright tests against the real API and a fresh database, in CI (`e2e` job). They found and fixed: wrong two-factor code or current password signing you out; the deposit button hidden on our-brokerage deals; a nested `<main>`; header overflow at 1366px.
- Screens from the browser run: `docs/screens/`.

## 0.17.1 (2026-10-19): CI fixes, dependency advisories cleared, images verified in CI

- **Backend CI failure fixed (`5e53f4d`).** The restricted-role end-to-end test logged in as `zareh_app_test` without a password. Local test databases trusted local connections, so it passed; GitHub's PostgreSQL requires a password over TCP (scram-sha-256), so it failed with "Authentication failed". The test now sets a fresh random password each run. It was reproduced first against a local cluster configured like CI.
- **Backend dependencies (`0b054c4`):** Prisma 6.19.3 plus a `deepmerge-ts` 8.0.2 override; `npm audit` is clean, so the temporary allow-list was removed.
- **Frontend tooling (`412c59c`):** vitest 4.1.11, vite 7.3.6, Tailwind 4.3.3; `npm audit` is clean with dev tools included. All 16 demo screens are pixel-identical before and after.
- **Images:** node 22.23.3 and nginx 1.30.5. CI builds and starts both images against a TLS-only database as the restricted login, and scans them with Trivy.
- **Migration tool:** pytest 9.1.1; `pip-audit` in CI.
- **API image bug found and fixed (`b74c2e6`):** the build stage had no OpenSSL, so Prisma generated the OpenSSL 1.1 query engine; the runtime (OpenSSL 3) couldn't load it, and the API crashed on its first query. Found by the new image smoke test. The original Dockerfile had the same flaw.
- **API image hardened (`4fe3f77`):** the npm, npx, yarn and corepack bundled with the Node base image are removed from the runtime stage. Trivy had found 10 high advisories inside the bundled npm, none in the app or the OS. Both images now scan clean.

## 0.17.0 (2026-10-18): Completion directive, phases 1–8

Not released to production. Staging-ready only; see `docs/launch-checklist.md`.

- **P8 `c435d7d`:** Tracked migration runner with checksums, health and readiness endpoints, audit-log export, encrypted backup and restore test, Dockerfiles, nginx, environment templates, CI, UAT workflows.
- **P7 `cfb6c81` (017):** RECO annual filing preparation (figures with sources, BoR attestation review, submission record), oversight dashboards with metric definitions, migration hardening (read-back verification, source fingerprints).
- **P6 `4cb7411` (016):** TRESA rule engine (Information Guide, representation, multiple representation, self-represented parties, seller offer direction) and FINTRAC obligations (determinations, receipt of funds, large cash, STR, compliance program).
- **P5 `a31f4a0` (015):** Lifecycle guard, conditions, amendments, terminations, offers register, Trade Record Sheet with agent and BoR signatures.
- **P4 `f8ff452` (014):** Effective-dated commission plans, adjustments, recoveries, sales tax by province and date.
- **P3 `a4de5cb` (013):** Available funds net of obligations and unpresented payments; payment confirmation from verified bank files; read-only QBO/Xero adapters; journal export.
- **P2 `5412ac4` (012):** Ontario business-day calendar, beneficiary liabilities, altered-record detection, service-fee exception, amended reconciliations, commission trust ledger, unclaimed money register.
- **P1 `840ba94` (010–011):** Session authentication, MFA, CSRF, rate limits, append-only audit log, field and file encryption, privacy workflows.

## 0.9.0 (`fc25790`): Money controls

Bank evidence, segregation of duties, BoR designations, payout state machine, restricted database role.

## Earlier

Schema, trust ledger, document compliance, closing/CDA, dashboards, pipeline, bank reconciliation, Lone Wolf migration.
