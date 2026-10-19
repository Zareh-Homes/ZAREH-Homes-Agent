# UAT scenarios A–M

Each scenario below is an automated test that runs on a database built from scratch by `brokerage-db/migrate.sh`, against the real HTTP API with real database triggers. The data is synthetic test data, not brokerage records.

**What this is not:** it isn't user acceptance by Zareh Homes staff. A person still has to run these with the broker of record, the admin and an agent before pilot. That step is on the launch checklist (`docs/launch-checklist.md`).

Run them all with:

```bash
cd backend && DATABASE_URL=... node --test --test-concurrency=1
cd migration && DATABASE_URL=... .venv/bin/python -m pytest
```

Result as of 2026-10-18 (commit `c435d7d` plus docs): backend 168/168 passed; migration 48/48 passed with the database (36 without it, 12 skipped); frontend 34/34; commission engine 6/6.

| # | Scenario | Expected | Actual (automated) | Evidence |
|---|---|---|---|---|
| A | Buyer side; the listing brokerage holds the deposit; commission received, verified, approved, paid | No trust entry on our side; $35,312.50 due from the co-op. The receipt waits for a verified bank file. The person who recorded it can't approve it, and the approver can't mark it paid. The payment is confirmed only when a later bank file shows it. | Passed | `backend/test/uat.int.test.ts` "A + G" |
| B | Listing side; we hold the deposit; a co-operating brokerage is owed | The CDA distributes from trust: co-op $24,860, brokerage $31,075, lawyer $4,065. Deal trust ends at $0.00 and the CDA is frozen. Finalizing twice is refused; a retry with the same key replays. | Passed | `closing.int.test.ts` "finalize: posts the trust distributions…" |
| C | Lawyer forwards funds that include money owed to another brokerage | The co-op portion is held as a payable marked AWAITING_POLICY_APPROVAL. Approval is refused (POLICY_NOT_APPROVED), and the database refuses it too (ZP001). It goes through only after the THIRD_PARTY_PAYABLES policy is enabled. | Passed. **Stays disabled in production** until counsel and the accountant sign off. | `money-controls.int.test.ts` "co-op and referral payables stay disabled…" |
| D | Agent paid through a PREC, with HST and fees | Net payout $24,634 = ($22,000 + $2,860 HST) − ($200 + $26 HST). It is paid to the PREC by legal name. | Passed | `closing-calculate.test.ts` "1–3…", `closing.int.test.ts` "finalize…", `dashboard.int.test.ts` "PREC HST" |
| E | Commission partly received, then a wire recalled | Agent paid only after receipt and broker approval. After the recall, the receipt is reversed (received drops to $10,000) and the paid payout is flagged `recoveryRequired`. A recovery is tracked against the agent. | Passed | `closing.int.test.ts` "deposit short of the commission…", "bonuses, deductions and recoveries…" |
| F | Failed conditional deal; deposit released with authorization | The failed condition collapses the deal. The refund is refused under closing authority and refused without the release cited. With the signed mutual release cited, it is paid and deal trust ends at $0.00. | Passed | `uat.int.test.ts` "F" |
| G | Returned agent payment, correction, replacement | The return is recorded and the payout is back to unpaid. A replacement payment is confirmed only by a bank file someone else verified. | Passed | `uat.int.test.ts` "A + G" |
| H | Monthly reconciliation with an unexplained shortfall | The shortfall raises a broker alert and an incident at preparation. The month can be signed on time only with an explanation, and shows "signed with discrepancy". The incident stays open with the RECO notice outstanding. The service-fee exception doesn't apply. | Passed | `bank.int.test.ts` "November: a returned wire is a shortfall…", `trust-completeness.int.test.ts` "an unresolved shortfall doesn't hold up the monthly sign-off…", "service-fee exception doesn't apply…" |
| I | Corrected CDA | The old CDA is voided with a reason and the new one reissued. Earlier approvals and payments are kept and carried forward. A change to trust amounts must reverse those distributions first. | Passed | `closing.int.test.ts` "void and reissue…" |
| J | FINTRAC review with missing or rejected evidence | The reviewer marks the record Needs Revision with a comment, and the agent is notified. Re-upload, then Approved locks it. No CDA until FINTRAC is approved. A name mismatch gives a warning. | Passed | `compliance.int.test.ts` "full lifecycle…", "FINTRAC upload warns…", `closing.int.test.ts` "no CDA until the deal is FINTRAC approved" |
| K | Broker of record reviews a completed TRS | The TRS is generated from the deal and corrected with initials. The agent signs once the deal is firm, then the BoR signs. An agent can't sign as BoR. Open TRESA/FINTRAC findings block the BoR signature. | Passed | `deal-lifecycle.int.test.ts` "trade record sheet…", `obligations.int.test.ts` |
| M | Landlord-side lease | First and last month's rent ($6,000) is held in trust. The commission plus co-op ($5,085 incl. HST) is paid from it, and $915 goes to the landlord. No FINTRAC slots; the lease forms are on the checklist. An agent can't change commission figures. The CDA is addressed to the landlord. | Passed | `uat.int.test.ts` "M", `closing-calculate.test.ts` lease tests |
| L | Lone Wolf migration and reconciliation | A dry run writes nothing. Bad rows are rejected with reasons, and trust is all-or-nothing per deal. A re-run is idempotent. An interrupted run leaves nothing half-written. The written rows are read back and compared (exit 4 on a mismatch). | Passed **on fixture exports**. Not yet run on real Lone Wolf exports. | `migration/tests/test_end_to_end.py`, `test_interrupted.py`, `test_parsing.py` |

## Still needs a person

- Running A–L with staff, using the brokerage's real forms and a real (redacted) month of bank statements.
- Scenario L on the actual Lone Wolf exports, then a parallel month in which both systems reconcile to the same bank balance.
