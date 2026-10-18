# Business continuity

## Targets (proposed — the broker of record to confirm)

| | Target | How |
|---|---|---|
| RPO (data you can lose) | 24 hours on the database, or 5 minutes with WAL archiving | Nightly encrypted `pg_dump`. Turn on continuous WAL archiving (or the managed database's point-in-time recovery) for 5 minutes. |
| RTO (time to be back) | 4 hours | Restore the latest backup to a new database and redeploy the images. The tested restore took about 1 second on test data; real data will take longer, so time a full restore on staging. |

Trust deadlines continue while the system is down, so the manual fallback below matters more than the RTO.

## If the system is down

Trust work can't wait (5 business days to deposit; monthly reconciliation):

1. Receive deposits as usual into the trust account at the bank. Write a paper receipt: date, amount, payer, deal, method, received by.
2. Don't release any trust money until the system is back. If you must (e.g. a closing), the broker of record authorizes it in writing, citing the CDA or release. Enter it in the system first thing after recovery, with the paper authority uploaded.
3. Keep a dated list of everything done on paper. On recovery, enter it in order and reconcile against the bank statement.

## Restoring

1. Pick the backup (`<stamp>.dump.age` + `.manifest.json`).
2. The broker of record decrypts it with the offline private key.
3. Follow `ops/restore-test.sh`: restore into a new database, run the manifest comparison, check trust totals match.
4. Point the app at it, check `/readyz`, then sign in and look at the trust balances against the last bank statement.
5. Restore `UPLOAD_DIR` from its backup. `FILE_ENCRYPTION_KEY` must be the same key.

## Keys (single points of failure)

| Key | Lose it and… | Keep |
|---|---|---|
| Backup private key (age) | Backups can't be read | Two offline copies (BoR safe + sealed envelope with counsel or a second principal) |
| `FIELD_ENCRYPTION_KEY` | ID numbers and payer details unreadable | Secret store + offline escrow copy |
| `FILE_ENCRYPTION_KEY` | Uploaded documents unreadable | Secret store + offline escrow copy |
| Database owner password | Can't run migrations | Secret store; reset by the host |

## People

- At least two people who can sign in as managing broker with MFA, so payouts and reconciliations don't stop when one is away.
- An alternate broker of record designation on file, ready to be recorded if needed (a second person records it).
- Recovery codes for each privileged user are stored offline.

## Lone Wolf during cutover

Keep Lone Wolf read-only and its exports archived (encrypted) until at least two monthly reconciliations have been signed in the new system and agree with the bank.
