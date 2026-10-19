# Controlled pilot: scope

What the back office may be used for during the pilot, what it refuses, and what stays in Lone Wolf.
Lone Wolf remains the system of record throughout.

## Two stages

| Stage | Data | Where | Who |
|---|---|---|---|
| **A. Staging trial** | **Synthetic only**: made-up names, addresses, ID numbers and amounts | Staging host | Broker of record, admin, compliance, 1–2 agents |
| **B. Controlled pilot** | Real deals, entered **in parallel** with Lone Wolf | Production host | Same people |

Stage B needs everything in "Before real data" below. Until then, no real client name, ID document, bank detail or
transaction goes into any environment.

## Eligible in the pilot (stage B)

Resale **sales** in Ontario where:

- our side is **listing, buyer or dual**;
- the deposit is held by **our brokerage in the real estate trust account**, **the other brokerage**, or **a lawyer**;
- the commission is paid **in full** to our **operating account** (it may arrive in more than one payment; agent payouts wait until all of it is in);
- each agent has an **approved commission plan**;
- co-operating brokerage commission, if any, is paid **out of our trust at closing** (on the CDA), not out of our operating account.

## Refused or out of scope (the system says so)

| Situation | What happens | Why |
|---|---|---|
| **Lease settlement** (landlord / tenant deals) | The deal, documents, offers, trade record and deposit receipt work. The CDA and any payment out of trust are **refused** (`LEASE_SETTLEMENT` off). A refund to the payer with a mutual release stays possible. The deal shows "Outside the pilot". | Counsel hasn't confirmed: (1) taking commission from first and last month's rent and the landlord's written direction for it; (2) protecting the tenant's entitlement to that money if the lease fails, and passing the last month's rent deposit to the landlord intact (RTA s.106); (3) using the commission in the signed agreement. |
| **Partial payout** (paying an agent part of their commission) | Not possible. With part of the commission received, payouts show "Waiting for the full commission"; approval is refused with that reason. | Not built. |
| **Partial commission receipt** | Allowed and recorded; payouts wait until the full amount is received. Over-receipt and the same reference twice are refused. | — |
| **Co-op / referral payables from our operating account** | Refused (`THIRD_PARTY_PAYABLES` off); the payable shows "Awaiting policy approval". Deals with an outside referral show "Outside the pilot". | Counsel + accountant to confirm which account holds that money. |
| **Commission trust account** | Refused (`COMMISSION_TRUST_ACCOUNT` off). | No legal basis confirmed. |
| **Pre-construction (builder-held deposit)** | Recorded only; the deal shows "Outside the pilot". | Builder/trustee deposits and staged commissions aren't modelled. |
| **Unclaimed money remitted to RECO** | Refused (`UNCLAIMED_MONEY_REMITTANCE` off). | RECO's current process to be confirmed. |
| **Payout approval with no attested obligations figure** | Refused ("Payouts blocked" on Bank → Available funds). | Needs the accountant's manual procedure (`MANUAL_OBLIGATIONS_PROCEDURE`) or a connected accounting system (not connected in this release). |

**Never, in any stage:** bank transfers, accounting postings, regulator submissions (RECO, FINTRAC, OPC), or importing
live Lone Wolf records without separate written authorization. The system has no code that moves money or files
with a regulator; recording a payment records what someone did in the bank portal.

## Before real data (stage B)

1. Production host with TLS, managed PostgreSQL 16 with point-in-time recovery, secret store, log and uptime alerts.
   The CI "staging" job rehearses this setup on every push; it doesn't replace checking the real host.
2. Legal brokerage entity, broker of record, bank accounts and RECO registration confirmed to match each other and the
   CDA settings (`BROKERAGE_*`).
3. Independent penetration test of the staging host, findings fixed.
4. Privacy: retention schedule and breach procedure confirmed (counsel); staff told what may be entered.
5. FINTRAC compliance officer appointed and recorded; policies match the rules engine.
6. Accountant's manual obligations procedure signed (or an accounting connection), so payouts can be approved.
7. Commission plans entered and approved by a second broker.
8. Staff trained; the manual fallback (`business-continuity.md`) printed.
9. Your written go-ahead for stage B.
