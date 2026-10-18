# Zareh Homes back office API

Fastify + Prisma on PostgreSQL. Node 22.18+ runs the TypeScript directly (no build step).

## Setup

```bash
npm install                      # also runs `prisma generate` against ../brokerage-db/schema.prisma
```

Database, in order:

1. `prisma db push` for the v1 schema, then `psql -f ../brokerage-db/constraints.sql`
2. `psql -f ../brokerage-db/migrations/002_ontario_reco_cra.sql`
3. `psql -f ../brokerage-db/migrations/003_trust_ledger_invariants.sql`
4. `psql -f ../brokerage-db/migrations/004_document_compliance.sql`
5. `psql -f ../brokerage-db/migrations/005_closing_cda.sql`

Use plain `psql -f` (not `--single-transaction`) for 003 and 004: they change enum values before their main transaction.

## Run

```bash
npm start                        # refuses to start until real auth is wired into buildApp
ALLOW_DEV_AUTH_HEADER=true npm start   # local only: trusts an x-user-id header
UPLOAD_DIR=/path/to/uploads            # where document files go (default ./var/uploads)
```

Printed on every CDA, all required (the server won't start without them):
`BROKERAGE_LEGAL_NAME`, `BROKERAGE_ADDRESS`, `BROKERAGE_PHONE`, `BROKERAGE_EMAIL`, `BROKERAGE_HST_NUMBER`, `BROKER_OF_RECORD`, and optionally `BROKERAGE_RECO_REGISTRATION`.

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
| POST | `/api/deals/:dealId/trust/holds` | Admin, compliance admin, managing broker |
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

## Document compliance endpoints

| Method | Path | Who |
|---|---|---|
| POST | `/api/deals` | Staff, or an agent on the deal. Adds the mandatory slots |
| POST | `/api/deals/:dealId/parties` | Staff, or an agent on the deal. Adds FINTRAC slots for new clients |
| GET | `/api/deals/:dealId/documents` | Staff, or an agent on the deal |
| POST | `/api/documents/slots/:slotId/files` | Staff, or an agent on the deal. `multipart/form-data`: `metadata` (JSON, FINTRAC slots only) then `file` |
| POST | `/api/documents/slots/:slotId/review` | Managing broker, compliance admin |
| GET | `/api/documents/files/:fileId` | Staff get the full FINTRAC record; agents get the ID number masked |
| GET | `/api/documents/files/:fileId/content` | Staff, or an agent on the deal |
| GET | `/api/notifications?unread=true` | Signed-in user |
| POST | `/api/notifications/:id/read` | Signed-in user |
| GET | `/api/notifications/stream` | Signed-in user (Server-Sent Events) |

Mandatory slots come from the `DocumentType` table (`requiredFor` sides + `slotScope`), seeded by migration 004:

| Deal side | Slots |
|---|---|
| Buyer | APS, Form 320, FINTRAC ID record per individual buyer, FINTRAC corporate record per corporate buyer |
| Seller (listing) | Form 200, FINTRAC ID record per individual seller, FINTRAC corporate record per corporate seller |
| Dual | All of the above |

Status flow: `MISSING → PENDING_REVIEW → APPROVED | NEEDS_REVISION`, and `NEEDS_REVISION → PENDING_REVIEW` on re-upload. Approved is final. The database enforces this too.

A review must name the file version it's for (`fileId`). If a newer version was uploaded meanwhile, the review is refused with `STALE_REVIEW`.

## Closing and CDA endpoints

| Method | Path | Who |
|---|---|---|
| GET | `/api/deals/:dealId/closing` | Staff. The numbers: a live preview, or the frozen statement once finalized |
| GET | `/api/deals/:dealId/closing/cda?audience=lawyer` | Staff. Print-ready CDA for the closing lawyer (DRAFT watermark until finalized) |
| GET | `/api/deals/:dealId/closing/cda?audience=internal` | Staff. Same, plus agent commission statements and the HST position |
| POST | `/api/deals/:dealId/closing/finalize` | Managing broker, `Idempotency-Key` header. Deal must be CLOSED |

Finalizing is one database transaction. It recomputes from fresh data, runs the audits, posts the trust distributions (co-op, general account, balance to the lawyer) through the trust ledger's own checks, and stores the issued CDA documents. That record can't be changed afterwards.

The closing math is in `src/closing/calculate.ts` (pure function, documented step by step). It refuses to produce a CDA when:

| Code | Why |
|---|---|
| `FINTRAC_NOT_APPROVED` | A FINTRAC record on the deal isn't approved (or there are none) |
| `TRUST_WILL_NOT_BALANCE` | The deal's trust balance wouldn't be exactly $0.00 after the closing distributions |
| `DEPOSIT_NOT_IN_TRUST` | The deal says we hold the deposit but the trust ledger is empty |
| `TRUST_HOLD_ACTIVE` | The trust funds are flagged Disputed / Unclaimed |
| `CLOSING_LAWYER_MISSING` / `COOP_BROKERAGE_MISSING` | No one to address the CDA to |
| `GCI_SHARES_INVALID` | Co-listing agents' GCI shares don't add up to 100% |

Agent splits come from the deal (`TransactionAgent.splitPct`); the annual cap and per-deal fees come from the agent's `CommissionPlan`. Cap year-to-date totals come from earlier finalized closings.

## Dashboard endpoint

`GET /api/dashboard` returns the signed-in user's dashboard. Which sections come back depends on their role:

| Section | Roles | Contents |
|---|---|---|
| `brokerage` | Admin, compliance admin, managing broker | Company dollar, closed volume and HST to remit (YTD); trust balance per account; deals past closing still holding trust funds; firm deals closing within 14 days (or overdue) without FINTRAC approval |
| `personal` | Agent, managing broker | Volume, gross GCI and net payouts (YTD); PREC HST received; cap progress; documents sent back with the reviewer's comment |

Money is integer cents (`…Cents`). Financial figures come from finalized closings, so they always match the issued CDAs.

## Pipeline endpoint

`GET /api/pipeline` returns the deal board: active listings, conditional deals, firm deals, and deals closed this calendar month (Toronto time). Agents get their own listings and deals; admins, compliance admins and the managing broker get everyone's.

Each deal card carries a deposit badge worked out from the trust ledger (`src/pipeline/deposit-status.ts`):

| State | Badge | When |
|---|---|---|
| `CLEARED` | green, "Deposit Received & Cleared" | Full deposit in trust, banked within 5 business days of receipt |
| `LATE_TO_TRUST` | red | Banked more than 5 business days after it was received (TRESA) |
| `OVERDUE` | red, "Deposit Missing / Overdue" | The APS due date passed and the deposit, or part of it, isn't in trust |
| `PARTIAL` | amber | Part received, balance not yet due |
| `DUE` | neutral | Nothing received, due date still ahead |
| `NOT_RECORDED` | amber | Nothing received and no due date on the deal |
| `HELD_ELSEWHERE` | neutral | The co-op brokerage, a lawyer or the builder holds it |
