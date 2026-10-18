# Lone Wolf → Zareh Homes cutover

`lonewolf_migrate.py` moves three Lone Wolf exports into the Ontario back-office database:

| File | Becomes |
|---|---|
| `agents_export.csv` | `User` (agents, PREC and HST details) |
| `deals_historical_export.csv` | `Transaction`, `TransactionAgent`, `TransactionParty`, compliance slots for open deals |
| `trust_ledger_export.csv` | `TrustLedgerEntry` (through the ledger's own triggers) |

## Setup

```bash
cd migration
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

## Cutover runbook

1. **Freeze Lone Wolf** (no new entries), then export the three files.
2. **Dry run.** It validates everything and writes nothing:
   ```bash
   .venv/bin/python lonewolf_migrate.py --dry-run \
     --broker-email broker@zarehhomes.ca --trust-account 4321
   ```
3. **Review** `ontario_migration_errors.log` and `migration_out/rejected_*.csv`. Each rejected row is saved with its row number and the reason. Fix the data in Lone Wolf or in the CSV, then dry-run again.
4. **Run for real.** Drop `--dry-run` and point `DATABASE_URL` (or `--database-url`) at production.
5. **Re-run when needed.** Fix the rejected rows and run again. Rows already imported are recognized and skipped, so nothing is duplicated.

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Clean |
| 1 | Finished, but some rows were rejected |
| 2 | Structural problem (missing file or column). Nothing was written |
| 3 | Stopped before writing because more than `--max-reject-rate` (default 10%) of rows failed. Use `--force` to write anyway |

## Before anything touches the database

- **Structure.** All three files are read, and every required column must be found. Duplicate IDs are reported, as are deals pointing at unknown agents and trust entries pointing at unknown deals.
- **Preflight.** The required tables must exist, `--broker-email` must be an active `MANAGING_BROKER`, and the trust account must exist and be active.
- **Every row is transformed and validated in memory.** Only rows that pass are written.

## Columns

Headers are matched loosely: case, spaces and punctuation are ignored. Common Lone Wolf names are already recognized, for example "Trade #", "Corporation Name", "HST #", "Date Deposited" and "Payor/Payee". If your export uses other names, map them:

```json
{"agents": {"email": "Agent E-mail"}, "deals": {"close_date": "Completion"}, "trust": {"amount": "Net Amt"}}
```

```bash
.venv/bin/python lonewolf_migrate.py --column-map columns.json ...
```

## Rules applied

- **Money.** `$`, `CAD`, commas and spaces are stripped, and `(1,000)` or `1,000-` is read as negative. Amounts are stored as exact `Decimal` cents. Floats are never used.
- **Dates.** Stored as ISO 8601.
  - `DD/MM/YYYY` is read day-first. `MM-DD-YY` is read month-first. Switch either with `--slash-dates` or `--dash-dates`.
  - A date that only makes sense the other way round (`11/30/2024`) is read that way, with a warning.
  - An impossible date (`31/02/2024`) rejects the row.
- **Tax.**
  - The rate follows the closing date: 13% HST from July 1, 2010, and 5%, 6% or 7% GST before that.
  - If tax was recorded, it's checked against the rate. A mismatch is kept as recorded and flagged for review.
  - If tax is missing, it's backfilled at the rate in effect on that date.
  - If only a combined total exists, the tax is backed out of it.
  - Non-Ontario deals are rejected.
- **PREC.** An agent is marked `is_prec` only when the corporation name contains "Personal Real Estate Corporation". Any other company name (for example "Shah Holdings Inc.") is imported as an individual, with a warning.
- **HST numbers** must look like `123456789RT0001`. Anything else is left blank, with a warning.
- **Co-agents.** Several rows with the same trade number are one deal. The rows must agree on the deal facts, and GCI shares must add to 100.
- **Trust.**
  - **All-or-nothing per deal.** One bad entry holds back that deal's whole trust history, so balances are never half-migrated.
  - Balances can't go negative.
  - Reversals must point at the entry they reverse.
  - Deposits must be by bank draft, wire or certified cheque. A personal cheque or EFT deposit is rejected rather than relabelled.
  - A deposit banked more than 5 business days after receipt is imported as recorded, with a warning.
- **Authorization.** The new ledger requires a managing broker on every trust entry. The `--broker-email` broker is recorded as authorizing the migrated entries, with "Migrated from Lone Wolf entry …" as the reference.

## Outputs

| File | What |
|---|---|
| `ontario_migration_errors.log` | One JSON line per problem: source, row number, severity, reason and the full original row |
| `migration_out/rejected_{agents,deals,trust}.csv` | Rejected rows, with `_row_number` and `_error` columns |
| `migration_out/migration_report.json` | Counts read, rejected, warned and written, plus validated trust totals |

## Not migrated

- **Commission plans and caps.** Set these up per agent in the new system.
- **Managing broker and admin roles.** Agents come in as `AGENT`. Promote roles manually.
- **Documents and attachments.** Slots are created for open deals; the files need uploading.

Read through the warnings once. They're imported as-is, but each one is something worth a second look.

## Tests

```bash
.venv/bin/pip install -r requirements-dev.txt
DATABASE_URL=postgresql://... .venv/bin/python -m pytest
```

The end-to-end test runs the sample exports in `tests/fixtures/` against a real database. It is skipped without `DATABASE_URL`.
