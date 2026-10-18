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
| Commission trust | Commission held for payout, if the brokerage uses one. Each closing's money stays separate. **Off until the broker of record turns on `COMMISSION_TRUST_ACCOUNT`** (the legal basis is unverified). Its ledger is its receipts, returned receipts, payments and returned payments, and it is reconciled monthly like the real estate trust account. |
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
- **Cross-checks:** each monthly statement is compared with every interim file for the same dates, in whichever order they arrive. An interim line that isn't on the monthly statement, or an interim balance the statement doesn't bear out, is flagged on the file and alerts the brokers. The verifier must say how each difference was checked with the bank before the file counts as evidence.
- **Every import records** where the file came from (portal download, bank email, paper statement, other with a note), who imported it, and its hash. The same file can't be imported twice.

## What blocks money

- **Trust release, refund or closing distribution:** only against deposits matched to verified bank evidence.
- **Agent, co-op or referral payout:** approval needs all of the following, checked by the database:
  - the commission received in full, not reversed, and matched to verified bank evidence
  - an approver who didn't record or match the commission
  - a verified balance for the paying account no more than 3 days old, covering this payout plus everything already approved or paid from that account since the balance was taken
- **Co-op brokerage and referral payables:** disabled until the `THIRD_PARTY_PAYABLES` policy is signed off by counsel and the accountant.

## Each month

1. **Import the monthly trust statement** with the date it was received. s.13 allows 30 days from that date; RECO expects the broker of record to sign within 30 days after month end. **We hold to the earlier date** (`dueBy`; the statutory date is shown as `statutoryDueBy`). The dashboard shows a month with no statement as missing.
2. **A second person verifies it** against the bank (`POST /api/bank/statements/:id/verify`).
3. **Check the matches.** When two entries could fit, nothing is guessed; match those by hand.
4. **Prepare the reconciliation.** It shows:
   - the bank balance, adjusted for deposits in transit and uncashed cheques
   - the ledger balance
   - the amount owed, deal by deal, and **to whom**: the person who deposited it, net of refunds. A deal holding money from several depositors is split pro rata and flagged `PRO_RATA_REVIEW`; a commission trust deal shows "Payees under the CDA"
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

**Bank service fees (RECO Bulletin 8.2).** No registrar notice is needed if the shortfall is caused **solely** by financial institution service fees **and** eliminated as soon as it is discovered. The system never assumes this:

- The broker of record records the cause (`CAUSE_DETERMINED`, `BANK_SERVICE_FEE`), naming each fee line on the bank statement. A line already matched to a ledger entry, or a deposit, is refused.
- The fee lines must account for the whole shortfall. Any other cause recorded (`OTHER`) ends the exception.
- The replenishment must be recorded by the day after the incident was found. After that the exception lapses and RECO must be notified.
- Until the cause is recorded, the incident says to notify RECO. Whether NSF, overdraft or similar charges count as "service fees" is unverified; treat them as reportable until counsel says otherwise.

Discrepancies that aren't shortfalls get their own incident, so nothing is lost.

## Corrections

- **Commission receipt reversed** (wire recalled): blocks any further approval. A payout already paid is flagged for recovery.
- **Agent payment returned:** recorded, then paid again under the same approval, or the approval is cancelled.
- **Wrong signed reconciliation:** never edited. Prepare a new one that names the signed one it supersedes and why; once the correction is signed, the original shows `SUPERSEDED` and both stay on record.
- **Wrong CDA:** void it with a reason, correct the deal, and finalize again. The voided CDA, its approvals and its payments stay on record. Payments already made carry forward. If the correction changes what trust paid out, reverse those distributions first.

## Business days

Deposit deadlines (5 business days, O. Reg. 567/05 s.17) skip Saturdays, Sundays and the Legislation Act s.87 holidays, with the s.88 weekend rules. The holidays are generated each year (`GET /api/business-calendar?year=`). Two settings:

- **Civic Holiday:** counted as a business day (earlier deadline) unless the broker of record turns on `CIVIC_HOLIDAY_IS_HOLIDAY` after counsel confirms s.87 lists it.
- **Proclaimed holidays:** added by the broker of record with the proclamation reference (`POST /api/business-calendar/proclaimed`). Never guessed.

## Unclaimed trust money (TRESA s.27(4), RECO Bulletin 8.1)

- **Candidates:** collapsed or cancelled deals, and deals closed more than 90 days ago, that still hold trust money (`GET /api/trust/unclaimed/candidates`). A person decides what to register.
- **Register** (`POST /api/trust/unclaimed`): the amount comes from the ledger; the two-year clock runs from the later of when the money was received and when the person became entitled.
- **Efforts to locate:** each attempt is recorded with method and outcome. The record asks for another attempt if none in 3 months, and escalates at 18, 21 and 23 months.
- **At two years:** the remittance package lists what Bulletin 8.1 asks for and what's on file. The payment is made outside the system. Recording it (`REMITTED_TO_RECO`) needs the broker of record, the exact principal plus interest, and the `UNCLAIMED_MONEY_REMITTANCE` policy, which is off. Under $25, remitting is optional.

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
- the treatment of bank fees in trust, and whether NSF or overdraft charges are "service fees"
- the Civic Holiday, once counsel confirms the s.87 list
- RECO's current unclaimed-money remittance process
