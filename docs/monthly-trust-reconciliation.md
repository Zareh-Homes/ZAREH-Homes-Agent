# Monthly trust reconciliation

How the deals department and the broker of record close each month on the trust account (O. Reg. 579/05 s.13).

## The rule the system enforces

**Money only leaves trust once the bank shows it arrived.** A deposit entered in the ledger is not proof of money. Until the deposit is matched to a line on an imported bank statement:

- no trust release, refund or closing distribution can be paid against it
- the pipeline shows **Received – not yet cleared** instead of **Deposit Received & Cleared**

The same goes for commission. An agent payout can only be approved once the commission receipt is matched to the operating (general) account statement.

## Each month

1. **Download the statement CSV** from the bank for the exact statement period (for example Oct 1 to Oct 31).
2. **Import it** (`POST /api/bank/statements`) with the period and the opening and closing balances printed on the statement.
   - Statements must be consecutive. Each opening balance must equal the previous closing balance, and the lines must add up. Otherwise the import is refused, and the error says why.
   - Dates are read as MM/DD/YYYY unless you say otherwise (`dateOrder`).
3. **Check the matches.** Most lines match automatically: same amount, close date, and the bank reference if there is one. When two entries could fit, nothing is guessed. Match those by hand (`POST /api/bank/matches`).
   - Any money leaving trust that the ledger doesn't explain alerts every managing broker on import.
4. **Prepare the reconciliation** (`POST /api/trust/reconciliations`). Admin or broker can do this. It records:
   - the bank balance, adjusted for deposits in transit and cheques not yet cashed
   - the trust ledger balance
   - the total owed, deal by deal
   - every outstanding item, every bank item missing from the ledger, deposits still not at the bank after 5 business days, and any overdrawn deal
5. **Deal with exceptions.** A fee or returned deposit at the bank is a **shortfall**, never netted away. Record it in the ledger (for example, reverse a returned deposit on the date the bank took it), make the account whole, then prepare again. If something can't be resolved, prepare again with an explanation.
6. **Broker of record signs** (`POST /api/trust/reconciliations/:id/sign`). Only a managing broker can sign:
   - Months are signed in order.
   - Only the latest version for a statement can be signed.
   - Anything with exceptions needs an explanation first.
   - Once signed, the reconciliation can't be changed, even directly in the database.

**Deadline:** within 30 days of the statement date. The broker dashboard shows months awaiting signature and flags overdue ones.

## Cutover from Lone Wolf

History from before the first imported statement can't be matched to statement lines that don't exist. The Lone Wolf migration records the managing broker's **pre-cutover attestation** for each migrated entry instead. Once a statement is imported for an account, nothing dated inside that period can be attested; it has to be matched.

- Import the first statement right after cutover.
- The first reconciliation is the real check: the bank balance must tie to the migrated ledger.

## Still to come

The **RECO annual financial filing** will be built from these signed monthly reconciliations (trust liabilities at year end, unclaimed funds, broker attestation).

Have your accountant review this process before it goes live.
