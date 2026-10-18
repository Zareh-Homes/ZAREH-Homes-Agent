# Trust money controls and the monthly reconciliation

How the deals department and the broker of record handle trust money, commission and the monthly reconciliation (O. Reg. 579/05 s.13 and s.14). Nothing here moves money or contacts RECO. The system records, checks and blocks.

## Roles

- **Broker of record or designated substitute.** This is a recorded designation, not a permission (`POST /api/broker-of-record`). Someone other than the designee records it, with the supporting reference. Only a designated person can:
  - sign a reconciliation
  - attest pre-cutover history
  - record that the registrar was notified, a replenishment, or a resolution
  - turn a financial policy on or off
- **Managing broker** authorizes trust movements and approves payouts.
- **Admin (deals department)** imports bank files, matches lines, records commission received, prepares reconciliations and records payments.
- **Two people, not one.** The database refuses one person doing both halves of each pair below, unless the sole-operator exception has been signed off. Even then, each use needs a reason and is flagged.
  - import a bank file / verify it
  - record or match a commission / approve its payout
  - approve a payout / record its payment
  - prepare a reconciliation / sign it

## Accounts

| Kind | What it holds |
|---|---|
| Real estate trust | Deposits, per deal. The only account the deal trust ledger uses. Reconciled monthly under s.13. |
| Commission trust | Commission held for payout, if the brokerage uses one. Each closing's money stays separate. |
| Operating (general) | Brokerage money. Commission is received here unless a commission trust account is used. |

Commission is never received into the real estate trust account, and payouts never come straight from it.

## Bank evidence

A recorded deposit or commission is not proof of money. Evidence is a line on a bank file that **a second person has verified against the bank itself** (portal or statement).

- **Monthly statement** (`kind: MONTHLY`):
  - Must be the statement for the exact period, with the opening and closing balances printed on it, and the **date the brokerage received it**.
  - Periods must be consecutive, each opening balance must equal the previous closing balance, and the lines must add up.
- **Interim bank record** (`kind: INTERIM`): today's activity and current balance, downloaded from the bank between statements.
  - Lets a commission be verified, and funds shown to be available, the day they arrive, so payouts don't wait for the month end.
  - Interim files may overlap; a line already imported is skipped.
  - Interim records never replace the monthly statement.
- **Every import records** where the file came from (portal download, bank email, paper statement, other with a note), who imported it, and its hash. The same file can't be imported twice.

## What blocks money

- **Trust release, refund or closing distribution:** only against deposits matched to verified bank evidence.
- **Agent, co-op or referral payout:** approval needs all of the following, checked by the database:
  - the commission received in full, not reversed, and matched to verified bank evidence
  - an approver who didn't record or match the commission
  - a verified balance for the paying account no more than 3 days old, covering this payout plus everything already approved or paid from that account since the balance was taken
- **Co-op brokerage and referral payables:** disabled until the `THIRD_PARTY_PAYABLES` policy is signed off by counsel and the accountant.

## Each month

1. **Import the monthly trust statement** with the date it was received. **The 30-day clock starts on that date.** If no statement arrives, the deadline is 30 days after month end, and the dashboard shows the month as missing.
2. **A second person verifies it** against the bank (`POST /api/bank/statements/:id/verify`).
3. **Check the matches.** When two entries could fit, nothing is guessed; match those by hand.
4. **Prepare the reconciliation.** It shows:
   - the bank balance, adjusted for deposits in transit and uncashed cheques
   - the ledger balance
   - the amount owed, deal by deal
   - every outstanding item, every bank item missing from the ledger, stale deposits and overdrawn deals
5. **Deal with exceptions.** A bank item missing from the ledger explains a difference but never cancels it.
6. **Broker of record signs** within the deadline:
   - The statement must be verified first.
   - Months are signed in order.
   - A month that doesn't balance **can still be signed on time**, with an explanation, as long as its shortfall has a trust incident. Signing doesn't resolve anything: the reconciliation shows "signed with discrepancy" and the incident stays open.

## Shortfalls (s.14)

When a reconciliation shows the bank holding less than clients are owed (or a deal is overdrawn), the system opens a **trust incident** and alerts every managing broker. The brokerage must then, immediately:

1. **Notify the RECO registrar.** Record when, how and the reference: `REGISTRAR_NOTIFIED`.
2. **Deposit enough brokerage money to eliminate the shortfall.** Record the amount and bank reference: `REPLENISHED`.
3. **Resolve the incident.** Only allowed once both are recorded, or once a later balanced reconciliation shows the "shortfall" was a ledger error, such as an unrecorded returned deposit.

Discrepancies that aren't shortfalls get their own incident, so nothing is lost.

## Corrections

- **Commission receipt reversed** (wire recalled): blocks any further approval. A payout already paid is flagged for recovery.
- **Agent payment returned:** recorded, then paid again under the same approval, or the approval is cancelled.
- **Wrong CDA:** void it with a reason, correct the deal, and finalize again. The voided CDA, its approvals and its payments stay on record. Payments already made carry forward. If the correction changes what trust paid out, reverse those distributions first.

## Cutover from Lone Wolf

The migration records the broker of record's **pre-cutover attestation** for migrated history. Import the first real statement right after cutover; the first reconciliation is the real check.

## Deployment: the application's database login

Run the application as a login role that is a member of `zareh_app`, never as the table owner:

```sql
CREATE ROLE zareh_app_prod LOGIN PASSWORD '…' IN ROLE zareh_app;
```

`zareh_app` can't:

- update or delete the financial record
- truncate tables
- alter tables
- disable triggers

Run migrations as the owner. **Every future migration that adds a table must grant it to `zareh_app` explicitly**, as migration 009 does.

## Needs sign-off before live use

Listed in the latest money-controls review. In short:

- the commission trust account and co-op/referral routing
- the sole-operator exception
- the pre-cutover attestation
- the matching windows and the 3-day balance freshness
- the treatment of bank fees in trust
