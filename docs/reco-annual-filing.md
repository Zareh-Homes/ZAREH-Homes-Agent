# RECO annual financial filing

The broker of record files in **RECO MyWeb** (TRESA s.48.1). This system prepares the filing and keeps the evidence. **It never files.**

> **First filing due 2026-10-30.** This covers fiscal years ending 2025-08-01 to 2026-07-31. After that, each year is due 90 days after the fiscal year end.

## Steps

1. **Set up the fiscal year** (admin or broker): `POST /api/reco/filings` with `fiscalYearStart` and `fiscalYearEnd`. The due date follows from these.
2. **Review the package:** `GET /api/reco/filings/:fiscalYearEnd`, or `?format=csv` to check line by line against MyWeb. It shows:
   - **Trust:**
     - liabilities, assets and bank balance per trust account;
     - each figure from the signed reconciliation at the fiscal year end, with its source.
   - **Unclaimed trust money:**
     - split into unclear entitlement and owner can't be located;
     - the amount held more than two years.
   - **Bank accounts:**
     - institution, type (real estate trust, commission trust, general) and opened, maintained or closed;
     - only the last 4 digits are kept here, so the full number and branch are entered in MyWeb.
   - **Closed trades** in the fiscal year. If there are none, the package suggests the Non-trading Report instead.
   - **Attestations:** the evidence behind each one, and any exceptions found, such as months not reconciled on time or shortfalls with no registrar notice.
   - **Missing:** a list of everything still needed.
3. **Enter the financial statement figures** (from the accountant's statements, with the source): `POST …/figures`.
   - Figures: cash, total assets, total liabilities, equity, revenue, gross profit, expenses, net income and trust interest retained. Bank branches go in as `BANK_BRANCH:<account id>`.
   - Nothing here computes these figures. A correction is a new entry.
   - Total assets must equal liabilities plus equity, or the package flags it.
4. **Broker of record review:** the broker of record reviews the evidence for all six attestations (`POST …/attestation-reviews`). "Notice of changes in directors / financial distress" isn't tracked here, so the broker of record confirms it from the brokerage's records.
5. **File in MyWeb.** Then record the filing: `POST …/submission` with RECO's confirmation. This needs all six reviews. Once recorded, the year's figures are frozen.

## Dashboards

The broker of record dashboard (`/oversight/broker`) shows the next filing's due date, the days left and what's still missing. If no fiscal year has been set up, it says so, and is marked critical before 2026-10-30.

## Not in scope

- **Monthly trust reconciliation reporting to RECO** (announced for 2027) isn't built. Its format hasn't been published. The reconciliation records already hold what a monthly submission would need.
