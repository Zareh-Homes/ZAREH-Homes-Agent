# Zareh Homes back office API

Fastify + Prisma on PostgreSQL. Node 22.18+ runs the TypeScript directly (no build step).

## Setup

```bash
npm install                      # also runs `prisma generate` against ../brokerage-db/schema.prisma
```

Database, in order:

1. `prisma db push` for the v1 schema, then `psql -f ../brokerage-db/constraints.sql`
2. `psql -f ../brokerage-db/migrations/002_ontario_reco_cra.sql`
3. `psql -f ../brokerage-db/migrations/003_trust_ledger_invariants.sql` (plain `-f`, not `--single-transaction`)

## Run

```bash
npm start                        # refuses to start until real auth is wired into buildApp
ALLOW_DEV_AUTH_HEADER=true npm start   # local only: trusts an x-user-id header
```

## Test

```bash
npm test                                   # pure validation tests
DATABASE_URL=postgresql://... npm test     # + integration tests against a migrated database
```

Integration tests create their own users and deals and never delete anything (the trust ledger can't be deleted), so point them at a throwaway database.

## Trust ledger endpoints

| Method | Path | Who |
|---|---|---|
| POST | `/api/trust/deposits` | Managing broker |
| POST | `/api/trust/disbursements` | Managing broker |
| POST | `/api/trust/entries/:entryId/reversals` | Managing broker |
| GET | `/api/trust/entries/:entryId` | Staff, or an agent on the deal |
| GET | `/api/deals/:dealId/trust` | Staff, or an agent on the deal |
| POST | `/api/deals/:dealId/trust/holds` | Admin, file reviewer, managing broker |
| POST | `/api/trust/holds/:holdId/release` | Managing broker |
| PUT / PATCH / DELETE | `/api/trust/entries/:entryId` | Nobody: always 405 |

Money POSTs need an `Idempotency-Key: <uuid>` header. Amounts are decimal strings (`"40000.00"`), dates are `YYYY-MM-DD` in Toronto time.

Errors are `{ "error": { "code", "message", "details" } }`:

| Status | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | `details.issues` lists every bad field |
| 403 | `FORBIDDEN` | Wrong role |
| 409 | `INSUFFICIENT_TRUST_FUNDS` | Payout larger than the deal's own trust balance |
| 409 | `ALREADY_REVERSED`, `HOLD_ALREADY_ACTIVE`, `IDEMPOTENCY_KEY_REUSED` | |
| 422 | `DEPOSIT_NOT_HELD_BY_BROKERAGE`, `DEAL_NOT_CLOSED`, … | Business rule refused it |
| 423 | `TRUST_HOLD_ACTIVE` | Deal is flagged Disputed / Unclaimed |
| 405 | `TRUST_LEDGER_IMMUTABLE` | Edits and deletes are never allowed |
