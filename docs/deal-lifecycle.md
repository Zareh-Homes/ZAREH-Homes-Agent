# Deal lifecycle and the trade record sheet

## Status

```
CONDITIONAL ──► FIRM ──► CLOSED
     │            │
     └──► COLLAPSED (terminated) / CANCELLED ◄──┘
```

- The database refuses any other change. A deal can't close without going firm, and closed or terminated deals don't come back.
- **Firm** is refused while any condition is open or extended.

## Conditions

Add each condition from the agreement with its deadline (`POST /api/deals/:id/conditions`). Then record what happened to it (`POST /api/conditions/:id/outcome`):

| Outcome | Evidence |
|---|---|
| `FULFILLED` | Notice of fulfillment |
| `WAIVED` | Waiver |
| `EXTENDED` | Amendment, plus the new deadline |
| `FAILED` | Then terminate the deal |

Each outcome needs its document reference and can link the uploaded file. Overdue open conditions show on the deal.

## Amendments and termination

- **Amendments** (`POST /api/deals/:id/amendments`): price, closing date, deposit amount or due date, or other. Each is recorded with the old and new value and the amendment form, and applied to the deal in the same step.
- **Termination** (`POST /api/deals/:id/terminate`): the reason (condition not met, mutual release, buyer or seller default, other), the date, the document and a note. Trust money still held after a termination is released only under a signed mutual release or a court order; the deal's next steps say so.

## Offers register (listing side)

- **What's recorded:** every written offer, with time received, the buyer's brokerage (or that the buyer is self-represented), the price and the offer document.
- **Outcomes:** signed back, accepted, rejected, expired or withdrawn. Only one offer per listing can be accepted.
- **Retention:** unaccepted offers are kept at least one year from receipt (O. Reg. 579/05 s.19(2)). Accepted offers are part of the trade record (6 years).

## Trade record sheet (O. Reg. 579/05 s.17)

1. **Prepare** (`POST /api/deals/:id/trade-record`): items 1–9 are generated from the deal. Anything the deal doesn't have (for example, the co-operating agent's name and contact details) is listed as missing. Nothing is guessed.
2. **Correct** (`…/trade-record/corrections`): each correction is appended with a reason and the initials of whoever made it. The original entry stays visible (s.17(4)).
3. **Agent signs** (`…/trade-record/sign`): only the deal's agent, only once the deal is firm with no conditions outstanding, and only with nothing missing (s.17(3)).
4. **Broker of record reviews and signs** (`…/trade-record/broker-sign`). The broker of record may correct during review. Then the sheet is frozen (s.17(5)).

If the deal is amended after the sheet was prepared, the sheet shows the difference and is not rewritten.

**Unverified:** whether s.17 lists items beyond item 9. The "further items" slot holds them until the e-Laws text is checked.

## Leases

Leases (`LANDLORD`, `TENANT` sides) go through the same lifecycle, trade record sheet and CDA as sales:

- **Landlord side (our listing).** We usually hold the first and last month's rent in trust. At commencement (the deal's close date), the CDA pays from that deposit:
  1. the co-operating (tenant's) brokerage,
  2. the brokerage's commission,
  3. the balance to the landlord (`DISBURSEMENT_TO_LANDLORD`).
  If the deposit is short, the landlord pays the rest to the brokerage. The deal's "sale price" field holds the rent.
- **Tenant side.** The listing brokerage pays us, as on a buyer-side sale.
- **We represent both landlord and tenant.** Open the deal on the landlord side and mark the tenant as our client. The TRESA rules then require multiple-representation consent, and there's no co-op commission.
- **Paperwork.** The checklist asks for the listing agreement for lease (Form 272, landlord side), the agreement to lease (Form 400) and Form 320 (tenant side). The broker of record confirms these against the brokerage's current forms.
- **FINTRAC.** Its real estate identification, record-keeping and large-cash reporting obligations apply to purchases and sales, so lease deals get no FINTRAC slots and don't open large-cash report tasks. TRESA obligations still apply.

## Not yet supported
