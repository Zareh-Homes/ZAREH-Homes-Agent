# Commission engine: plans, adjustments, recoveries and tax

## Deal types

- **Listing, buyer and double-ended (`DUAL`)** deals go through the same calculation. On listing and dual deals the deposit we hold is applied to the commission. On buyer deals the listing brokerage pays us.
- **Leases** (`LANDLORD`, `TENANT`) don't produce a CDA yet. The calculator refuses them.

## Commission plans (effective-dated)

- A plan is a **version** that applies from a date:
  - the standard split (for the record; the deal's split is what's paid, and a mismatch is flagged on the CDA preview);
  - the annual cap and the cap year;
  - per-deal fees.
- **Approval:** admin or a managing broker proposes a version with a reason. A **different** managing broker approves it. Nobody approves their own plan.
- **Which version applies:** the closing uses the version in force on the deal's **close date**.
- **No backdating:** a version can't be approved with an effective date on or before a closing already issued for that agent. To change an issued CDA, void and reissue it.
- **History:** versions are never edited. The old one-row-per-agent plan was carried over as the version in force from the start, and those tables are now frozen.

API:

- `GET /api/agents/:userId/commission-plans` and `POST /api/agents/:userId/commission-plans`
- `POST /api/commission-plans/:id/approve`

## Bonuses and deductions (per deal)

| Kind | Effect on the agent's payout | HST |
|---|---|---|
| `BONUS` | Added | If `taxable` and the agent is HST-registered |
| `DEDUCTION` (marketing recovery, advance, etc.) | Subtracted | If `taxable`, charged like a fee |
| `RECOVERY` | Subtracted, against a recorded agent recovery | None |

- **Approval:** added by admin or a managing broker. Approved by a managing broker who didn't add it, and never by the agent.
- **CDA:** only approved, unwithdrawn adjustments appear on the CDA and the agent's statement.
- **Lock:** once the CDA is issued they're locked. Void and reissue to change them.
- **Not affected:** adjustments don't change the house share or cap tracking.

API:

- `GET /api/deals/:dealId/commission-adjustments` and `POST /api/deals/:dealId/commission-adjustments`
- `POST /api/commission-adjustments/:id/approve` and `POST /api/commission-adjustments/:id/withdraw`

## Recoveries (chargebacks)

When a commission is recalled after the agent was paid (the payout shows `recoveryRequired`), or an agent was overpaid, a managing broker records an **agent recovery** (`POST /api/agent-recoveries`). It is recovered in two ways:

- **From a later deal,** with a `RECOVERY` adjustment. It counts once that CDA is issued, and it can't exceed what's still owed.
- **Directly:** `POST /api/agent-recoveries/:id/repayments` with the bank reference.

Nothing is deducted automatically.

## Partial receipts, recalls and returned payments

- **Partial receipts:** commission can arrive in several receipts. Payouts can't be approved until the full amount is in and verified at the bank. Paying out of a partial receipt isn't supported.
- **Recalled or returned commission receipt:** blocks further approvals. Payouts already sent are flagged for recovery.
- **Returned agent payment:** can be paid again under the same approval, or the approval is cancelled.
- See `accounting-integration.md` for "sent" versus "confirmed".

## Sales tax

- **Which rate:** the property's province on the close date, from `SalesTaxRate` (CRA Memorandum 3-3-6-1: a service in relation to real property is taxed where the property is).
- **Rates loaded:**
  - Ontario 13% HST from 2010-07-01.
  - Every other province and territory from 2025-04-01 only, which is when the research confirms them (Nova Scotia 14%; NB, NL and PE 15%; GST 5% elsewhere).
- **No rate on file means no CDA** (`TAX_RATE_UNKNOWN`). There's no default.
- **Changes:** new rates are added by migration, never edited.
- **Labels:** the CDA shows "GST" or "HST" as the rate requires.

## Needs sign-off

- The accountant: tax point (close date) and the treatment of bonuses and deductions for HST.
- The broker of record: which deductions are taxable, and the policy on deductions bigger than the payout (the agent then owes the difference).
