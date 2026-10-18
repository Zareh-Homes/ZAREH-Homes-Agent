# Changelog

Versions are the database migration level. The app checks for it at `/readyz`.

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
