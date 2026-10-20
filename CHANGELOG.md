# Changelog

Versions are the database migration level. The app checks for it at `/readyz`.

## 0.18.2 (2026-10-19): Local demo

- `ops/local-trial.sh demo`: a fictional brokerage filled through the real screens, with a one-time sign-in link per demo person (`backend/scripts/demo-handover.ts`, demo databases only). Walkthrough in `docs/demo-walkthrough.md`.
- Fix: a half-finished sign-in in the same browser no longer blocks signing in or using an invitation or reset link.
- Trade record items show words instead of stored codes, without double numbering.
- Fix: saving anything failed when the app was opened over plain http by name or address (not localhost), because the browser withholds `crypto.randomUUID` there. Idempotency keys now come from `crypto.getRandomValues`.
- `API_REQUESTS_PER_MINUTE` (default 600) sets the per-address request limit; sign-in limits are unchanged.
- Browser tests 31 → 37 (demo brokerage, walkthrough tour, handover). Backend 185 → 186.

## 0.18.3 (2026-10-19): Review of the demo tour

- CDA: "Brokerage keeps" (share plus its HST) replaced by the brokerage share before expenses and, separately, the HST on it to remit. Display only; calculations unchanged.
- Payouts recorded as sent but not yet on a verified bank file show "Sent, not confirmed by the bank" (amber), not "Paid".
- Fix: the accounting page counted a payment that came back as still "sent, not confirmed" ($26,250 instead of $13,125). It now counts only payments whose latest event is the payment.
- Fix: a deal's Trust tab showed the stored "Awaiting" status; it now shows the same deposit status as the pipeline (e.g. "Deposit Missing / Overdue").
- Broker oversight: new count of firm or closed deals without an agent-signed trade record (before, only sheets the agent had signed appeared).
- Dashboard: "Trust ledger balance (what we owe clients)", with the part not yet confirmed by a bank file.
- Available funds: a warning when the attested obligations figure is below this year's net HST on CDAs. It doesn't block approval.

## 0.18.5 (2026-10-20): Review of same-brokerage deals

- **Migration 022.** Consents to multiple representation need the signed copy (uploaded to a slot that appears when consent is needed) and the date the multiple representation arose. The written disclosure records that it explained duties, services, remuneration and independent advice.
- Representation without both agreements is "not verified", not "multiple representation". Agreements are compared as in force on the offer date, every co-designated agent included. A consent signed after the multiple representation arose is flagged for the broker's review, not declared a breach.
- Our buyers' offers record how each buyer is represented. Two of our buyers with different designated agents need no consent. A shared agent, brokerage representation, or our seller's own agent does, recorded against the offer before acceptance.
- New disclosures: both agreements' remuneration terms to each client (RECO Bulletin 3.3), required before firm; a seller commission that varies with who represents the buyer, to every written offeror.
- Who pays: a both-sides deal records how much of the buyer side the seller pays and where it's written. The CDA directs each lawyer to pay only their own client's part; a deposit only pays the seller's part. Calculations otherwise unchanged.
- Confidentiality: a one-side agent reaches only their own client's records, findings and offer (API-enforced, tested by direct requests); the office admin can't open client files.
- Trade record item 10: scheduled and amended completion date. The deal's next steps show the trade record until both signatures are on it.
- HST shown as "HST collected on the commission"; the net figure is labelled an estimate.
- Fix: the self-represented party form's version couldn't be chosen in the disclosure form.
- Tests: backend 197 → 202, browser 41 (same-brokerage walkthrough expanded).

## 0.18.4 (2026-10-19): Same-brokerage deals and multiple representation

- **Migration 021:** each side's commission on a both-sides deal (`listingSideGci`, `buyerSideGci`, adding up to the deal's commission); each agent's side (seller, buyer or both); a competing-buyers consent; only a managing broker or compliance admin may record a written consent (enforced by the database).
- Multiple representation is decided from the representation agreements: separate designated representatives aren't multiple representation; brokerage, the same designated agent, or mixed are. Without each client's consent the deal can't go firm.
- Two of our buyers making offers on the same property need written consent before acceptance; other buyers are told when we also act for an offering buyer.
- Commission: each agent is paid from their own side, through their own plan. CDA and trade record show both sides; no co-op, no double counting. Tested on fictional $1,000,000 deals (one agent per side, one agent on both, several on one side, unequal sides). HST check: $2,437.50 is 13% of the $18,750 commission, not of the brokerage share.
- On a same-brokerage deal an agent can't see the other client's documents.
- Fix: a trade record prepared moments earlier said "the deal changed" whenever the remuneration had several fields (stored key order).
- Fixes found on the way: shares for several agents on a deal couldn't be entered; "buyer is also our client" couldn't be set on an offer; designated agreements and offer-specific disclosures couldn't be recorded from the screens.
- Tests: backend 186 → 197, browser 37 → 41 (screens in `docs/screens/same-brokerage/`).

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
