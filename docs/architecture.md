# Architecture

## Pieces

| Part | Stack | Role |
|---|---|---|
| `backend/` | Node 22, Fastify 5, Prisma 6 client | HTTP API: auth, deals, documents, trust, bank, closing/CDA, payouts, commission, obligations, RECO filing, dashboards |
| `brokerage-db/` | PostgreSQL 16 | Schema, migrations 001–017, and the rules that matter (triggers, CHECKs, append-only history) |
| `frontend/` | React 18, Tailwind, Vite | Dashboard, pipeline board, oversight panels (most workflows are API-only for now) |
| `commission-engine/` | TypeScript | Stateless split/cap calculator, used by the closing calculator |
| `migration/` | Python 3.13 | One-time Lone Wolf import with dry run, rejection files and read-back verification |
| `ops/` | bash, SQL, nginx | Encrypted backup, restore test, app login role, reverse proxy, env examples |

## The database enforces the money rules, not only the API

Every rule that protects trust money or a regulatory record is enforced in PostgreSQL. A bug in the API, or someone with a SQL prompt using the app's role, still can't break them:

- **Append-only history.** Ledger entries, reconciliations, payout events, CDAs, audit log, FINTRAC/TRESA records and RECO filing rows reject UPDATE/DELETE/TRUNCATE (`reject_append_only_change()`, SQLSTATE ZD003). A correction is always a new row that points at what it corrects.
- **Restricted role.** The app connects as `zareh_app_login` (member of `zareh_app`). It has SELECT/INSERT only where needed. It can't disable triggers or own tables, and it refuses to start as a superuser.
- **Who may act.** `require_broker_of_record`, `require_bank_staff`, `require_separate_people`, `require_deal_staff`, `require_compliance_staff` run inside triggers. The actor id comes from the authenticated session, never from the client.
- **Policy gates.** Features that need a professional decision check `policy_enabled(...)` in the database (ZP001). All are off by default.
- **Money.** `DECIMAL` everywhere, integer cents in calculations, no floats. Trust can't go negative per deal per account. Payouts are refused when available funds (cleared balance − committed − attested obligations) are short.

Error codes: ZB001 bank rule (422), ZD001 illegal status change (409), ZD002 forbidden (403), ZD003 append-only (405), ZP001 policy not approved (409), 23514 constraint (422).

## Request path

`nginx (TLS, HSTS)` → `Fastify` → session cookie + CSRF check → role check → service → Prisma → PostgreSQL triggers. Sensitive reads are audited in `onSend`. Logs are JSON with ids only; no ID numbers or banking details.

## Data model (by area)

- **People and access:** User, Session, MfaFactor, RecoveryCode, Invitation, AuditLog, BrokerOfRecordDesignation, privacy and retention tables.
- **Deals:** Transaction, TransactionAgent, TransactionParty, DealCondition(+Event), DealAmendment, DealTermination, Offer(+Event), TradeRecordSheet, TradeRecordCorrection.
- **Documents and compliance:** ComplianceSlot, DocumentFile (encrypted at rest), review events, TresaDisclosure, SellerOfferDirection, RepresentationAgreement, FintracDetermination, ReceiptOfFundsRecord, FintracReport(+Event), ComplianceProgramRecord.
- **Trust and bank:** TrustAccount, TrustLedgerEntry, BankStatement, BankLine, matches, Reconciliation (with supersede chain), TrustIncident, ProclaimedHoliday, UnclaimedMoney register and events.
- **Closing and pay:** CommissionPlan + CommissionPlanVersion, CommissionAdjustment, AgentRecovery(+Repayment), SalesTaxRate, ClosingStatement (CDA), ClosingAgentPayout, payables, CommissionReceipt, ReceiptReversal, PayoutEvent, FundsObligationSnapshot/Attestation, OperatingAccount.
- **Governance and filing:** FinancialPolicyDecision, RecoFilingYear/Input/AttestationReview/Submission.

`brokerage-db/schema.prisma` is the typed view of all of it; CI fails if it drifts from the migrated database.

## What is deliberately not connected

- No bank API. Bank data comes in as statement files someone uploads and someone else verifies.
- No payment initiation. "Paid" records a payment a person made in the bank's own portal.
- No accounting writes. The QBO/Xero adapters are read-only; `postJournal` always refuses. Journals are exported as CSV.
- No regulator submissions. RECO, FINTRAC and OPC items are prepared and recorded; people file them in the regulator's own portal.
