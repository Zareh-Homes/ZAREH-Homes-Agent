# Staging on DigitalOcean (Toronto): review

Status: **reviewed, not deployed.** Nothing has been created or paid for. Staging holds fictional data only and stays
separate from any future production account.

## Verdict

Compatible, with **one required code change** and **three deployment files**. No feature work.

| Need | Our images / code | DigitalOcean (TOR1) | Fit |
|---|---|---|---|
| API | `backend/Dockerfile`, non-root, port 3000, `/healthz` `/readyz` | App Platform service built from the repo's Dockerfile | Yes |
| Web | `frontend/Dockerfile` (nginx, port 8080, security headers) | App Platform service | Yes. App Platform routes `/api` straight to the API service, so nginx's internal `api:3000` proxy isn't used |
| HTTPS | Secure cookies, HSTS, `TRUST_PROXY=true` | Free managed certificate on `*.ondigitalocean.app` (or your domain) | Yes |
| Database | PostgreSQL 16, TLS, migrations run as owner, app uses the restricted `zareh_app_login` | Managed PostgreSQL 16, TLS required; `doadmin` can create roles | Yes. Verify on the first migration that `doadmin` can create `zareh_app` and grant it (PostgreSQL 16 rules) |
| Migrations | `brokerage-db/migrate.sh` (needs `psql`) | Pre-deploy job; a failed migration cancels the deploy | Needs a small migration image (the API image has no `psql`) |
| **Documents** | `LocalDiskStore` writes encrypted files to `UPLOAD_DIR` | **App Platform disk is temporary: lost on every redeploy** | **Blocker.** Needs a Spaces (S3-compatible) store |
| Encryption at rest | Files encrypted by the app (AES-GCM, `FILE_ENCRYPTION_KEY`) before storage; ID numbers and MFA secrets field-encrypted | Spaces and the database also encrypt at rest | Yes: Spaces would only ever hold ciphertext |
| Backups | `ops/backup.sh` (pg_dump + `age`), `ops/restore-test.sh` | Managed daily backups + point-in-time restore (7 days); a scheduled job for our own encrypted dump | Needs a backup image (pg_dump 16 + age); dumps go to a separate private Spaces bucket |
| Logs | JSON request logs, no secrets (checked in CI) | App Platform runtime logs; optional forwarding | Yes (forwarding optional for staging) |
| Uploads up to 25 MB | Fastify limit 26 MB | Within App Platform request limits | Yes |

### Before deploying (I do these once you say go, about half a day, verified in the CI rehearsal)

1. **`SpacesStore`**: the same two-method interface (`put`, `get`) as the disk store, writing the already-encrypted file
   to a private bucket. CI tests it against an S3-compatible test server. `UPLOAD_DIR` is no longer used on App Platform.
2. **`.do/app.yaml`**: the app spec (TOR1, two services, routes, health checks, pre-deploy migration job, daily backup
   job, environment variables as encrypted secrets).
3. **Migration and backup images**: small images with `psql`/`pg_dump` 16 and `age`, plus the migration files.
4. Database access limited to the app ("trusted sources"); the app connects as `zareh_app_login`, never `doadmin`.

## Smallest suitable resources and monthly estimate

Planning estimate in USD, before tax; check DigitalOcean's pricing pages when you sign up.

| Item | Size | ~USD / month |
|---|---|---|
| API service | 1 GiB RAM, shared CPU (fixed) | 10.00 |
| Web service | 512 MiB, shared CPU | 5.00 |
| Managed PostgreSQL 16 | 1 GiB / 1 vCPU / 10 GiB, single node (fine for staging) | 15.15 |
| Spaces | Two private buckets (documents, backups); one subscription | 5.00 |
| Pre-deploy migration job | Runs a minute per deploy | < 1 |
| Daily backup job | Runs a few minutes a day | < 1–2 |
| HTTPS certificate, `*.ondigitalocean.app` address | Included | 0 |
| **Total** | | **≈ 36–38** |

Optional: your own domain (about $15–20/year from a registrar) and log forwarding (free tiers exist).
512 MiB for the API would save $5 but leaves little room for 25 MB uploads being encrypted in memory; not worth it.

## Account setup (you, before authorizing deployment)

1. **Create the account** at digitalocean.com in your name (or your holding company's), with a card on file.
2. **Turn on two-factor** (Settings → Security) with an authenticator app. Save the recovery codes offline.
3. **Billing alert** (Billing → Billing alerts): set one at $60/month.
4. **Create a project** named "Zareh Back Office – Staging". Staging only; production gets its own project later.
5. **Connect GitHub** (when App Platform asks): install DigitalOcean's GitHub app with access to
   `Zareh-Homes/ZAREH-Homes-Agent` only.
6. **Don't create** the database, buckets or app yet. The app spec creates and wires them in TOR1 in one step,
   so nothing is misconfigured by hand.
7. **When you authorize deployment:** create an API token (API → Tokens) with an expiry of 30 days and
   custom scopes limited to App Platform, Databases and Spaces. Add it to this Claude environment's settings
   as `DIGITALOCEAN_TOKEN` (environment menu in the session title bar → Edit → Network secrets). Never paste it
   in chat. Revoke it after the deploy.
8. **Keys you keep offline:** at deployment I generate the file and field encryption keys (stored as encrypted app
   secrets) and an `age` key pair for backups. You get the backup private key and a copy of the encryption keys to
   keep offline: without them, backups and documents can't be read.

Then: fictional data only, no real bank accounts, no Lone Wolf records, and run `docs/pilot-test-checklist.md`.

## Ownership

You own the software and the hosting account. That works; three things keep it clean for a regulated brokerage:

- **The records stay the brokerage's.** Trust, transaction and client records are the brokerage's to keep and to
  produce for RECO and FINTRAC. Before production, a one-page agreement between you (as owner/host) and the brokerage:
  the brokerage owns its data, has admin access and a full export on request, and you keep it confidential (privacy
  law makes the brokerage accountable for client information you hold for it). Have your lawyer draft it. Not needed
  for staging with fictional data.
- **Continuity.** Add a second owner to the DigitalOcean team, or keep sealed break-glass credentials with the broker
  of record, so the records stay reachable if you can't log in.
- **Production sign-off** comes from the broker of record, since it holds trust records, even if that's also you.

## Sources (pricing and features, checked 2026-10-19)

- [App Platform pricing](https://docs.digitalocean.com/products/app-platform/details/pricing/), [App Platform pricing page](https://www.digitalocean.com/pricing/app-platform)
- [Managed PostgreSQL pricing](https://docs.digitalocean.com/products/databases/postgresql/details/pricing/), [Managed Databases pricing](https://www.digitalocean.com/pricing/managed-databases)
- [App spec reference (PRE_DEPLOY and SCHEDULED jobs)](https://docs.digitalocean.com/products/app-platform/reference/app-spec/)
- Spaces at $5/month (250 GiB + 1 TiB transfer) is from DigitalOcean's standard pricing; confirm at sign-up.
