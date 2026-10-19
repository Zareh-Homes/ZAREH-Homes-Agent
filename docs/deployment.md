# Deployment and release

## Environments

| | Development | Staging | Production |
|---|---|---|---|
| Data | Synthetic only | Synthetic or redacted copy | Real |
| Auth | `ALLOW_DEV_AUTH_HEADER=true` allowed | Session auth only | Session auth only; the config check refuses the dev header |
| Demo screens | On | Off | Off (`VITE_ENABLE_DEMO=false` is baked into the image) |
| Backups | Optional | Encrypted | Encrypted, nightly, plus before every migration |
| Example config | `ops/env/development.env.example` | `ops/env/staging.env.example` | `ops/env/production.env.example` |

Production secrets come from the host's secret store only. Nothing real goes in git; gitleaks runs in CI.

## First install

1. Provision PostgreSQL 16 with TLS (`sslmode=verify-full`). Create the owner role used only for migrations.
2. `DATABASE_URL=<owner> brokerage-db/migrate.sh`
3. `psql <owner> -v pw='<from the secret store>' -f ops/create-app-login.sql`. This creates `zareh_app_login` with no superuser, no BYPASSRLS and no ownership.
4. Fill the production env from the secret store, then `NODE_ENV=production node backend/scripts/check-config.ts` (must exit 0).
5. `docker compose up -d` (or run the two Dockerfiles behind `ops/nginx.conf`).
6. Check `GET /healthz` (process up) and `GET /readyz` (database reachable as the app role, latest migration applied).
7. Create the first admin by invitation and enrol MFA. Record the broker of record designation (it needs a second person).

## Releasing a change

1. CI must be green on the commit: migrations from scratch and re-run, Prisma drift, typecheck, all test suites, config check, `npm audit` (production dependencies), backup/restore round trip, gitleaks.
2. Deploy to staging, run the UAT suite and a manual smoke test.
3. Production: `brokerage-db/migrate.sh --backup-dir /secure/backups` takes an encrypted backup before applying anything. It refuses if an applied migration file has changed (exit 3).
4. Deploy the new image. `/readyz` reports `EXPECTED_MIGRATION`, so an app newer than its database stays out of the load balancer.

### Rollback

Migrations are forward-only (append-only history can't be "un-applied" safely).

- **App only:** redeploy the previous image. Migrations are additive, so the old app keeps working.
- **Bad migration:** stop the app, restore the pre-migration backup (`ops/restore-test.sh` shows the exact steps and checks), then fix forward with a new migration.

Never edit an applied migration file.

## Feature flags

The real switches are database policies (`FinancialPolicyDecision`), changed only by the broker of record with a recorded reason. A second person is required where noted. All are off at install:

| Policy | Unlocks | Needs first |
|---|---|---|
| THIRD_PARTY_PAYABLES | Approving co-op/referral payables from operating | Counsel + accountant |
| COMMISSION_TRUST_ACCOUNT | Commission trust ledger and reconciliation | Counsel + accountant (legal basis) |
| SOLE_OPERATOR_EXCEPTION | One person does two separated duties (each use needs a reason and is flagged) | BoR decision; not needed with 10 agents and separate staff |
| CIVIC_HOLIDAY_IS_HOLIDAY | August civic holiday counts for deadlines | Counsel |
| UNCLAIMED_MONEY_REMITTANCE | Recording a remittance of unclaimed trust money to RECO (paid outside the system) | BoR confirms RECO's current process |
| MANUAL_OBLIGATIONS_PROCEDURE | Manually attested obligations figures | Accountant |

Environment variables `ACCOUNTING_PROVIDER` and `ALLOW_DEV_AUTH_HEADER` must stay unset in production. The server warns, or refuses to start.

## Monitoring and alerts

Set these up on the host:

- Uptime check on `/healthz` every minute. Page on 3 failures in a row.
- `/readyz` not 200 for 5 minutes → page.
- Log alerts (JSON logs): any `level>=50`; any `TRUST_SHORTFALL` notification or trust incident; `ZD003` (someone tried to change history); repeated 401/429 from one IP; `POLICY_NOT_APPROVED` spikes.
- Nightly backup job exit code ≠ 0 → page. Weekly restore test (below) failure → page.
- Disk usage on the database and upload volumes > 80%.

The in-app oversight dashboard (`/oversight/broker`) shows overdue reconciliations, deposits past 5 business days, open incidents and FINTRAC deadlines. It is not a substitute for paging.

## Incident response (summary)

1. **Contain:** suspend affected users (ends their sessions at once), or take the app offline. The data stays intact; nothing is deleted.
2. **Preserve:** export the audit log for the window (`GET /api/audit/export?from&to&format=json`) and take a backup.
3. **Assess:** for a privacy breach, use the privacy breach workflow (real risk of significant harm → OPC report + notices; the record can't close until both are logged). For a trust shortfall, s.14 notice to RECO through the incident workflow.
4. **Fix forward** and record what happened.

## Audit log retention and export

The audit log is append-only in the database. Keep it for at least as long as the deal records it covers (the brokerage's retention schedule; RECO requires 6 years for trade records). Export with `/api/audit/export` (CSV or JSON, date range). It is broker/admin only, and the export itself is audited. Retention review never deletes deals under legal hold.

## Backups

- Nightly: `ops/backup.sh` writes `pg_dump` encrypted with `age` to the broker's public key, plus a manifest (row counts, trust totals). The private key stays offline with the broker of record.
- Uploaded documents: back up `UPLOAD_DIR` with the same schedule. Files are already encrypted with `FILE_ENCRYPTION_KEY`, which is kept separately from the backups.
- Weekly: `ops/restore-test.sh` restores the latest backup into a scratch database and compares it to the manifest. The test in this repository passed: 18 migrations, 46 immutable triggers, trust total matched.

## Cutover from Lone Wolf

See `docs/launch-checklist.md` and `migration/README.md`.

## Planned upgrades

### Prisma 7 (separate change, not a security fix)

Prisma 6.19.3 with the `deepmerge-ts` override has no open advisories, so there's no security reason to rush this. Prisma 7 is a breaking upgrade:

- The client needs a driver adapter (`@prisma/adapter-pg`) instead of the built-in engine.
- Configuration moves from `package.json#prisma` to `prisma.config.ts`.
- The generated client moves to an explicit output folder.
- The only release that bundles the fixed `deepmerge-ts` (7.10.1) was 3 days old when checked.

Do it on its own branch:
1. Upgrade `prisma` and `@prisma/client` together, add the adapter, move the config.
2. Remove the `deepmerge-ts` override if Prisma's own dependency is already fixed.
3. Run the full CI, including the restricted-role and concurrency tests, which depend on how connections are opened.
4. Rehearse on staging with a restored backup before production.

Rollback is redeploying the previous image. The database schema doesn't change.

### Base images

Rebuilding picks up OS patches. The Node and nginx versions are pinned, so bump them deliberately (Node 22 LTS security releases; the nginx stable branch), and the Trivy step in CI catches anything fixable that's been missed.
