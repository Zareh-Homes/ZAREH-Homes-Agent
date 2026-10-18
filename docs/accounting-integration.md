# Available funds, obligations and the accounting system

## What "available" means

A payout can be approved from an account only if this is at least the payout:

| | |
|---|---|
| **Verified bank balance** | The latest bank file for the account that a second person has verified, no more than 3 days old |
| − payments sent but not yet through the bank | Recorded as paid, not yet matched to a bank line dated on or before the balance date (uncashed cheques, EFTs in flight) |
| − payments approved but not sent | |
| − payments returned and still owed | |
| − other obligations (operating account only) | Payroll, HST, rent, bills: anything this system doesn't pay. From an **attested obligations figure no more than 7 days old** |

The database applies this formula when the payout is approved (migration 013). `GET /api/funds/availability?accountType=OPERATING&accountId=…` shows the same workings, and why approval is blocked if it is.

**Fails closed:** with no current attested obligations figure, nothing can be approved from the operating account.

## Where the obligations figure comes from

1. **The accounting system (preferred).** `POST /api/funds/obligations/pull` reads unpaid bills from QuickBooks Online or Xero, read-only, and records the total and every line with where it came from.
2. **The manual procedure.** Only if the broker of record turns on `MANUAL_OBLIGATIONS_PROCEDURE` once the accountant approves a written procedure. `POST /api/funds/obligations` lists every obligation with its source document. An empty list means "none", and is attested as such.

Either way, **a second person attests the figure** (`POST /api/funds/obligations/:id/attest`) before it counts. Nobody attests their own.

## Sent versus confirmed

- **Approved:** a managing broker, with the available-funds check.
- **Sent** (`PAID`): someone other than the approver records the payment and its reference. Nothing in this system sends money.
- **Confirmed:** the payment is matched to a line on a bank file verified by someone other than whoever recorded the payment. Payout views show `paymentConfirmed`. Matching is automatic when there's exactly one sensible candidate.

## Journal export

`GET /api/accounting/journal?from=&to=` (add `&format=csv` for the file) turns every money movement into a balanced, cash-basis entry:

| Movement | Debit | Credit |
|---|---|---|
| Commission received | Bank (operating or commission trust) | Commission clearing |
| Commission returned | Commission clearing | Bank |
| Trust to general | Bank (operating) | Commission clearing |
| Payout sent | Agent / co-op / referral payable | Bank |
| Payout returned | Bank | The same payable |

Revenue, HST and agent expense classification are the accountant's: the clearing account holds them until they're booked. Accounts are roles. The accountant maps each role to a code with `ACCOUNTING_ACCOUNT_MAP`, for example `{"BANK_OPERATING":"1010","COMMISSION_CLEARING":"2150"}`. Entries with an unmapped role are exported but marked not ready.

**Posting to the live ledger is disabled.** `POST /api/accounting/journal/post` always refuses. The accountant imports the CSV.

## Connecting QuickBooks Online or Xero (not done in this release)

The adapters (`backend/src/accounting/adapter.ts`) are tested against recorded API shapes only. They have never been connected to a live company or organisation. Connecting needs:

1. **An app registration** with Intuit (QuickBooks Online) or Xero:
   - Scope: accounting read only. QuickBooks: `com.intuit.quickbooks.accounting`. Xero: `accounting.transactions.read`.
   - A redirect URL on the brokerage's domain.
2. **The brokerage owner authorizes the app** for its company or organisation. This yields:
   - the realm ID (QuickBooks) or tenant ID (Xero);
   - a refresh token.
3. **Token storage and refresh.** The adapter takes an `accessToken()` function. Something must store the refresh token encrypted, outside the database's application role, and refresh it. This isn't built yet.
4. **Wiring in `server.ts`.** It currently logs that live connections aren't enabled when `ACCOUNTING_PROVIDER` is set.
5. **A first pull reviewed against the accounting system** by the accountant before anyone relies on it.

Client secrets and tokens go into the deployment's secret store. They never go in this repository, and are never sent in chat.
