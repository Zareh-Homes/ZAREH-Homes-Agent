# Browser tests

The built web app in Chromium, against the real API in session mode (cookies, CSRF, two-factor) and a freshly migrated PostgreSQL database. CI runs them on every push (`e2e` job) and keeps the report and screenshots for 30 days.

```sh
cd e2e && npm ci && npx playwright install chromium
E2E_ADMIN_URL=postgresql://postgres:…@localhost:5432/postgres npm test
```

`prepare.sh` drops and recreates the database named by `E2E_DATABASE` (default `zareh_e2e`; it must contain "e2e"), applies every migration, builds the web app and creates the first admin's invitation. The files run in order as one journey: the admin set up in `01` invites the people the later files sign in as. Screenshots land in `report/screens/`.

Everything is synthetic: a throwaway database, test-only brokerage details, no bank, accounting or regulator connection.
