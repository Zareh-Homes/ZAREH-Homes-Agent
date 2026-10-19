# Demo walkthrough: a fictional brokerage, start to finish

About 45 minutes. Everything is fictional: people, addresses, amounts and bank files. Nothing connects to a bank,
an accounting system or a regulator. Pictures are in `docs/screens/demo/`.

## Start it

1. Install **Docker Desktop** and open it (see `local-trial.md` for the one-time setup).
2. In the code folder, in Terminal: `ops/local-trial.sh demo`
   The first time takes about 10 minutes: it builds the app, then fills a demo brokerage through the real screens
   (every rule, approval and two-person check applies), the same way staff would.
3. It ends by printing **one sign-in link per demo person**:

| Person | Role | Use them for |
|---|---|---|
| Blake Broker | Broker of record (managing broker) | You, in steps 1–9 |
| Avery Admin | Admin | The second person: imports bank files, records payments |
| Casey Compliance | Compliance | Optional: document review |
| Morgan Agent | Agent | Step 10 (has a closed sale with a paid commission) |
| Jamie Rivera | Agent | New agent with two open deals |

Each link works once, for 72 hours. Open it, choose a password, and (staff roles) scan the QR code with your phone's
authenticator app; save the recovery codes. **Use a separate browser window per person** (Chrome profiles, or one
normal and one private window), because the system won't let the same person approve their own work.

Lost a link or want to start over: `ops/local-trial.sh demo` again (it erases the demo and makes new links).

## What's already in it

- **12 Lakeshore Rd, Oakville**: Morgan's listing, $899,000, $50,000 deposit in our trust account, listing agreement approved, trade record prepared.
- **210 Navy St, Oakville**: Morgan's buyer sale, $750,000, closed. CDA issued (once voided and reissued), commission received in two wires, Morgan paid $13,125 (one payment came back and was replaced).
- **41 Ridge Rd, Stoney Creek**: Morgan's lease, $6,000 deposit in trust. CDA and payments out of trust refused: lease settlement stays off until counsel signs off.
- **1204 – 88 Charlton Ave W, Hamilton**: Jamie's condo listing, $529,000, conditional, $25,000 deposit expected; listing agreement waiting for review.
- **15 Ontario St, Grimsby**: Jamie's buyer deal, $1,045,000, conditional, deposit held by the other brokerage.
- **1 Escarpment Cres, Hamilton**: both sides ours, $1,000,000, closed. Morgan for the seller (separate designated representative), Jamie for the buyer. $20,000 commission on each side; CDA issued with a separate statement for each agent (Morgan $14,000, Jamie $15,000).
- **9 Ridge Rd, Grimsby**: Morgan for both seller and buyer under brokerage representation, $1,000,000. Each client's written consent recorded by compliance, so it's firm.
- Trust and operating accounts, a verified bank file, a signed trust reconciliation, Morgan's 70% and Jamie's 75% plans in force.

## The 10 steps

**1. Sign in as broker of record.** Open http://localhost:8080 → your email (`broker@e2e.test`) and password →
authenticator code. *(tour-01a, tour-01b)*

**2. Brokerage dashboard.** Company dollar, closed volume, HST, money held in trust, reconciliation status and FINTRAC
exceptions, all calculated on the server. *(tour-02)*

**3. Create a transaction.** Deals → **New deal**. Try submitting it empty first: each missing field says what's
needed. Then e.g. a buyer deal in Mississauga, deposit held by "Our brokerage (in trust)", agent Jamie Rivera, a buyer
with "Our client". **Open the deal.** *(tour-03a, tour-03b)*

**4. Upload and review documents.** On your new deal → Documents → upload any PDF into a slot. Then
**Compliance review**: Hamilton's listing agreement is waiting. **View file**, then **Approve**, or write a comment and
**Send back** (the agent sees why). *(tour-04a, tour-04b)*

**5. Record and verify a deposit.** Hamilton deal → **Trust** → **Record a deposit received**: $25,000, payor
"Dana Whitfield", a made-up draft number. It shows as *recorded, not yet matched to the bank*. To verify it: as
**Avery Admin**, Bank & reconciliation → import a one-line CSV with that deposit; back as **Blake**, verify the file
(the importer can't verify their own). *(tour-05a, tour-05b)*

**6. Trade Record Sheet.** 210 Navy St → **Trade record**. It lists what's missing before anyone can sign and what
changed on the deal since it was prepared. **Correct** an item (your initials are added), then **Printable copy**.
*(tour-06)*

**7. CDA.** 210 Navy St → **Closing & CDA**: the issued CDA (R1, after a void), commission and HST, agent payout,
lawyer and internal copies. To issue one yourself: take your step-3 deal through firm and closed, then **Finalize the
CDA**; the screen lists anything still missing first (e.g. the agent's approved plan, the buyer's FINTRAC ID). *(tour-07)*

**8. Approve and record an agent payment.** **Approvals & payouts**: commission plans, payouts and bank files waiting for you. Payouts are
approved here or on the deal's closing tab, then the payment is sent **in the bank portal** and recorded with the
bank's reference by someone other than the approver (Avery). Bank → **Available funds** shows what the system checks
before any approval. *(tour-08a, tour-08b)*

**9. Trust reconciliation and reports.** Bank & reconciliation → **Reconciliations** (signed month), **Trust**
(accounts and ledger), **Oversight** (broker of record and accounting views: what needs attention, with the
definition behind each figure). *(tour-09a–d)*

**10. Switch to an agent.** In a different window, sign in as **Morgan Agent**. Morgan sees only Morgan's deals, their
own payouts and compliance items, and no CDA, bank or approvals screens. *(tour-10a–c)*

**Extra: a deal where both sides are ours.** 1 Escarpment Cres → **TRESA & FINTRAC** says *separate designated
representatives: not multiple representation*. **Closing & CDA** → Internal copy: one commission statement per agent,
each paid from their own side. Then 9 Ridge Rd: one agent for both clients is multiple representation, and the deal
couldn't go firm until compliance recorded each client's written consent. *(docs/screens/same-brokerage/)*

## What to note as you go

- Anything you had to guess, or a message that didn't tell you what to do next.
- Faster or slower than Lone Wolf for the same step.
- Anything missing that you'd need to run a real month.

Known limits of the demo: no https (the hosted staging adds it), only this computer can open it, documents download
rather than preview (on the backlog).
