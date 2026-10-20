# Back-office HTTP API reference

Derived only from the code in `backend/src` (Fastify 5 + Prisma) and the database triggers in
`brokerage-db/migrations` that the API surfaces as errors. Where a behaviour is decided by a database
trigger and not by the TypeScript, that is said explicitly ("DB:"). Nothing here is inferred from
other docs.

- Total routes: **139** (see [Route count verification](#route-count-verification)).
- 16 of them (`/api/auth/*`, `/api/users*`) exist **only in session mode**. In development header mode
  (`ALLOW_DEV_AUTH_HEADER=true`) they are not registered, and the remaining 123 routes are served.

---

## Contents

1. [Conventions](#1-conventions)
2. [Authentication, sessions, CSRF, MFA](#2-authentication-sessions-csrf-mfa)
3. [Errors](#3-errors)
4. [Roles](#4-roles)
5. [Server-sent events](#5-server-sent-events-notifications)
6. Routes by area
   - [6.1 Auth & users](#61-auth--users-16)
   - [6.2 Notifications](#62-notifications-3)
   - [6.3 Deals & lifecycle](#63-deals--lifecycle-12)
   - [6.4 Documents & compliance](#64-documents--compliance-5)
   - [6.5 TRESA / FINTRAC obligations](#65-tresa--fintrac-obligations-12)
   - [6.6 Trade record sheet](#66-trade-record-sheet-5)
   - [6.7 Trust ledger](#67-trust-ledger-10)
   - [6.8 Bank statements & matching](#68-bank-statements--matching-8)
   - [6.9 Reconciliation & incidents](#69-reconciliation--incidents-7)
   - [6.10 Unclaimed money](#610-unclaimed-trust-money-6)
   - [6.11 Closing / CDA](#611-closing--cda-4)
   - [6.12 Payouts, payables & commission receipts](#612-payouts-payables--commission-receipts-11)
   - [6.13 Commission plans, adjustments & recoveries](#613-commission-plans-adjustments--recoveries-10)
   - [6.14 Funds & accounting](#614-funds--accounting-6)
   - [6.15 Dashboards, pipeline, oversight](#615-dashboards-pipeline-oversight-3)
   - [6.16 RECO annual filing](#616-reco-annual-filing-5)
   - [6.17 Governance](#617-governance-broker-of-record-financial-policies-business-calendar-7)
   - [6.18 Privacy](#618-privacy-6)
   - [6.19 Ops, health, audit export](#619-ops-health-audit-export-3)
7. [Route count verification](#route-count-verification)
8. [Gaps and ambiguities](#gaps-and-ambiguities)

---

## 1. Conventions

### Request bodies (the `Reader` in `backend/src/lib/reader.ts`)

Every JSON body is validated field by field and **all** problems are reported together
(`VALIDATION_FAILED`, see §3).

- The body must be a JSON **object**, otherwise `body: must be a JSON object`.
- **Unknown fields are rejected** (`<field>: is not a recognised field`). Send only the fields listed.
- "Present" means the key exists and is not `null`. Sending `null` for an optional field is the same as
  leaving it out.
- Error `field` values are full paths, e.g. `agents[0].userId`, `metadata.thirdParty.name`.

Type notation used in the field tables:

| Notation | Meaning |
|---|---|
| `text(n)` | String, trimmed, non-empty, at most `n` characters. `text(n, min m)` also needs at least `m`. |
| `text?(n)` | Optional text. Missing, `null` or whitespace-only → `null`. |
| `uuid` / `uuid?` | Canonical UUID string (`8-4-4-4-12` hex). |
| `amount` | **Decimal string**, regex `^(0\|[1-9][0-9]{0,9})(\.[0-9]{1,2})?$`, must be > 0 and ≤ `9999999999.99`. E.g. `"40000.00"`, `"1250.5"`. Numbers are rejected. |
| `signed amount` | Decimal string that may start with `-` (bank imports only), e.g. `"-50.00"`. |
| `date` | `YYYY-MM-DD`. |
| `past date` | `date` that is not after today (today = calendar date in `America/Toronto`). |
| `timestamp` | String starting `YYYY-MM-DDT…` that `Date.parse` accepts, e.g. `"2026-10-20T23:59:00-04:00"`. Stored and returned as UTC ISO. |
| `percent(a..b)` | JSON **number** with at most 2 decimals, `a ≤ v ≤ b`. Also used for some small integers (noted). |
| `bool` | JSON `true`/`false`. |
| `oneOf(A\|B)` | One of the listed strings. |
| `list<…>` | JSON array. `textList(max k, n)` = non-empty array of `text(n)`, at most `k` items. |

Routes whose body is read with `body ?? {}` accept an absent body; all others need a JSON object
even if every field is optional. Because Fastify rejects `Content-Type: application/json` with an
empty body (400 `BAD_REQUEST`), **always send `{}` when you have nothing to send** on a POST that
takes a body, or omit the content-type on routes that ignore the body.

Default JSON body limit: **64 KiB** (`bodyLimit` in `app.ts`), except `POST /api/bank/statements`
(6 MiB) and the multipart upload (§6.4).

### Response values

- Money in responses is a **decimal string** (`"40000.00"`) unless the field name ends in `Cents`
  (integer cents) or the object is one of the "cents" objects flagged in this document:
  `ClosingComputation` (closing/CDA), `ReconResult` (reconciliation preview and `details`),
  `DashboardResponse`, `PipelineResponse`. Those use **integer cents** (`Cents` type in
  `backend/src/lib/money.ts`).
- Dates are `YYYY-MM-DD`; timestamps are UTC ISO-8601 strings (some with microseconds, e.g.
  `2026-10-19T14:03:22.123456Z`).
- Path ids are validated as UUIDs (`VALIDATION_FAILED` with the param name as `field`) except where noted
  (`/api/reco/filings/:fiscalYearEnd` takes a date, the `PUT/PATCH/DELETE /api/trust/entries/:entryId`
  handlers don't validate).

### Headers

| Header | When |
|---|---|
| `Cookie: zh_session=…` | Session mode, every authenticated request (sent automatically by the browser). |
| `x-csrf-token` | Session mode, every `POST/PUT/PATCH/DELETE` while signed in, except the three pre-session routes (§2.4). |
| `Origin` | If sent and `APP_ORIGINS` is configured, must be in the list (§2.4). |
| `Idempotency-Key: <uuid>` | Required on `POST /api/trust/deposits`, `/api/trust/disbursements`, `/api/trust/entries/:entryId/reversals`, `/api/deals/:dealId/closing/finalize`. |
| `x-user-id: <uuid>` | **Development header mode only**: identifies the caller. Ignored in session mode. |

Every response gets: `x-content-type-options: nosniff`, `x-frame-options: DENY`,
`referrer-policy: no-referrer`, `cross-origin-resource-policy: same-origin`,
`permissions-policy: camera=(), microphone=(), geolocation=()`,
`content-security-policy: default-src 'none'; frame-ancestors 'none'` (unless the route sets its own),
`cache-control: no-store` on `/api/*` (unless the route sets its own), and
`strict-transport-security: max-age=31536000; includeSubDomains` when cookies are Secure.
(The SSE stream is hijacked and does not get these hooks; see §5.)

### Who can call it: notation

Role sets used throughout (resolved from the constants in code):

| Name in this doc | Roles | Constants that resolve to it |
|---|---|---|
| **STAFF** | `ADMIN`, `MANAGING_BROKER`, `COMPLIANCE_ADMIN` | `TRUST_VIEWERS`, `TRUST_HOLD_FLAGGERS` (`auth.ts`); `STAFF` (`compliance/service.ts`, `deals/lifecycle.ts`); `PRIVACY_STAFF` (`security/privacy.ts`); `SEE_ALL` (`pipeline/service.ts`); `BROKERAGE_ROLES` (`dashboard/service.ts`); `PRIVILEGED_ROLES` (`security/config.ts`) |
| **BANK_STAFF** | `ADMIN`, `MANAGING_BROKER` | `BANK_STAFF` (`bank/service.ts`); `PAYMENT_RECORDERS` (`closing/payouts.ts`); `STAFF` (`commission/service.ts`) |
| **BROKER** | `MANAGING_BROKER` | `TRUST_AUTHORIZERS` (`auth.ts`) and literal `["MANAGING_BROKER"]` |
| **REVIEWERS** | `MANAGING_BROKER`, `COMPLIANCE_ADMIN` | `DOCUMENT_REVIEWERS` (`compliance/rules.ts`); `COMPLIANCE` (`obligations/service.ts`) |
| **ANY** | any active signed-in user | no role check |

**Deal access (DEAL)**: STAFF may act on any deal; anyone else (in practice `AGENT`) only on a deal
where they are a `TransactionAgent`, else `403 FORBIDDEN` ("You can only work on your own deals" /
"…documents for your own deals" / "…trust ledger for your own deals"). Implemented as
`assertDealAccess` in `deals/lifecycle.ts` and `compliance/service.ts`, and `assertCanViewDeal` in
`trust/service.ts` (all three use the STAFF set).

**DB-enforced checks** (raised by triggers, returned as `403 FORBIDDEN` with the trigger's message):

- **BoR**: the caller must hold an active `BROKER_OF_RECORD` or `DESIGNATED_SUBSTITUTE` designation on
  today's Toronto date (`require_broker_of_record`). Message starts `BROKER_OF_RECORD_REQUIRED:`.
- **SoD** (segregation of duties): the caller must be a different person from whoever did the paired
  step (`require_separate_people`). Allowed for the same person only if the `SOLE_OPERATOR_EXCEPTION`
  policy is on **and** the request carries a non-empty `exceptionReason`. Message starts
  `SEGREGATION_OF_DUTIES:`.

Every route calls `loadActor`: no session/unknown/inactive user → `401 UNAUTHENTICATED`
("Sign in required"). Role checks then give `403 FORBIDDEN` "`<action>` requires one of: …".

---

## 2. Authentication, sessions, CSRF, MFA

Source: `backend/src/security/http.ts`, `security/auth-service.ts`, `security/config.ts`,
`security/crypto.ts`, `auth.ts`, `server.ts`.

### 2.1 Modes

- **Session mode** (default; the only mode allowed in production): the caller is whoever the
  `zh_session` cookie says. `x-user-id` is ignored.
- **Development header mode** (`ALLOW_DEV_AUTH_HEADER=true`, refused when `NODE_ENV=production`): the
  caller is the UUID in the `x-user-id` header. No cookies, no CSRF, no MFA, and the `/api/auth/*` and
  `/api/users*` routes are not registered.

### 2.2 Session cookie

```
Set-Cookie: zh_session=<random 256-bit base64url token>; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure
```

- Name: `zh_session`. `HttpOnly`, `SameSite=Strict`, `Path=/`.
- `Secure` unless `COOKIE_SECURE=false` (not allowed in production).
- `Max-Age` = `SESSION_ABSOLUTE_HOURS × 3600` (default 12 h = 43200 s). Re-sent with a fresh `Max-Age`
  when the token rotates (MFA), but the server-side absolute expiry does not move.
- The database stores only the token's SHA-256.
- **Idle timeout**: `SESSION_IDLE_MINUTES` (default **30**). `lastSeenAt` is refreshed at most once a
  minute.
- **Absolute timeout**: `SESSION_ABSOLUTE_HOURS` (default **12**) from sign-in.
- An expired, revoked or suspended-user session gets `401` with `SESSION_EXPIRED`
  ("Your session expired. Please sign in again.") or `SESSION_INVALID` ("Please sign in again"), and the
  response clears the cookie (`zh_session=; …; Max-Age=0`). On the three pre-session routes a bad cookie
  is cleared and the request continues.
- Sessions are revoked server-side on: logout, password change (all *other* sessions), invitation /
  reset redemption (all sessions), admin MFA reset (all), suspension (the next request fails because the
  user is inactive), user-initiated revoke.

### 2.3 Sign-in flow

1. `POST /api/auth/login` `{ "email", "password" }` → `200`, sets the cookie, returns
   `{ csrfToken, expiresAt, mfa: { enabled, required } }`.
2. If `mfa.required` is false: done.
3. If `mfa.required` and `mfa.enabled`: `POST /api/auth/mfa/verify` `{ "code": "123456" }` (or
   `{ "recoveryCode": "ABCDE-12345" }`) with `x-csrf-token`. The cookie is replaced (token rotated).
4. If `mfa.required` and not `mfa.enabled` (first sign-in of a privileged user): enrol —
   `POST /api/auth/mfa/enroll` → `{ secret, otpauthUri }`, show a QR of `otpauthUri`; then
   `POST /api/auth/mfa/enroll/confirm` `{ "code" }` → recovery codes; cookie replaced.

Until step 3/4 is done, a privileged user's session can only reach paths starting with
`/api/auth/mfa/`, `/api/auth/me` and `/api/auth/logout`. Anything else returns `401` with
`MFA_REQUIRED` ("Enter your authenticator code to continue") or `MFA_ENROLLMENT_REQUIRED`
("Set up two-factor sign-in to continue").

MFA is required for the roles in `MFA_REQUIRED_ROLES` (default and minimum: `ADMIN`,
`MANAGING_BROKER`, `COMPLIANCE_ADMIN`; `AGENT` may be added by configuration). Users in other roles may
still enrol (no role check on enrol) but are never gated.

TOTP: RFC 6238, SHA-1, 6 digits, 30 s step, accepts the previous/current/next step; a code at or
before the last accepted step is rejected (no replay). Issuer label `MFA_ISSUER`
(default "Zareh Homes Back Office"). Recovery codes: 10, format `XXXXX-XXXXX` (10 upper-case hex
characters with a hyphen), single use, stored hashed; compared after upper-casing, **hyphen included**.

### 2.4 CSRF

- The token is per session and returned as `csrfToken` by `POST /api/auth/login` and by
  `GET /api/auth/me`. It does not change when the session token rotates after MFA.
- Send it as header **`x-csrf-token`** on every `POST`, `PUT`, `PATCH`, `DELETE` made with a session,
  including logout and the MFA steps.
- Exempt (no session yet): `POST /api/auth/login`, `POST /api/auth/invitations/accept`,
  `POST /api/auth/password-resets/complete`.
- Also, if the request has an `Origin` header and `APP_ORIGINS` is set, the origin must be listed.
- Failures: `403 CSRF_TOKEN` ("Missing or invalid CSRF token"), `403 CSRF_ORIGIN`
  ("Request origin not allowed"). The CSRF check runs **before** the MFA gate and before the route.

### 2.5 Lockout and rate limits

- **Account lockout**: 10 consecutive failures lock the account for **15 minutes**
  (`MAX_FAILED_ATTEMPTS`, `LOCKOUT_MINUTES`). Failures counted: wrong password at sign-in, wrong TOTP /
  recovery code (enrol-confirm and verify), wrong current password on change-password. The counter
  resets to 0 on successful sign-in, successful MFA verify/enrol, or a password set from an
  invitation/reset. (The counter is not reset when the lock expires, so the next failure after expiry
  locks again.) While locked: login → `423 ACCOUNT_LOCKED` (checked before the password);
  MFA verify → `423 ACCOUNT_LOCKED`.
- Unknown e-mail, no password set, wrong password and suspended account all return the same
  `401 INVALID_CREDENTIALS` "Email or password is incorrect" (suspended is only detected after a correct
  password and does not count as a failure).
- **Rate limits** (in-process, fixed 60-second windows; only the per-request limit is configurable):
  - every request (including `/healthz`): **600 per minute per IP** (`API_REQUESTS_PER_MINUTE`, 60–100000) → `429 RATE_LIMITED`
    "Too many requests. Slow down and try again shortly."
  - `POST /api/auth/login`: **20 per minute per IP** → `429 RATE_LIMITED`
    "Too many sign-in attempts. Wait a minute and try again."
  - `POST /api/auth/login`: **5 per minute per e-mail** (lower-cased) → `429 RATE_LIMITED`
    "Too many sign-in attempts for this account. Wait a minute."

### 2.6 Accounts: invitation and password reset

There is **no self-service "forgot password" endpoint**. Both links are issued by an admin and must be
delivered out of band (the API returns the raw token once):

- Invitation: `POST /api/users` (ADMIN) → `{ userId, invitationToken, expiresInMinutes: 4320 }` (72 h).
  The user then calls `POST /api/auth/invitations/accept` `{ token, password }`.
- Password reset: `POST /api/users/:id/password-reset` (ADMIN, not for yourself) →
  `{ resetToken, expiresInMinutes: 60 }`. The user calls `POST /api/auth/password-resets/complete`
  `{ token, password }`.
- Issuing a new token of the same purpose invalidates older unused ones.
- Redeeming does **not** sign the user in; it revokes all their sessions. They then sign in normally.
- Password rules (`passwordProblem` in `security/crypto.ts`): 12–256 characters; must not contain the
  e-mail local part if that is 4+ characters; must not be one repeated character or contain
  `password1234`, `123456789012` or `qwertyuiopas`. Failures are `400 VALIDATION_FAILED` on field
  `password` / `newPassword`.

### 2.7 Audit

Every non-auth `/api/*` `POST/PUT/PATCH/DELETE`, and every `GET` matching a sensitive pattern, is
written to the audit log with its outcome before the response is sent. Sensitive GET prefixes
(`security/audit.ts`): `/api/documents/files/`, `/api/bank/`, `/api/trust/`, `/api/deals/:id/trust`,
`/api/deals/:id/closing`, `/api/audit`, `/api/fintrac`, `/api/export(s)/`, any path ending `/export`.
Auth routes write their own events (LOGIN, LOGIN_FAILED, LOGIN_LOCKED, LOGOUT, MFA_ENROLLED, MFA_VERIFIED,
MFA_RECOVERY_CODE_USED, MFA_FAILED, SESSION_REVOKED, PASSWORD_CHANGED, USER_CREATED, INVITATION_ACCEPTED,
PASSWORD_RESET, PASSWORD_RESET_ISSUED, MFA_RESET, USER_SUSPENDED, USER_REACTIVATED).

---

## 3. Errors

### 3.1 Envelope

All errors raised by the application (`DomainError` and subclasses, `backend/src/errors.ts`) are sent by
the error handler in `app.ts` as:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "amount: must be greater than zero; dealId: must be a UUID", "details": { "issues": [ { "field": "amount", "message": "must be greater than zero" }, { "field": "dealId", "message": "must be a UUID" } ] } } }
```

- `details` is omitted when the error has none.
- Errors produced in hooks (rate limit, CSRF, MFA gate, invalid session) have the same `{ error: { code, message } }`
  shape without `details`.
- Fastify's own 4xx errors (malformed JSON, empty JSON body, body too large `413`, unsupported media
  type `415`, multipart file too large `413`) become `{ "error": { "code": "BAD_REQUEST", "message": "<fastify message>" } }`
  **with the original status code**.
- Anything unexpected: `500 { "error": { "code": "INTERNAL", "message": "Something went wrong" } }`.
- **Unknown routes** are not handled by the app's handler (no `setNotFoundHandler`): they get Fastify's
  default `404` body `{ "message": "Route GET:/x not found", "error": "Not Found", "statusCode": 404 }`.

### 3.2 Status mapping (errors.ts)

| Class / source | Status | `code` |
|---|---|---|
| `ValidationError` | 400 | `VALIDATION_FAILED` (`details.issues[]` = `{ field, message }`) |
| `UnauthenticatedError` | 401 | `UNAUTHENTICATED` |
| `AuthError` | 401 by default; some 400/422/423 (listed per route) | various (`INVALID_CREDENTIALS`, `SESSION_EXPIRED`, …) |
| `ForbiddenError` | 403 | `FORBIDDEN` |
| `NotFoundError` | 404 | `NOT_FOUND` (`details.id`) |
| `ConflictError` | 409 | per use (e.g. `ALREADY_REVERSED`, `IDEMPOTENCY_KEY_REUSED`) |
| `InsufficientTrustFundsError` | 409 | `INSUFFICIENT_TRUST_FUNDS` (`details`: `dealId`, `available`, `requested`) |
| `RuleViolationError` | 422 | per use (e.g. `DEAL_NOT_CLOSED`, `RECONCILIATION_NEEDS_EXPLANATION`) |
| `ClosingAuditError` (`closing/calculate.ts`) | 422 | per use (e.g. `FINTRAC_NOT_APPROVED`) |
| `TrustHoldActiveError` | 423 | `TRUST_HOLD_ACTIVE` (`details`: `dealId`, `holdId`, `reason`) |
| `DomainError(…, 405)` | 405 | `TRUST_LEDGER_IMMUTABLE` |
| `DomainError(…, 502/503)` | 502/503 | `ACCOUNTING_UNAVAILABLE`, `ACCOUNTING_NOT_CONNECTED` |

### 3.3 Database trigger errors (`fromDatabaseError`)

Most routes rethrow database trigger errors through this table; the `message` is the trigger's text
(it usually starts with a tag such as `BANK_RULE:`, `ILLEGAL_STATUS_CHANGE:`, `DEAL_UNAUTHORIZED:`,
`BROKER_OF_RECORD_REQUIRED:`, `SEGREGATION_OF_DUTIES:`, `POLICY_NOT_APPROVED:`, `FUNDS_NOT_AVAILABLE:`).

| SQLSTATE | Status | `code` | Typical cause |
|---|---|---|---|
| ZT001 | 409 | `INSUFFICIENT_TRUST_FUNDS` | trust balance would go negative |
| ZT002 | 423 | `TRUST_HOLD_ACTIVE` | disbursing while a hold is active |
| ZT003 | 403 | `FORBIDDEN` | trust action by someone without broker authority |
| ZT004 | 422 | `INVALID_REVERSAL` | reversal rule |
| ZT005 | 405 | `TRUST_LEDGER_IMMUTABLE` | update/delete of a ledger row |
| ZT006 | 422 | `TRUST_HOLD_RULE` | hold rule |
| ZT007 | 409 | `FUNDS_NOT_CLEARED` | money out against deposits/commission not matched to a verified bank line |
| ZT008 | 409 | `FUNDS_NOT_AVAILABLE` | payout approval without enough verified available funds |
| ZD001 | 409 | `ILLEGAL_STATUS_CHANGE` | deal/condition/offer/document state order |
| ZD002 | 403 | `FORBIDDEN` | `DEAL_UNAUTHORIZED`, `BROKER_OF_RECORD_REQUIRED`, `SEGREGATION_OF_DUTIES`, bank-staff checks |
| ZD003 | 405 | `APPEND_ONLY` | changing an append-only record |
| ZD004 | 422 | `PAYOUT_RULE` | payout rule |
| ZB001 | 422 | `BANK_RULE` | generic business rule (used widely: ~100 checks) |
| ZP001 | 409 | `POLICY_NOT_APPROVED` | a financial policy switch is off (`THIRD_PARTY_PAYABLES`, `COMMISSION_TRUST_ACCOUNT`, `UNCLAIMED_MONEY_REMITTANCE`, `MANUAL_OBLIGATIONS_PROCEDURE`) |
| 23514 | 422 | `CONSTRAINT_VIOLATION` | CHECK constraint (some routes translate it, noted per route) |

Unique (23505) / foreign key (23503) violations are translated per route where noted; elsewhere they
fall through to `500 INTERNAL`.

---

## 4. Roles

`enum UserRole` in `brokerage-db/schema.prisma`:

| Role | What the code lets it do |
|---|---|
| `ADMIN` | Creates/suspends users and issues invitations, password and MFA resets (only role that can). Sees all deals (STAFF). Bank staff: imports and verifies bank files, matches lines, prepares reconciliations, records commission received and payments sent, proposes commission plans/adjustments, records obligations, opens unclaimed records, RECO filing figures, journal export, accounting dashboard. Cannot move trust money or approve anything a managing broker approves. MFA required. |
| `MANAGING_BROKER` | Everything bank staff can do, plus the only role that moves trust money (deposits, disbursements, reversals, hold release, closing finalize/void), approves payouts, plans, adjustments, signs reconciliations, opens agent recoveries, decides financial policies, adds proclaimed holidays, signs the trade record sheet as broker of record, reviews documents, FINTRAC reports/program, RECO attestations/submission. Can also be an agent on deals (personal dashboard). Many of these also require an active broker-of-record designation (DB). MFA required. |
| `COMPLIANCE_ADMIN` | Sees all deals (STAFF). Reviews documents (approve / needs revision), FINTRAC reports and compliance program, flags trust holds, privacy breaches and legal holds, broker dashboard, audit export. Read access to trust, bank, closing views (TRUST_VIEWERS). No bank-staff or money actions. MFA required. |
| `AGENT` | Works only on their own deals: opens deals they are on, adds parties, uploads documents, conditions/firm/close/amend/terminate, offers, TRESA/FINTRAC records, trade record sheet prepare/correct/sign as agent, views own trust ledger, own commission plan, own dashboard/pipeline/agent oversight view. No trust, bank, closing or payout access. MFA optional unless configured. |

---

## 5. Server-sent events (notifications)

`GET /api/notifications/stream` — the only streaming endpoint.

- Auth: any signed-in user (ANY). Session cookie in session mode (use `new EventSource(url, { withCredentials: true })`
  or same-origin); `x-user-id` in dev mode. GET, so no CSRF. Privileged users must have completed MFA
  (else `401 MFA_REQUIRED` JSON before the stream opens).
- Response: `200`, `content-type: text/event-stream`, `cache-control: no-cache, no-transform`,
  `connection: keep-alive`, `x-accel-buffering: no`. The reply is hijacked, so the usual security/no-store
  headers are not added and the request is not audited.
- Stream format:
  ```
  retry: 5000

  event: ready
  data: {}

  id: <notification uuid>
  event: notification
  data: {"id":"…","userId":"…","type":"DOCUMENT_APPROVED","title":"Approved: …","body":"2026-0001 · 12 Main St","dealId":"…","slotId":"…","createdAt":"2026-…Z","readAt":null}

  : ping
  ```
  Heartbeat comment `: ping` every 25 s. Only notifications for the connected user are sent, and only
  those created after connecting (missed ones: `GET /api/notifications`). `Last-Event-ID` is not used.
- `data` is a `NotificationView` (`compliance/notifications.ts`):
  `{ id, userId, type, title, body, dealId|null, slotId|null, createdAt, readAt|null }`.
- `type` values produced by the code:
  - `DOCUMENT_APPROVED`, `DOCUMENT_NEEDS_REVISION` — to the deal's agents and the uploader (not the reviewer), on document review.
  - `BANK_RECORD_MISMATCH` — to every active managing broker, when an imported bank file disagrees with earlier files.
  - `TRUST_BANK_UNMATCHED_WITHDRAWAL` — to managing brokers, when a trust bank file has withdrawals with no ledger match.
  - `TRUST_SHORTFALL`, `TRUST_RECONCILIATION_EXCEPTION` — to managing brokers, when a reconciliation is prepared with a shortfall / exceptions.
- The hub is in-process: with several server instances a client only receives events published on the
  instance it is connected to.

---

## 6. Routes by area

Format for each route: **Who** (roles, deal rule, DB checks) · **Request** (params, query, headers,
body) · **Response** · **Errors** (in addition to the generic `401 UNAUTHENTICATED`, `403 FORBIDDEN`
role failure, `400 VALIDATION_FAILED`, `404 NOT_FOUND`, which apply everywhere they make sense).

---

### 6.1 Auth & users (16)

Session mode only. Source: `security/http.ts`, `security/auth-service.ts`. These routes are not
written to the generic API audit (they write their own events).

#### 1. `POST /api/auth/login`
- **Who**: anyone (pre-session; no CSRF).
- **Body**: `email` text(320) (lower-cased, matched case-insensitively), `password` text(256).
- **Response 200**: sets `zh_session` cookie.
  ```json
  { "csrfToken": "<base64url>", "expiresAt": "2026-10-20T02:00:00.000Z", "mfa": { "enabled": true, "required": true } }
  ```
  `expiresAt` = absolute session expiry.
- **Errors**: `401 INVALID_CREDENTIALS`, `423 ACCOUNT_LOCKED` (message includes the unlock time),
  `429 RATE_LIMITED` (per IP / per e-mail), `400 VALIDATION_FAILED`.

#### 2. `POST /api/auth/logout`
- **Who**: signed-in (allowed before MFA). CSRF required.
- **Body**: ignored.
- **Response 200**: `{ "signedOut": true }`; clears the cookie; session revoked.
- **Errors**: `401 UNAUTHENTICATED` "Please sign in" (no session).

#### 3. `GET /api/auth/me`
- **Who**: signed-in (allowed before MFA).
- **Response 200**:
  ```json
  { "id": "uuid", "email": "…", "firstName": "…", "lastName": "…", "role": "MANAGING_BROKER",
    "mfa": { "enabled": true, "satisfied": false, "required": true }, "csrfToken": "…" }
  ```
  Use this on page load to recover the CSRF token and the MFA step.

#### 4. `POST /api/auth/mfa/enroll`
- **Who**: signed-in (allowed before MFA). CSRF required. Any role.
- **Body**: ignored.
- **Response 200**: `{ "secret": "<base32>", "otpauthUri": "otpauth://totp/…?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30" }`.
  Calling again before confirming replaces the secret.
- **Errors**: `409 MFA_ALREADY_ENABLED`, `404 NOT_FOUND` (no credential).

#### 5. `POST /api/auth/mfa/enroll/confirm`
- **Who**: signed-in (allowed before MFA). CSRF required.
- **Body**: `code` text(10) — must be 6 digits to match.
- **Response 200**: rotates the session token (new `Set-Cookie`) and marks the session MFA-verified.
  ```json
  { "enabled": true, "recoveryCodes": ["ABCDE-12345", "… 10 codes"], "note": "Store these recovery codes somewhere safe. Each works once, and they won't be shown again." }
  ```
- **Errors**: `409 MFA_ALREADY_ENABLED`, `422 MFA_NOT_STARTED`, `401 MFA_CODE_INVALID` (counts toward lockout).

#### 6. `POST /api/auth/mfa/verify`
- **Who**: signed-in (allowed before MFA). CSRF required.
- **Body**: exactly one of `code` text?(10) (6-digit TOTP) or `recoveryCode` text?(20) (`XXXXX-XXXXX`).
  Both or neither → `VALIDATION_FAILED` on `code` ("give either code or recoveryCode").
- **Response 200**: rotates the session token (new cookie).
  `{ "verified": true, "recoveryCodesLeft": 9 }`
- **Errors**: `422 MFA_NOT_ENABLED`, `423 ACCOUNT_LOCKED`, `401 MFA_CODE_INVALID` (wrong or replayed code; counts toward lockout).

#### 7. `GET /api/auth/sessions`
- **Who**: signed-in, MFA complete.
- **Response 200**: `{ "sessions": [ { "id", "createdAt", "lastSeenAt", "ip", "userAgent", "current": true } ] }`
  (own active, unexpired sessions, most recent first).

#### 8. `POST /api/auth/sessions/:id/revoke`
- **Who**: signed-in, MFA complete. CSRF. Only your own sessions.
- **Params**: `id` (not UUID-validated in code).
- **Body**: ignored.
- **Response 200**: `{ "revoked": "<id>" }`.
- **Errors**: `404 NOT_FOUND` (not yours / already revoked).

#### 9. `POST /api/auth/password`
- **Who**: signed-in, MFA complete. CSRF.
- **Body**: `currentPassword` text(256), `newPassword` text(256) (rules §2.6).
- **Response 200**: `{ "changed": true }`. All other sessions of the user are revoked.
- **Errors**: `401 INVALID_CREDENTIALS` "Current password is incorrect" (counts toward lockout), `400 VALIDATION_FAILED` (`newPassword`).

#### 10. `POST /api/auth/invitations/accept`
- **Who**: anyone (pre-session; no CSRF).
- **Body**: `token` text(200) (the `invitationToken`), `password` text(256).
- **Response 200**: `{ "passwordSet": true }`. Does not sign in.
- **Errors**: `400 TOKEN_INVALID` "This link is invalid or has expired. Ask an admin for a new one."
  (unknown, wrong purpose, used, expired, or user suspended), `400 VALIDATION_FAILED` (`password`).

#### 11. `POST /api/auth/password-resets/complete`
- Same as #10 with the `resetToken` (purpose `PASSWORD_RESET`, 60-minute lifetime). Clears the lockout.
- **Response 200**: `{ "passwordSet": true }`. **Errors**: `400 TOKEN_INVALID`, `400 VALIDATION_FAILED`.

#### 12. `POST /api/users`
- **Who**: `ADMIN`. CSRF.
- **Body**: `email` text(320) (must look like an e-mail; lower-cased), `firstName` text(100),
  `lastName` text(100), `role` oneOf(`ADMIN`|`MANAGING_BROKER`|`COMPLIANCE_ADMIN`|`AGENT`), `phone` text?(40).
- **Response 201**: `{ "userId": "uuid", "invitationToken": "<base64url>", "expiresInMinutes": 4320 }`.
- **Errors**: `409 EMAIL_IN_USE`.

#### 13. `POST /api/users/:id/password-reset`
- **Who**: `ADMIN`, not for your own id. CSRF. Body ignored.
- **Response 200**: `{ "resetToken": "<base64url>", "expiresInMinutes": 60 }`.
- **Errors**: `403 FORBIDDEN` "Use change password for your own account", `404 NOT_FOUND`.

#### 14. `POST /api/users/:id/mfa-reset`
- **Who**: `ADMIN`, not for yourself ("Another admin must reset your two-factor sign-in"). CSRF. Body ignored.
- **Response 200**: `{ "reset": true }` — clears the secret, recovery codes and enrolment; revokes the user's sessions.
- **Errors**: `403 FORBIDDEN`; a user with no credential row is not translated (500).

#### 15. `POST /api/users/:id/suspend`
- **Who**: `ADMIN`, not yourself. CSRF. Body ignored.
- **Response 200**: `{ "suspended": true }` (sets `isActive=false`; their sessions stop working).
- **Errors**: `403 FORBIDDEN` "You can't suspend your own account", `404 NOT_FOUND`.

#### 16. `POST /api/users/:id/reactivate`
- **Who**: `ADMIN`, not yourself. CSRF. Body ignored.
- **Response 200**: `{ "reactivated": true }`. **Errors**: `403`, `404`.

---

### 6.2 Notifications (3)

Source: `compliance/routes.ts`, `compliance/service.ts`.

#### 17. `GET /api/notifications`
- **Who**: ANY (own notifications only).
- **Query**: `unread=true` → only unread (any other value = all).
- **Response 200**: a bare **array** of `NotificationView` (newest first, max 100).

#### 18. `POST /api/notifications/:id/read`
- **Who**: ANY, own notification. Body ignored.
- **Response 200**: the `NotificationView` with `readAt` set (idempotent: keeps the first `readAt`).
- **Errors**: `404 NOT_FOUND` (not found or not yours).

#### 19. `GET /api/notifications/stream`
- Server-sent events; see §5.

---

### 6.3 Deals & lifecycle (12)

Sources: `compliance/routes.ts` + `compliance/validation.ts` + `compliance/service.ts` (create deal,
parties); `deals/lifecycle.ts` (the rest). Deal status order is enforced by the database
(`ILLEGAL_STATUS_CHANGE 409`).

`LifecycleView` (`deals/lifecycle.ts`):
```
{ dealId, status, side,
  conditions: [{ id, kind, description, forBenefitOf, dueAt (timestamp, extended date if extended), state: OPEN|FULFILLED|WAIVED|EXTENDED|FAILED,
                 overdue, history: [{ outcome, eventAt, newDueAt|null, reference }] }],
  amendments: [{ field, oldValue|null, newValue, effectiveDate, reference }],
  termination: { reason, terminatedOn, reference, note } | null,
  trustBalance: "0.00", nextSteps: string[] }
```

#### 20. `POST /api/deals`
- **Who**: STAFF; or an `AGENT` who lists themself in `agents`. Every `agents[].userId` must be an active
  `AGENT` or `MANAGING_BROKER`.
- **Body**:

  | Field | Type |
  |---|---|
  | `side` | oneOf(`LISTING`\|`BUYER`\|`DUAL`\|`LANDLORD`\|`TENANT`) |
  | `status` | optional oneOf(`CONDITIONAL`\|`FIRM`), default `CONDITIONAL` |
  | `streetAddress` | text(200) |
  | `unit` | text?(20) |
  | `city` | text(100) |
  | `mlsNumber` | text?(20) |
  | `listingId` | uuid? |
  | `salePrice` | amount |
  | `offerDate` | date |
  | `conditionsDueDate` | date? |
  | `closeDate` | date, ≥ `offerDate` |
  | `depositAmount` | amount |
  | `depositDueDate` | date? |
  | `trustDepositHolder` | oneOf(`OUR_BROKERAGE`\|`COOP_BROKERAGE`\|`LAWYER`\|`BUILDER`) |
  | `totalGci` | amount (base commission, before tax) |
  | `coopBrokerageName` | text?(200) |
  | `coopCommission` | optional amount, default 0; only allowed > 0 when `side` is `LISTING` or `LANDLORD` |
  | `outsideReferralPayee` | text?(200) — required together with `outsideReferralPct` |
  | `outsideReferralPct` | optional percent(0..100), must be > 0 and < 100 |
  | `agents` | list of 1–4 `{ userId: uuid, role: oneOf(PRIMARY\|CO_AGENT\|REFERRAL), splitPct: percent(0..100) }`; exactly one `PRIMARY`; no duplicates |
  | `parties` | list of 1–20 Party objects (below); must include at least one client for the side: BUYER→`BUYER`, LISTING→`SELLER`, DUAL→`BUYER` or `SELLER`, LANDLORD→`LANDLORD`, TENANT→`TENANT` |

  Party object: `role` oneOf(`SELLER`|`BUYER`|`LANDLORD`|`TENANT`|`SELLER_LAWYER`|`BUYER_LAWYER`|`COOP_BROKERAGE`),
  `entityType` optional oneOf(`INDIVIDUAL`|`CORPORATION`) default `INDIVIDUAL`, `fullName` text(300, min 2),
  `email` text?(200) (valid e-mail), `phone` text?(40),
  `representation` optional oneOf(`OUR_CLIENT`|`REPRESENTED_ELSEWHERE`|`SELF_REPRESENTED`).
- Deal number is assigned `YYYY-NNNN`. `depositStatus` = `AWAITING` if held by `OUR_BROKERAGE`, else
  `HELD_ELSEWHERE`. Mandatory document slots (incl. FINTRAC slots per client) are created.
- **Response 201**: `DealDocuments` (same as #32).
- **Errors**: `403 FORBIDDEN` "Agents can only open deals they are on"; `400 VALIDATION_FAILED`
  (`agents`: "every agent must be an active agent or broker").

#### 21. `POST /api/deals/:dealId/parties`
- **Who**: DEAL.
- **Body**: one Party object (as in #20).
- **Response 201**: `{ "party": { "id" }, "slotsAdded": 1, "documents": DealDocuments }`.
- **Errors**: `404 NOT_FOUND` (deal).

#### 22. `GET /api/deals/:dealId/lifecycle`
- **Who**: DEAL. **Response 200**: `LifecycleView`. **Errors**: `404`.

#### 23. `POST /api/deals/:dealId/conditions`
- **Who**: DEAL.
- **Body**: `kind` oneOf(`FINANCING`|`INSPECTION`|`STATUS_CERTIFICATE`|`SALE_OF_BUYERS_PROPERTY`|`LAWYER_REVIEW`|`INSURANCE`|`OTHER`),
  `description` text(500), `forBenefitOf` oneOf(`BUYER`|`SELLER`|`BOTH`|`LANDLORD`|`TENANT`), `dueAt` timestamp.
- **Response 201**: `LifecycleView`.
- **Errors**: `409 ILLEGAL_STATUS_CHANGE` (DB: conditions are added only while the deal is `CONDITIONAL`),
  `403 FORBIDDEN` (DB `DEAL_UNAUTHORIZED`).

#### 24. `POST /api/conditions/:id/outcome`
- **Who**: DEAL (of the condition's deal).
- **Body**: `outcome` oneOf(`FULFILLED`|`WAIVED`|`EXTENDED`|`FAILED`), `eventAt` timestamp optional (default now),
  `newDueAt` timestamp — required for `EXTENDED` and only then, `reference` text(300),
  `documentFileId` uuid?, `note` text?(2000).
- **Response 201**: `LifecycleView`.
- **Errors**: `404` (condition), `409 ILLEGAL_STATUS_CHANGE` (DB: condition already resolved).

#### 25. `POST /api/deals/:dealId/firm`
- **Who**: DEAL. Body ignored.
- **Response 200**: `LifecycleView` (status `FIRM`).
- **Errors**: `409 ILLEGAL_STATUS_CHANGE` (DB: wrong status order, or open conditions remain), `404`.

#### 26. `POST /api/deals/:dealId/close`
- **Who**: DEAL. Body optional (`body ?? {}`).
- **Body**: `closedOn` optional past date — replaces `closeDate` if given.
- **Response 200**: `LifecycleView` (status `CLOSED`).
- **Errors**: `409 ILLEGAL_STATUS_CHANGE` (DB), `404`.

#### 27. `POST /api/deals/:dealId/amendments`
- **Who**: DEAL; amending `TOTAL_GCI` or `COOP_COMMISSION` additionally requires `MANAGING_BROKER` or `ADMIN`.
- **Body**: `field` oneOf(`SALE_PRICE`|`CLOSE_DATE`|`DEPOSIT_AMOUNT`|`DEPOSIT_DUE_DATE`|`TOTAL_GCI`|`COOP_COMMISSION`|`OTHER`);
  `newValue` — date for `CLOSE_DATE`/`DEPOSIT_DUE_DATE`, amount for `SALE_PRICE`/`DEPOSIT_AMOUNT`/`TOTAL_GCI`/`COOP_COMMISSION`,
  text(2000) for `OTHER`; `effectiveDate` optional past date (default today); `reference` text(300);
  `documentFileId` uuid?. (`description` is an accepted key but is never read.)
- The amendment is recorded and the deal column updated in one transaction (`OTHER` only records).
- **Response 201**: `LifecycleView`.
- **Errors**: `422 NO_CHANGE`, `409 ILLEGAL_STATUS_CHANGE` (DB: only before closing), `404`.

#### 28. `POST /api/deals/:dealId/terminate`
- **Who**: DEAL.
- **Body**: `reason` oneOf(`CONDITION_NOT_MET`|`MUTUAL_RELEASE`|`BUYER_DEFAULT`|`SELLER_DEFAULT`|`OTHER`),
  `terminatedOn` optional past date (default today), `reference` text(300), `documentFileId` uuid?, `note` text(2000).
- Sets the deal to `COLLAPSED`.
- **Response 200**: `LifecycleView`.
- **Errors**: `409 ALREADY_TERMINATED`, `409 ILLEGAL_STATUS_CHANGE` (DB: only before closing).

#### 29. `GET /api/deals/:dealId/offers`
- **Who**: DEAL.
- **Response 200**: `{ "offers": [ Offer ] }` where Offer =
  `{ id, receivedAt, written, offerorBrokerage|null, offerorSelfRepresented, price|null, status: RECEIVED|SIGNED_BACK|ACCEPTED|REJECTED|EXPIRED|WITHDRAWN, documentFileId|null, keepUntil (date: +6 years if accepted else +1 year), history: [{ status, eventAt, note }] }`.

#### 30. `POST /api/deals/:dealId/offers`
- **Who**: DEAL.
- **Body**: `receivedAt` timestamp, `written` bool, `offerorBrokerage` text?(200),
  `offerorSelfRepresented` optional bool (default false) — one of brokerage / self-represented is required,
  `price` optional amount, `documentFileId` uuid?.
- **Response 201**: `{ "offers": [ Offer ] }`.
- **Errors**: `422 BANK_RULE` (DB: offers are recorded on the listing side — `LISTING`/`DUAL`/`LANDLORD` deal).

#### 31. `POST /api/offers/:id/events`
- **Who**: DEAL (of the offer's listing deal).
- **Body**: `status` oneOf(`SIGNED_BACK`|`ACCEPTED`|`REJECTED`|`EXPIRED`|`WITHDRAWN`), `eventAt` timestamp optional (default now), `note` text?(1000).
- Before `ACCEPTED`, the TRESA offer-disclosure rules are evaluated.
- **Response 201**: `{ "offers": [ Offer ] }`.
- **Errors**: `422 OFFER_DISCLOSURES_OUTSTANDING` (`details.outstanding: string[]`), `409 ILLEGAL_STATUS_CHANGE`
  (DB: offer already in a final state), `422 BANK_RULE` (DB: another offer already accepted), `404`.

---

### 6.4 Documents & compliance (5)

Sources: `compliance/routes.ts`, `compliance/service.ts`, `compliance/validation.ts`, `compliance/fintrac.ts`,
`compliance/rules.ts`, `compliance/storage.ts`.

`DealDocuments` (`compliance/service.ts`):
```
{ deal: { id, dealNumber, side, status, streetAddress, city },
  slots: SlotView[],
  summary: { required, approved, pendingReview, needsRevision, missing, complete } }
SlotView = { id, dealId, code, name, formNumber|null, metadataKind: NONE|FINTRAC_INDIVIDUAL|FINTRAC_CORPORATE,
  party: { id, fullName, role, entityType } | null, status: MISSING|PENDING_REVIEW|APPROVED|NEEDS_REVISION|WAIVED,
  isRequired, reviewerId|null, reviewedAt|null, reviewComment|null, latestFile: FileView|null }
FileView = { id, version, fileName, mimeType, sizeBytes, sha256, uploadedById, uploadedAt,
  metadataSummary: (individual) { fullLegalName, idType, idNumber: "•••• 1234", expiryDate, verificationDate, thirdPartyDetermination }
                 | (corporate) { corporationLegalName, registrationNumber, verificationDate, beneficialOwnerCount, thirdPartyDetermination } | null }
```
Status transitions: `MISSING → PENDING_REVIEW|WAIVED`, `PENDING_REVIEW → PENDING_REVIEW (new version)|APPROVED|NEEDS_REVISION`,
`NEEDS_REVISION → PENDING_REVIEW`; `APPROVED` and `WAIVED` are final. No API route waives a slot.

#### 32. `GET /api/deals/:dealId/documents`
- **Who**: DEAL. **Response 200**: `DealDocuments`. **Errors**: `404`.

#### 33. `POST /api/documents/slots/:slotId/files` (multipart upload)
- **Who**: DEAL (slot's deal). CSRF header in session mode.
- **Request**: `multipart/form-data` with
  - `file` (exactly one file part, field name must be `file`): `application/pdf`, `image/jpeg`, `image/png` or
    `image/heic`; content is sniffed against the declared type; 1 byte to **25 MB**. File name truncated to 255.
  - `metadata` (optional text field): a JSON string. **Required** when the slot's `metadataKind` is
    `FINTRAC_INDIVIDUAL` or `FINTRAC_CORPORATE`; **must be absent** when `NONE`.
  - Any other field → `VALIDATION_FAILED` "is not a recognised field". Multipart limits: 1 file, 2 fields,
    3 parts, 64 KiB per field.
- `metadata` for **FINTRAC_INDIVIDUAL** (`validateFintracIndividual`, error paths prefixed `metadata.`):

  | Field | Type |
  |---|---|
  | `verificationDate` | past date |
  | `verificationMode` | optional oneOf(`IN_PERSON`\|`REMOTE_AUTHENTICATED`), default `IN_PERSON` |
  | `fullLegalName` | text(200, min 2) |
  | `dateOfBirth` | past date, before `verificationDate` |
  | `address` | text(300) |
  | `occupation` | text(200) |
  | `idType` | oneOf(`DRIVERS_LICENCE`\|`PASSPORT`\|`PERMANENT_RESIDENT_CARD`\|`PROVINCIAL_PHOTO_ID_CARD`\|`SECURE_CERTIFICATE_OF_INDIAN_STATUS`\|`OTHER_GOVERNMENT_PHOTO_ID`) |
  | `idNumber` | text(30), regex `^[A-Za-z0-9][A-Za-z0-9 -]{2,29}$` |
  | `issuingJurisdiction` | text(100) |
  | `expiryDate` | date, ≥ `verificationDate` |
  | `thirdPartyDetermination` | bool |
  | `thirdParty` | object `{ name text(200), address text(300), relationship text(200) }` — required if `thirdPartyDetermination` is true, must be absent if false |

- `metadata` for **FINTRAC_CORPORATE** (`validateFintracCorporate`):

  | Field | Type |
  |---|---|
  | `verificationDate` | past date |
  | `corporationLegalName` | text(300, min 2) |
  | `registrationNumber` | text(50) |
  | `jurisdictionOfIncorporation` | text(100) |
  | `registeredAddress` | text(300) |
  | `natureOfBusiness` | text(300) |
  | `verificationSource` | oneOf(`CERTIFICATE_OF_CORPORATE_STATUS`\|`GOVERNMENT_REGISTRY_RECORD`\|`OTHER_AUTHORITATIVE_RECORD`) |
  | `verificationSourceReference` | text(300) |
  | `directors` | textList(max 50, 200) |
  | `beneficialOwners` | optional list (max 4) of `{ fullName text(200), address text(300), ownershipPercent percent(25..100) }`; total ≤ 100 |
  | `noBeneficialOwnerReason` | text?(1000) — required when no beneficial owners |
  | `seniorManagingOfficer` | text?(200) — required when no beneficial owners |
  | `controlStructure` | text(2000) |
  | `thirdPartyDetermination`, `thirdParty` | as for individuals |

- ID number, date of birth and addresses are encrypted at rest.
- Slot moves to `PENDING_REVIEW`; version increments.
- **Response 201**: `{ "slot": SlotView, "fileId": "uuid", "version": 2, "warnings": ["LEGAL_NAME_DIFFERS_FROM_PARTY"] }`.
- **Errors**: `400 VALIDATION_FAILED` (not multipart, missing `file`, wrong type/content/size, metadata invalid JSON / missing / not used / invalid),
  `409 DOCUMENT_LOCKED` (slot `APPROVED`/`WAIVED`, or changed during upload), `422 LISTING_SLOTS_NOT_SUPPORTED`,
  `413 BAD_REQUEST` (multipart file over the limit), `404`.

#### 34. `POST /api/documents/slots/:slotId/review`
- **Who**: REVIEWERS (`MANAGING_BROKER`, `COMPLIANCE_ADMIN`). No deal-access check beyond the role. DB re-checks review authority.
- **Body**: `decision` oneOf(`APPROVED`|`NEEDS_REVISION`), `comment` text?(2000) — required with at least 10 characters for
  `NEEDS_REVISION`, `fileId` uuid (must be the slot's latest version).
- Approving an individual FINTRAC record sets the party's FINTRAC ID-verified date. Notifies the deal's agents and the uploader (§5).
- **Response 200**: `ReviewResult` = `{ slot: SlotView, review: { id, decision, comment, fileId, reviewerId, createdAt }, notified: [userId] }`.
- **Errors**: `409 NOT_PENDING_REVIEW`, `409 STALE_REVIEW` (`details.latestFileId`), `404`.

#### 35. `GET /api/documents/files/:fileId`
- **Who**: DEAL. Audited as a sensitive read.
- **Response 200**: `FileView & { slotId, metadata }` — `metadata` is the full decrypted FINTRAC record
  (`FintracIndividualRecord` / `FintracCorporateRecord` in `compliance/fintrac.ts`, with `schema` =
  `FINTRAC_INDIVIDUAL_V1`/`FINTRAC_CORPORATE_V1`) for STAFF, and `null` for agents (they get only `metadataSummary`).
- **Errors**: `404` (also for listing-checklist files).

#### 36. `GET /api/documents/files/:fileId/content`
- **Who**: DEAL. Audited.
- **Response 200**: the raw bytes, `content-type` = stored MIME type,
  `content-disposition: attachment; filename="<sanitised name>"`,
  `content-security-policy: default-src 'none'; sandbox`, `cache-control: private, no-store`.

---

### 6.5 TRESA / FINTRAC obligations (12)

Source: `obligations/service.ts` (+ `tresa.ts`, `fintrac.ts`, `types.ts`). Nothing is filed with RECO
or FINTRAC; references are recorded.

`DealObligations` (return of `evaluateDeal`):
```
{ dealId, asOf (timestamp),
  parties: [{ id, role, name, representation: OUR_CLIENT|REPRESENTED_ELSEWHERE|SELF_REPRESENTED|UNKNOWN }],
  tresa: Finding[], fintrac: Finding[],
  summary: { tresa: { blocking, breaches, warnings }, fintrac: { blocking, breaches, warnings } } }
Finding = { rule, citation, severity: BLOCKING|BREACH|WARNING, message, partyId?, offerId?, dueBy? }   (obligations/types.ts)
```
BLOCKING findings block the broker-of-record trade record signature (#53) and, for offer rules, accepting an offer (#31).

#### 37. `GET /api/deals/:dealId/obligations`
- **Who**: DEAL. **Response 200**: `DealObligations`.

#### 38. `POST /api/deals/:dealId/parties/:partyId/representation`
- **Who**: DEAL.
- **Body**: `representation` oneOf(`OUR_CLIENT`|`REPRESENTED_ELSEWHERE`|`SELF_REPRESENTED`).
- Adds any FINTRAC slot newly required (a self-represented principal needs one).
- **Response 200**: `DealObligations`. **Errors**: `404` "Party on this deal".

#### 39. `POST /api/deals/:dealId/disclosures`
- **Who**: DEAL.
- **Body**:

  | Field | Type |
  |---|---|
  | `kind` | oneOf(`INFORMATION_GUIDE`\|`SELF_REPRESENTED_PARTY_FORM`\|`MULTIPLE_REPRESENTATION_DISCLOSURE`\|`MULTIPLE_REPRESENTATION_CONSENT`\|`COMPETING_OFFERS_NUMBER`\|`COMPETING_OFFERS_CONTENT`\|`SAME_BROKERAGE_REPRESENTATION`) |
  | `partyId`, `offerId` | uuid? |
  | `deliveredAt` | timestamp (required) |
  | `method` | text(200) |
  | `explainedAt`, `acknowledgedAt` | timestamp, optional |
  | `bestEffortsNote` | text?(1000) |
  | `formVersion` | optional oneOf(`BROKERAGE_REPRESENTATION`\|`DESIGNATED_REPRESENTATION`) |
  | `numberDisclosed` | optional percent(0..1000) (a count) |
  | `content` | text?(4000) |
  | `directionId` | uuid? (a seller offer direction, #41) |
  | `documentFileId` | uuid? |
- Which of the optional fields each `kind` needs is enforced by a DB CHECK.
- **Response 201**: `DealObligations`.
- **Errors**: `422 DISCLOSURE_INCOMPLETE` (the CHECK failed: missing party/offer, count, content/direction, form version or consent).

#### 40. `POST /api/deals/:dealId/representation-agreements`
- **Who**: DEAL.
- **Body**: `partyId` uuid, `type` oneOf(`BROKERAGE`|`DESIGNATED`), `designatedRepresentativeIds` optional
  textList(max 10, 36) of user UUIDs — required (non-empty) for `DESIGNATED`, `signedAt` timestamp,
  `effectiveFrom` date, `expiresOn` date, `remunerationTerms` text(2000), `services` text(4000),
  `terminationTerms` text(2000), `documentFileId` uuid?.
- **Response 201**: `DealObligations`.

#### 41. `POST /api/deals/:dealId/offer-directions`
- **Who**: DEAL (the listing deal).
- **Body**: `givenAt` timestamp, `shareContent` bool, `scope` text?(2000) — required when `shareContent` is true, `documentFileId` uuid?.
- **Response 201**: `{ id, givenAt, shareContent, scope, documentFileId }`.

#### 42. `POST /api/parties/:partyId/fintrac-determinations`
- **Who**: DEAL (the party's deal).
- **Body**: `kind` oneOf(`PEP_HIO`|`BUSINESS_RELATIONSHIP`|`BENEFICIAL_OWNERSHIP_CONFIRMED`|`ENTITY_EXISTENCE_CONFIRMED`),
  `determinedAt` timestamp optional (default now), `result` text(200), `riskRating` optional oneOf(`LOW`|`MEDIUM`|`HIGH`),
  `details` text(4000).
- **Response 201**: `DealObligations`.
- **Errors**: `422 DETERMINATION_INVALID` (DB CHECK: a `PEP_HIO` result must be one of `NONE`, `FOREIGN_PEP`,
  `DOMESTIC_PEP`, `HIO`, `FAMILY_OR_CLOSE_ASSOCIATE` with a risk rating; a foreign PEP is always `HIGH`), `404`.

#### 43. `POST /api/trust/entries/:entryId/receipt-of-funds`
- **Who**: DEAL (the entry's deal). (Not a trust-role route despite the path.)
- **Body**: `payerType` oneOf(`PERSON`|`ENTITY`|`FINANCIAL_ENTITY`|`PUBLIC_BODY`);
  `payerDetails` object — required (and read) unless the payer is `FINANCIAL_ENTITY`/`PUBLIC_BODY`:
  for `PERSON` `{ address text(300), dateOfBirth date, occupation text(200), telephone text?(40) }`,
  for `ENTITY` `{ address text(300), incorporationNumber text?(50), jurisdiction text(100), principalBusiness text(200) }`;
  `payerName` text(300); `cashAmount` optional amount (default 0); `currency` optional text exactly 3 chars (default `CAD`);
  `sourceAccount` text?(200); `onBehalfOf` text?(300);
  `exemptReason` text?(300) — required for `FINANCIAL_ENTITY`/`PUBLIC_BODY` and only then.
- Payer details are stored encrypted.
- **Response 201**: `DealObligations`.
- **Errors**: `422 ALREADY_RECORDED`, `404` (entry).

#### 44. `GET /api/fintrac/reports`
- **Who**: REVIEWERS. Audited.
- **Query**: `open=true` → only `OPEN`.
- **Response 200**: `{ "reports": [ { id, kind: LARGE_CASH|LARGE_VIRTUAL_CURRENCY|SUSPICIOUS_TRANSACTION|LISTED_PERSON_PROPERTY, dealNumber|null, summary, triggeredAt, dueAt, status: OPEN|FILED|NOT_REQUIRED, reference|null, overdue } ] }` (by `dueAt`).
  Large cash / virtual currency reports are opened automatically by trust deposits (#54), due 15 days after receipt.

#### 45. `POST /api/fintrac/reports`
- **Who**: REVIEWERS.
- **Body**: `kind` oneOf(`SUSPICIOUS_TRANSACTION`|`LISTED_PERSON_PROPERTY`), `dealId` uuid?, `summary` text(4000). Due immediately.
- **Response 201**: `{ "reports": [...] }` (open reports only).

#### 46. `POST /api/fintrac/reports/:id/events`
- **Who**: REVIEWERS.
- **Body**: `status` oneOf(`FILED`|`NOT_REQUIRED`), `reference` text?(200) — required for `FILED` (FINTRAC acknowledgement number), `note` text(2000).
- **Response 200**: `{ "reports": [...] }` (all reports).
- **Errors**: `404`.

#### 47. `GET /api/fintrac/program`
- **Who**: `ADMIN`, `MANAGING_BROKER`, `COMPLIANCE_ADMIN`. Audited.
- **Response 200**: `{ asOf, findings: Finding[], summary: { blocking, breaches, warnings }, records: [{ kind, effectiveDate, title, subject|null }] }` (records max 200).

#### 48. `POST /api/fintrac/program`
- **Who**: REVIEWERS.
- **Body**: `kind` oneOf(`COMPLIANCE_OFFICER`|`POLICIES_APPROVED`|`RISK_ASSESSMENT`|`TRAINING`|`EFFECTIVENESS_REVIEW`),
  `effectiveDate` past date, `subjectUserId` uuid? — required for `COMPLIANCE_OFFICER` and `TRAINING`,
  `title` text(300), `details` text(4000), `documentFileId` uuid?.
- **Response 201**: same as #47.

---

### 6.6 Trade record sheet (5)

Source: `deals/trade-record.ts`; DB rules in migration 015.

`TradeRecordView`:
```
{ id, dealId, status: PREPARED|SIGNED_BY_AGENT|SIGNED_BY_BROKER_OF_RECORD,
  items: [{ item, label, value, history: [{ value, by, at, reason, initials|null }] }],   // 10 items, order below
  missing: [{ item, reason }], differsFromDeal: string[],
  agentSignedBy|null, agentSignedAt|null, brokerSignedBy|null, brokerSignedAt|null, retainUntil|null (date) }
```
Items (`TRS_ITEMS`): `natureOfTrade`, `property`, `consideration`, `parties`, `lawyers`, `registrants`,
`deposit`, `brokerageRemuneration`, `otherBrokerageRemuneration`, `completionDate` (item 10: `scheduled`, `amendedDate`), `additionalItems` (broker's notes).

#### 49. `GET /api/deals/:dealId/trade-record`
- **Who**: DEAL. **Response 200**: `TradeRecordView`. **Errors**: `404` (no sheet yet).

#### 50. `POST /api/deals/:dealId/trade-record`
- **Who**: DEAL. Body ignored. Generates items 1–9 from the deal.
- **Response 201**: `TradeRecordView`. **Errors**: `409 ALREADY_PREPARED`, `404`.

#### 51. `POST /api/deals/:dealId/trade-record/corrections`
- **Who**: DEAL. DB: once the agent has signed, only the broker of record may correct (`403`); after the broker signs, `405 APPEND_ONLY`.
- **Body**: `item` oneOf(TRS_ITEMS), `value` any JSON (required, may be any type), `reason` text(1000).
- **Response 201**: `TradeRecordView` (correction appended with the caller's initials).

#### 52. `POST /api/deals/:dealId/trade-record/sign`
- **Who**: no application role or deal check; DB: the signer must be an agent on the deal (`403 FORBIDDEN` `DEAL_UNAUTHORIZED`).
- **Body** (optional, `body ?? {}`): `exceptionReason` text?(500) (read but not used for the agent signature).
- **Response 200**: `TradeRecordView`.
- **Errors**: `422 BANK_RULE` (DB: conditions still outstanding; items missing; signed before prepared),
  `405 APPEND_ONLY` (already signed / broker signed), `404`.

#### 53. `POST /api/deals/:dealId/trade-record/broker-sign`
- **Who**: `MANAGING_BROKER`; DB: BoR; SoD (broker ≠ agent who signed; `exceptionReason` + `SOLE_OPERATOR_EXCEPTION` to override).
- **Body** (optional): `exceptionReason` text?(500).
- First evaluates the deal's TRESA/FINTRAC obligations.
- **Response 200**: `TradeRecordView`.
- **Errors**: `422 COMPLIANCE_OUTSTANDING` (`details.outstanding: [{ rule, citation, message }]`),
  `422 BANK_RULE` (DB: agent must sign first), `405 APPEND_ONLY`, `403`, `404`.


---

### 6.7 Trust ledger (10)

Sources: `trust/routes.ts`, `trust/validation.ts`, `trust/service.ts`. The ledger is insert-only;
the database re-checks funds, holds and broker authority.

`LedgerEntry`: `{ id, dealId, trustAccountId, entryType, direction (1|-1), amount, method, referenceNo|null, receiptNumber|null, counterparty, receivedDate|null, effectiveDate, authorizationMethod|null, authorizationReference|null, memo|null, reversesEntryId|null, idempotencyKey, enteredById, authorizedById, createdAt }`.
`LedgerWriteResult`: `{ entry: LedgerEntry, dealBalance: "…", warnings: string[], replayed: boolean }`.
`TrustHold`: `{ id, dealId, depositEntryId|null, reason: DISPUTED|UNCLAIMED, note, flaggedById, flaggedAt, releasedById|null, releasedAt|null, releaseNote|null, active }`.

Idempotency: the three money routes need `Idempotency-Key: <uuid>`. Re-sending the same key returns the
original entry with `200` and `replayed: true`; reusing it for a different entry (type, deal, amount,
reversed entry) → `409 IDEMPOTENCY_KEY_REUSED` (`details.entryId`). Missing/invalid header →
`400 VALIDATION_FAILED` on field `Idempotency-Key`.

#### 54. `POST /api/trust/deposits`
- **Who**: BROKER (`MANAGING_BROKER`); DB re-checks broker authority (`403`).
- **Headers**: `Idempotency-Key`.
- **Body**: `dealId` uuid, `trustAccountId` uuid, `amount` amount,
  `method` oneOf(`BANK_DRAFT`|`WIRE`|`CERTIFIED_CHEQUE`|`CASH`|`VIRTUAL_CURRENCY`),
  `dateReceived` past date, `dateDeposited` past date ≥ `dateReceived`, `payorName` text(200),
  `bankReference` text(100), `memo` text?(1000).
- Assigns the next brokerage-wide receipt number (starts at 1000); sets deal deposit status to `RECEIVED`.
- **Response 201** (`200` on replay): `LedgerWriteResult`. `warnings` may contain
  `DEPOSITED_AFTER_5_BUSINESS_DAYS`, `EXCEEDS_EXPECTED_DEPOSIT`, `FINTRAC_LARGE_TRANSACTION_REPORT_OPENED`.
- **Errors**: `422 DEPOSIT_NOT_HELD_BY_BROKERAGE` (`details.trustDepositHolder`), `422 DEAL_NOT_ACTIVE`
  (deal `COLLAPSED`/`CANCELLED`), `422 TRUST_ACCOUNT_INACTIVE`, `404` (deal / trust account), `409 IDEMPOTENCY_KEY_REUSED`.

#### 55. `POST /api/trust/disbursements`
- **Who**: BROKER; DB re-checks.
- **Headers**: `Idempotency-Key`.
- **Body**: `dealId` uuid, `trustAccountId` uuid, `amount` amount, `method` oneOf(`CHEQUE`|`EFT`|`WIRE`|`BANK_DRAFT`),
  `dateDisbursed` past date, `payeeType` oneOf(`OUR_BROKERAGE`|`COOP_BROKERAGE`|`LAWYER`|`LANDLORD`|`PAYOR_REFUND`),
  `payeeName` text(200), `authorizationMethod` oneOf(`CLOSING_COMPLETED`|`MUTUAL_RELEASE`|`COURT_ORDER`),
  `authorizationReference` text?(200) — required for `MUTUAL_RELEASE`/`COURT_ORDER`, `referenceNo` text?(100), `memo` text?(1000).
  `PAYOR_REFUND` cannot use `CLOSING_COMPLETED`.
- Entry type from payee: `OUR_BROKERAGE`→`DISBURSEMENT_TO_GENERAL`, `COOP_BROKERAGE`→`DISBURSEMENT_TO_COOP`,
  `LAWYER`→`DISBURSEMENT_TO_LAWYER`, `LANDLORD`→`DISBURSEMENT_TO_LANDLORD`, `PAYOR_REFUND`→`REFUND_TO_PAYER`.
  When the deal's balance reaches 0, deposit status becomes `RELEASED` (or `REFUNDED` for a refund).
- **Response 201/200**: `LedgerWriteResult` (`warnings` empty).
- **Errors**: `422 DEAL_NOT_CLOSED` (`CLOSING_COMPLETED` on a non-`CLOSED` deal), `423 TRUST_HOLD_ACTIVE`,
  `409 INSUFFICIENT_TRUST_FUNDS`, `409 FUNDS_NOT_CLEARED` (DB: deposits not yet matched to a verified bank line),
  `422 TRUST_ACCOUNT_INACTIVE`, `404`, `409 IDEMPOTENCY_KEY_REUSED`.

#### 56. `POST /api/trust/entries/:entryId/reversals`
- **Who**: BROKER; DB re-checks.
- **Headers**: `Idempotency-Key`.
- **Body**: `reason` text(1000), `effectiveDate` optional past date (default today), not before the original's.
- **Response 201/200**: `LedgerWriteResult` (entry type `REVERSAL`, opposite direction).
- **Errors**: `422 CANNOT_REVERSE_REVERSAL`, `409 ALREADY_REVERSED` (`details.reversalId`), `422 REVERSAL_BEFORE_ORIGINAL`,
  `409 INSUFFICIENT_TRUST_FUNDS` (reversing a deposit the deal no longer holds), `422 INVALID_REVERSAL` (DB), `404`.

#### 57. `GET /api/trust/entries/:entryId`
- **Who**: STAFF, or an agent on the entry's deal. Audited.
- **Response 200**: `LedgerEntry`.

#### 58. `GET /api/deals/:dealId/trust`
- **Who**: STAFF, or an agent on the deal. Audited.
- **Response 200**: `DealLedger` = `{ deal: { id, dealNumber, status, trustDepositHolder, depositStatus }, balances: [{ trustAccountId, balance }], entries: (LedgerEntry & { runningBalance })[], holds: TrustHold[], activeHold: TrustHold|null }`.

#### 59. `POST /api/deals/:dealId/trust/holds`
- **Who**: STAFF (`TRUST_HOLD_FLAGGERS`).
- **Body**: `reason` oneOf(`DISPUTED`|`UNCLAIMED`), `note` text(2000), `depositEntryId` uuid? (must be a deposit on this deal).
- **Response 201**: `TrustHold`.
- **Errors**: `422 INVALID_DEPOSIT_ENTRY`, `409 HOLD_ALREADY_ACTIVE` (`details.holdId`), `422 TRUST_HOLD_RULE` (DB), `404`.

#### 60. `POST /api/trust/holds/:holdId/release`
- **Who**: BROKER.
- **Body**: `releaseNote` text(2000).
- **Response 200**: `TrustHold` (`active: false`).
- **Errors**: `409 HOLD_ALREADY_RELEASED`, `404`.

#### 61–63. `PUT /api/trust/entries/:entryId`, `PATCH /api/trust/entries/:entryId`, `DELETE /api/trust/entries/:entryId`
- **Who**: no check — always refused.
- **Response**: `405 TRUST_LEDGER_IMMUTABLE` "Trust ledger entries can't be changed or deleted. Post a reversal: POST /api/trust/entries/:entryId/reversals".
  (In session mode the CSRF check runs first, so a signed-in caller without `x-csrf-token` gets `403 CSRF_TOKEN`.)

---

### 6.8 Bank statements & matching (8)

Sources: `bank/routes.ts`, `bank/service.ts`, `bank/csv.ts`. All `/api/bank/*` GETs are audited.

`StatementView` (`bank/service.ts`):
```
{ id, kind: MONTHLY|INTERIM, account: { type: TRUST|OPERATING, id }, periodStart, periodEnd, openingBalance|null, closingBalance,
  receivedDate|null, source|null, fileName, importedBy (name),
  verification: { verifiedBy, method, verifiedAt, segregationException, exceptionsReviewed|null } | null,
  integrityExceptions: string[],
  lines: [{ id, lineNumber, postedDate, amount, description, reference|null,
            match: { id, trustEntryId|null, commissionReceiptId|null, payoutEventId|null, receiptReversalId|null, dealNumber|null } | null }],
  matched, unmatched }
```

#### 64. `POST /api/operating-accounts`
- **Who**: BANK_STAFF.
- **Body**: `name` text(100), `bankName` text(100), `accountLast4` exactly 4 digits.
- **Response 201**: `{ id, name, bankName, accountLast4 }`.

#### 65. `POST /api/bank/statements`
- **Who**: BANK_STAFF. Body limit **6 MiB**.
- **Body**:

  | Field | Type |
  |---|---|
  | `kind` | optional oneOf(`MONTHLY`\|`INTERIM`), default `MONTHLY` |
  | `accountType` | oneOf(`TRUST`\|`OPERATING`) (`TRUST` covers real-estate and commission trust accounts) |
  | `accountId` | uuid |
  | `periodStart` | date |
  | `periodEnd` | past date, ≥ `periodStart` |
  | `openingBalance` | signed amount — required for `MONTHLY`, must be absent for `INTERIM` |
  | `closingBalance` | signed amount |
  | `receivedDate` | past date, ≥ `periodEnd` |
  | `source` | oneOf(`BANK_PORTAL_DOWNLOAD`\|`BANK_EMAIL`\|`BANK_PAPER_STATEMENT`\|`OTHER`) |
  | `sourceNote` | text?(500) — required when `source` is `OTHER` |
  | `fileName` | text(255) |
  | `csv` | text(5,000,000) — the file contents |
  | `dateOrder` | optional oneOf(`MDY`\|`DMY`\|`YMD`), default `MDY` |
  | `autoMatch` | optional bool, default true |

  CSV: columns are found by header name (a date, a description, and either one signed amount column or
  separate debit/credit columns; optional running balance and reference). TD's headerless export
  (date, description, debit, credit, balance) is recognised. Every line must fall inside the period;
  for `MONTHLY`, opening + lines must equal closing and a running balance column must agree line by line.
- `INTERIM` lines already imported from an earlier interim file are skipped. Automatic matching proposes
  at most one ledger item per line. Mismatches with other files for the same dates are stored as
  `integrityExceptions` and notify managing brokers (`BANK_RECORD_MISMATCH`); unmatched trust
  withdrawals notify them too (`TRUST_BANK_UNMATCHED_WITHDRAWAL`).
- **Response 201**: `StatementView & { autoMatched: number, duplicatesSkipped: number }`.
- **Errors**: `400 VALIDATION_FAILED` (field `csv` for parse / period / balance issues), `404` (account missing or inactive),
  `409 STATEMENT_ALREADY_IMPORTED` (same file SHA-256 for the account), `409 ALREADY_MATCHED`, `422 BANK_RULE` (DB).

#### 66. `POST /api/bank/statements/:statementId/verify`
- **Who**: BANK_STAFF; DB SoD: verifier ≠ importer (override: `exceptionReason` + `SOLE_OPERATOR_EXCEPTION`).
- **Body**: `method` text(500) (how it was checked against the bank), `exceptionReason` text?(500),
  `exceptionsReviewed` text?(4000) — DB requires it when the statement has `integrityExceptions`.
- **Response 200**: `StatementView`.
- **Errors**: `409 STATEMENT_ALREADY_VERIFIED`, `404`, `403` (SoD), `422 BANK_RULE` (exceptions not reviewed).

#### 67. `GET /api/bank/statements/:statementId`
- **Who**: STAFF. **Response 200**: `StatementView`. **Errors**: `404`.

#### 68. `GET /api/bank/statements/:statementId/reconciliation`
- **Who**: STAFF. Live three-way reconciliation for a **monthly trust** statement; nothing is saved.
- **Response 200**: `{ periodEnd, statementReceived|null, dueBy, statutoryDueBy } & ReconResult` — `ReconResult`
  (`bank/reconcile.ts`) is in **integer cents**: `bankClosingBalance, outstandingDeposits, outstandingDisbursements,
  unrecordedBankItems, adjustedBankBalance, ledgerBalance, clientLiabilities, difference, isBalanced,
  details: { deals: DealLiability[], outstanding: OutstandingItem[], unrecorded: [{ bankTransactionId, postedDate, amount, description }],
  staleDeposits: OutstandingItem[], lateDeposits: [...], shortfalls: [{ dealId, dealNumber, balance }], exceptions: string[] }`.
- **Errors**: `404` "Monthly trust account statement" (operating or interim statement).

#### 69. `POST /api/bank/matches`
- **Who**: BANK_STAFF.
- **Body**: `bankTransactionId` uuid, exactly one of `trustEntryId` | `commissionReceiptId` | `payoutEventId` |
  `receiptReversalId` (uuid; `receiptReversalId` is the reversed receipt's id), `note` text?(500).
- **Response 201**: `{ "matchId": "uuid" }`.
- **Errors**: `409 ALREADY_MATCHED`, `422 BANK_RULE` (DB: account / amount / kind rules).

#### 70. `DELETE /api/bank/matches/:matchId`
- **Who**: BANK_STAFF. No body.
- **Response 200**: `{ "removed": "<matchId>" }`.
- **Errors**: `404`, `422 BANK_RULE` / `405 APPEND_ONLY` (DB: not once funds moved on it).

#### 71. `POST /api/bank/pre-cutover`
- **Who**: BROKER; DB: BoR.
- **Body**: `trustEntryIds` textList(max 500, 36) of entry UUIDs, `note` text(500).
  Attests history from before the first imported statement; already-attested entries are skipped.
- **Response 201**: `{ "attested": <count> }`.

---

### 6.9 Reconciliation & incidents (7)

Source: `bank/service.ts`, `bank/routes.ts`.

`ReconciliationView`:
```
{ id, trustAccountId, statementId, periodEnd, statementReceived|null, dueBy, statutoryDueBy,
  status: PREPARED|SIGNED|SIGNED_WITH_DISCREPANCY|SUPERSEDED, supersedes: { id, reason }|null, supersededBy|null,
  signedOnTime|null, statementVerified, incidents: [{ id, kind, open }],
  figures: { bankClosingBalance, outstandingDeposits, outstandingDisbursements, unrecordedBankItems, adjustedBankBalance,
             ledgerBalance, clientLiabilities, difference },     // decimal strings
  isBalanced, details (ReconResult.details, integer cents), explanation|null, preparedBy, preparedAt,
  signedBy|null, signedAt|null, signatureNote|null, signSegregationException }
```
`IncidentView`:
```
{ id, trustAccountId, kind: SHORTFALL|DISCREPANCY, summary, amount, detectedAt, open, registrarNotified, replenished,
  cause: BANK_SERVICE_FEE|OTHER|null, serviceFeeException: { feesIdentified, replenishBy, available }|null,
  outstanding: string[],
  events: [{ kind, eventDate, amount|null, reference|null, note|null, cause|null, bankTransactionId|null, by, at }] }
```

#### 72. `POST /api/trust/reconciliations`
- **Who**: BANK_STAFF.
- **Body**: `statementId` uuid (monthly trust statement), `explanation` text?(4000),
  `supersedesId` uuid? and `amendmentReason` text?(2000) — both or neither (to correct a signed one).
- A shortfall opens/extends a `SHORTFALL` incident and notifies managing brokers (`TRUST_SHORTFALL`);
  other exceptions open a `DISCREPANCY` incident (`TRUST_RECONCILIATION_EXCEPTION`).
- **Response 201**: `ReconciliationView`.
- **Errors**: `404` (not a monthly trust statement), `422 BANK_RULE` (DB).

#### 73. `GET /api/trust/reconciliations/:id`
- **Who**: STAFF. **Response 200**: `ReconciliationView`.

#### 74. `POST /api/trust/reconciliations/:id/sign`
- **Who**: BROKER; DB: BoR; SoD: signer ≠ preparer (override with `exceptionReason` + `SOLE_OPERATOR_EXCEPTION`).
- **Body** (optional, `body ?? {}`): `note` text?(2000), `exceptionReason` text?(500).
- **Response 200**: `ReconciliationView`.
- **Errors**: `409 RECONCILIATION_ALREADY_SIGNED`, `422 RECONCILIATION_SUPERSEDED` (a newer one exists for the statement),
  `422 RECONCILIATION_NEEDS_EXPLANATION` (`details.exceptions`; prepare again with `explanation`), `403`, `422 BANK_RULE` (DB).

#### 75. `GET /api/trust/reconciliation-status`
- **Who**: STAFF. Audited.
- **Response 200**: `{ "accounts": AccountReconStatus[] }` — per active trust account
  `{ trustAccountId, name, kind: REAL_ESTATE_TRUST|COMMISSION_TRUST, lastStatementEnd|null, lastSignedPeriodEnd|null,
  awaitingSignature: [{ periodEnd, received|null, dueBy, overdue }], missingStatements: [{ month (YYYY-MM), dueBy, overdue }],
  openIncidents: [{ id, kind, amount, detectedAt }] }`.

#### 76. `GET /api/trust/incidents`
- **Who**: STAFF. **Query**: `open=true` → open only. Max 200, newest first.
- **Response 200**: `{ "incidents": IncidentView[] }`.

#### 77. `GET /api/trust/incidents/:id`
- **Who**: STAFF. **Response 200**: `IncidentView`.

#### 78. `POST /api/trust/incidents/:id/events`
- **Who**: BANK_STAFF; DB: BoR for `REGISTRAR_NOTIFIED`, `REPLENISHED`, `RESOLVED`, `CAUSE_DETERMINED`.
- **Body**: `kind` oneOf(`NOTE`|`REGISTRAR_NOTIFIED`|`REPLENISHED`|`RESOLVED`|`CAUSE_DETERMINED`),
  `cause` oneOf(`BANK_SERVICE_FEE`|`OTHER`) — with `CAUSE_DETERMINED` and only then,
  `eventDate` optional past date (default today), `amount` amount — required for `REPLENISHED`,
  `reference` text?(200) — required for `REGISTRAR_NOTIFIED`/`REPLENISHED`, `note` text?(4000) — required for
  `NOTE`/`RESOLVED`/`CAUSE_DETERMINED`, `reconciliationId` uuid?, `bankTransactionId` uuid? — required when `cause` is `BANK_SERVICE_FEE`.
- **Response 201**: `IncidentView`.
- **Errors**: `404`, `403` (BoR), `422 BANK_RULE` (DB: e.g. a shortfall is resolved only once notified and replenished, or the service-fee exception applies, or a later balanced reconciliation shows none).

---

### 6.10 Unclaimed trust money (6)

Source: `bank/unclaimed.ts`. All under `/api/trust/` (audited).

`UnclaimedView`:
```
{ id, dealId, dealNumber, trustAccountId, entitlement, entitledParty|null, heldSince, clockStarts, remitDue, monthsHeld,
  escalation: 0|18|21|23|24, principal, interest, amountDue, currentTrustBalance, belowRemittanceMinimum (< $25),
  contactAttempts, lastContactAttempt|null, status: OPEN|PARTY_LOCATED|PAID_OUT|REMITTED|CLOSED, outstanding: string[],
  events: [{ kind, eventDate, method|null, outcome|null, amount|null, reference|null, note, by }] }
```

#### 79. `GET /api/trust/unclaimed`
- **Who**: STAFF. **Response 200**: `{ asOf, records: UnclaimedView[], totals: { open, held, dueToReco } }`.

#### 80. `GET /api/trust/unclaimed/candidates`
- **Who**: STAFF.
- **Response 200**: `{ "candidates": [{ dealId, dealNumber, status, trustAccountId, balance, lastActivity }] }` — deals
  `COLLAPSED`/`CANCELLED`, or `CLOSED` over 90 days ago, still holding trust money and not registered.

#### 81. `POST /api/trust/unclaimed`
- **Who**: BANK_STAFF.
- **Body**: `dealId` uuid, `trustAccountId` uuid, `heldSince` past date, `entitledSince` optional past date,
  `entitlement` oneOf(`ENTITLED_PARTY_NOT_LOCATED`|`ENTITLEMENT_UNCLEAR`|`DISPUTED`),
  `entitledParty` text?(300) — required for `ENTITLED_PARTY_NOT_LOCATED`, `reason` text(2000).
  The amount is taken from the ledger.
- **Response 201**: `UnclaimedView`.
- **Errors**: `422 NO_TRUST_BALANCE`, `409 ALREADY_REGISTERED`.

#### 82. `GET /api/trust/unclaimed/:id`
- **Who**: STAFF. **Response 200**: `UnclaimedView`.

#### 83. `POST /api/trust/unclaimed/:id/events`
- **Who**: BANK_STAFF; DB: BoR for `REMITTED_TO_RECO`, `RESOLVED_PAID_OUT`, `CLOSED`, `ENTITLEMENT_CHANGED`.
- **Body**: `kind` oneOf(`CONTACT_ATTEMPT`|`NOTE`|`INTEREST_ACCRUED`|`ENTITLEMENT_CHANGED`|`PARTY_LOCATED`|`RESOLVED_PAID_OUT`|`REMITTED_TO_RECO`|`CLOSED`),
  `eventDate` optional past date, `method` text?(100) and `outcome` text?(1000) — both required for `CONTACT_ATTEMPT`,
  `entitlement` optional oneOf(as #81) — required for `ENTITLEMENT_CHANGED`, `amount` amount — required for
  `INTEREST_ACCRUED`/`REMITTED_TO_RECO` (and for remittance must equal `amountDue`), `reference` text?(300) —
  required for `REMITTED_TO_RECO`/`RESOLVED_PAID_OUT`, `note` text(4000), `documentFileId` uuid?.
- **Response 201**: `UnclaimedView`.
- **Errors**: `422 REMITTANCE_AMOUNT`, `409 POLICY_NOT_APPROVED` (DB: `UNCLAIMED_MONEY_REMITTANCE` off),
  `422 BANK_RULE` (DB: record closed), `403` (BoR), `404`.

#### 84. `GET /api/trust/unclaimed/:id/package`
- **Who**: STAFF.
- **Response 200**: `{ record: UnclaimedView, items: [{ item, ready, detail }], ready, ledger: [{ id, entryType, signed, effectiveDate, receiptNumber, counterparty }], contactAttempts: [...events], note }`.

---

### 6.11 Closing / CDA (4)

Source: `closing/routes.ts`, `closing/service.ts`, `closing/calculate.ts`, `closing/cda-template.ts`.
All `/api/deals/:dealId/closing*` routes are audited.

`ClosingComputation` (`closing/calculate.ts`, **integer cents**): `{ cdaNumber, hstRate (bps), taxName: HST|GST, deal, payer: { kind: SELLER_LAWYER|LANDLORD|COOPERATING_BROKERAGE, name }, closingLawyer, landlord?, incoming: { commission: Taxed, coop: Taxed, totalPayable }, agents: AgentClosingLine[], brokerage: { netEarnedShare, houseSplitBase, feesChargedBase, referral, netHstEstimate, agentPayablesTotal }, trust: { held, deposits, appliedToCommission, balanceDueToLawyer, balanceDueFromLawyer, distributions: TrustDistribution[], balanceAfter }, wires: Wire[], wiresTotal, warnings: string[] }` where `Taxed = { base, hst, total }`.

Closing audit errors (all `422`, thrown when the computation is built — preview, draft CDA and finalize):
`TAX_RATE_UNKNOWN`, `FINTRAC_NOT_APPROVED` (no FINTRAC records on a sale, or any FINTRAC slot not approved;
`details.outstanding`), `NO_AGENTS`, `GCI_SHARES_INVALID`, `TRUST_HOLD_ACTIVE` (422 here, not 423),
`TRUST_SPLIT_ACROSS_ACCOUNTS`, `CLOSING_LAWYER_MISSING` / `LANDLORD_MISSING` / `COOP_BROKERAGE_MISSING`,
`DEPOSIT_NOT_IN_TRUST`, `FUNDS_NOT_CLEARED` (deposit not matched to the bank statement), `TRUST_WILL_NOT_BALANCE`,
`CLOSING_DOES_NOT_RECONCILE`. Warning: `CLOSING_LAWYER_HAS_NO_CONTACT_DETAILS`.

#### 85. `GET /api/deals/:dealId/closing`
- **Who**: STAFF (`TRUST_VIEWERS`; agents cannot view).
- **Response 200**: `ClosingView` = `{ finalized, finalizedAt|null, revision|null, computation: ClosingComputation }` —
  the frozen statement if a CDA is in force, otherwise a live preview.
- **Errors**: `422 DEAL_NOT_FIRM` (preview needs `FIRM` or `CLOSED`), closing audit errors, `404`.

#### 86. `GET /api/deals/:dealId/closing/cda`
- **Who**: STAFF.
- **Query**: `audience` = `lawyer` (default) | `internal` (adds agent statements and the HST position); anything else → `400 VALIDATION_FAILED`.
- **Response 200**: **HTML** (`text/html; charset=utf-8`, `cache-control: private, no-store`,
  `content-security-policy: default-src 'none'; style-src 'unsafe-inline'`) — the issued CDA if finalized, else a `DRAFT`.
- **Errors**: as #85.

#### 87. `POST /api/deals/:dealId/closing/finalize`
- **Who**: BROKER; DB re-checks trust authority on each distribution.
- **Headers**: `Idempotency-Key` (uuid). **Body**: ignored.
- Deal must be `CLOSED`. Posts the trust distributions through the ledger checks, stores the CDA
  (revision `-R<n>` suffix after a void) and creates payout / payable rows.
- **Response 201** (`200` with `replayed: true` for the same key): `FinalizeResult` =
  `{ statementId, cdaNumber, finalizedAt, computationSha, computation: ClosingComputation, trustEntries: LedgerEntry[], replayed }`
  (`trustEntries` is `[]` on replay).
- **Errors**: `422 DEAL_NOT_CLOSED`, `409 ALREADY_FINALIZED`, `409 IDEMPOTENCY_KEY_REUSED` (key used on another deal),
  `422 PRIOR_DISTRIBUTIONS_DIFFER` (`details.posted`, `details.proposed`), `422 TRUST_WILL_NOT_BALANCE`,
  closing audit errors, `423 TRUST_HOLD_ACTIVE`, `409 INSUFFICIENT_TRUST_FUNDS`, `409 FUNDS_NOT_CLEARED`, `404`.

#### 88. `POST /api/deals/:dealId/closing/void`
- **Who**: BROKER.
- **Body**: `reason` text(1000).
- Voids the CDA in force; open approvals are cancelled; payments made carry forward; trust distributions stay unless reversed.
- **Response 200**: `{ "voided": "<cdaNumber>", "cancelledApprovals": 2 }`.
- **Errors**: `404` "Finalized CDA in force for deal".

---

### 6.12 Payouts, payables & commission receipts (11)

Source: `closing/routes.ts`, `closing/payouts.ts`. "Payouts" = agent payouts (`ClosingAgentPayout`);
"payables" = co-op brokerage and referral amounts (`ClosingPayable`). All responses are the deal's
`PayoutsView`:

```
{ closingId, cdaNumber, revision, commissionDue, commissionReceived,
  receipts: [{ id, amount, receivedDate, reference, account: { type: OPERATING|COMMISSION_TRUST, id }|null, bankVerified, reversed }],
  payouts: PayoutLine[] }
PayoutLine = { id, kind: AGENT|COOP_BROKERAGE|REFERRAL, userId|null, payeeName, amount, carriedForward, remaining,
  status: AWAITING_COMMISSION|AWAITING_BANK_VERIFICATION|AWAITING_POLICY_APPROVAL|READY_FOR_APPROVAL|APPROVED|PAID|PAYMENT_RETURNED|NOTHING_OWED,
  approvedAt|null, paidAt|null, paymentReference|null, paymentConfirmed (bool|null), recoveryRequired,
  history: [{ kind, eventDate, amount|null, reference|null, note|null, by }] }
```
`payouts` lists agents first, then payables. The `id` of a line is used in #92–#99 (`/api/payouts/:id/*`
for `kind: AGENT`, `/api/payables/:id/*` for co-op / referral).

#### 89. `GET /api/deals/:dealId/closing/payouts`
- **Who**: STAFF. Audited. **Response 200**: `PayoutsView`. **Errors**: `404` "Finalized CDA in force for deal".

#### 90. `POST /api/deals/:dealId/closing/commission-received`
- **Who**: BANK_STAFF.
- **Body**: `amount` amount, `receivedDate` past date, `reference` text(100),
  `account` object `{ type: oneOf(OPERATING|COMMISSION_TRUST), id: uuid }` (required).
- **Response 201**: `PayoutsView`.
- **Errors**: `422 COMMISSION_OVER_RECEIVED`, `409 POLICY_NOT_APPROVED` (DB: `COMMISSION_TRUST_ACCOUNT` off when type is `COMMISSION_TRUST`), `422 BANK_RULE` (DB), `404`.

#### 91. `POST /api/commission-receipts/:receiptId/reverse`
- **Who**: BANK_STAFF.
- **Body**: `reason` text(1000), `reversedDate` past date, `reference` text?(100).
- **Response 200**: `PayoutsView`. **Errors**: `409 RECEIPT_ALREADY_REVERSED`, `404`.

#### 92 / 93. `POST /api/payouts/:id/approve`, `POST /api/payables/:id/approve`
- **Who**: BROKER; DB: SoD (approver ≠ whoever recorded/matched the commission; override `exceptionReason` + `SOLE_OPERATOR_EXCEPTION`).
- **Body** (optional, `body ?? {}`): `payFrom` optional `{ type: OPERATING|COMMISSION_TRUST, id: uuid }` (default: the single account
  the commission was received into), `balanceStatementId` uuid? (default: latest verified statement of that account),
  `note` text?(1000), `exceptionReason` text?(500).
- **Response 200**: `PayoutsView`.
- **Errors** (422 unless noted): `CDA_VOIDED`, `COMMISSION_NOT_RECEIVED`, `COMMISSION_NOT_CLEARED`,
  `POLICY_NOT_APPROVED` (payables while `THIRD_PARTY_PAYABLES` is off; **422** from the app check, **409** if raised by the DB),
  `NOTHING_OWED`, `409 PAYOUT_ALREADY_APPROVED`, `PAY_FROM_REQUIRED`, `FUNDS_NOT_AVAILABLE` (**422** no verified
  balance; **409** from the DB when available funds are short or a newer balance exists), `409 FUNDS_NOT_CLEARED` (DB), `403`, `404`.

#### 94 / 95. `POST /api/payouts/:id/paid`, `POST /api/payables/:id/paid`
- **Who**: BANK_STAFF; DB: SoD (recorder ≠ approver).
- **Body**: `paidDate` past date, `reference` text(100), `exceptionReason` text?(500).
  Records that the payment was sent; nothing sends money.
- **Response 200**: `PayoutsView`.
- **Errors**: `409 PAYOUT_ALREADY_PAID`, `422 PAYOUT_NOT_APPROVED`, `409 POLICY_NOT_APPROVED` (DB, payables), `403`, `404`.

#### 96 / 97. `POST /api/payouts/:id/payment-reversed`, `POST /api/payables/:id/payment-reversed`
- **Who**: BANK_STAFF.
- **Body**: `date` past date, `reference` text(100), `reason` text(1000).
- **Response 200**: `PayoutsView` (status `PAYMENT_RETURNED`). **Errors**: `422 PAYOUT_RULE` / `BANK_RULE` (DB), `404`.

#### 98 / 99. `POST /api/payouts/:id/cancel`, `POST /api/payables/:id/cancel`
- **Who**: BROKER.
- **Body**: `reason` text(1000).
- **Response 200**: `PayoutsView`. **Errors**: `422 PAYOUT_RULE` (DB), `404`.

---

### 6.13 Commission plans, adjustments & recoveries (10)

Source: `commission/service.ts`.

`PlanList` = `{ userId, inForceToday: versionId|null, versions: [{ id, effectiveFrom, splitBps|null, annualCap|null, capYearStart: { month, day }, fees, reason, source, status: CARRIED_OVER|APPROVED|PROPOSED, proposedBy, approvedBy|null, approvedAt|null }] }`.
`Adjustment` = `{ id, agent, userId, kind: BONUS|DEDUCTION|RECOVERY, description, amount, taxable, recoveryId|null, status: PROPOSED|APPROVED|WITHDRAWN }`.
`Recovery` = `{ id, agent, userId, amount, reason, note, sourceCda|null, outstanding, repayments: [{ amount, paidDate, reference }] }`.

#### 100. `GET /api/agents/:userId/commission-plans`
- **Who**: the agent themself (`userId` = caller), or STAFF. **Response 200**: `PlanList`.

#### 101. `POST /api/agents/:userId/commission-plans`
- **Who**: BANK_STAFF (`ADMIN`, `MANAGING_BROKER`).
- **Body**: `effectiveFrom` date, `splitPct` optional percent(0..100) (stored as basis points), `annualCap` optional amount,
  `capYearStartMonth` optional percent(1..12) whole number (default 1), `capYearStartDay` optional percent(1..28) whole number (default 1),
  `fees` **required** list (max 20, may be empty) of `{ name text(100), amount amount }`, `reason` text(1000).
- **Response 201**: `PlanList`.
- **Errors**: `409 DUPLICATE` (a version already starts that day), `422 BANK_RULE` (DB, e.g. dated on/before an issued closing).

#### 102. `POST /api/commission-plans/:id/approve`
- **Who**: BROKER; DB: SoD (approver ≠ proposer; override with `exceptionReason` + `SOLE_OPERATOR_EXCEPTION`); never the agent (DB).
- **Body** (optional): `exceptionReason` text?(500).
- **Response 200**: `PlanList`. **Errors**: `404`, `403`, `422 BANK_RULE`.

#### 103. `GET /api/deals/:dealId/commission-adjustments`
- **Who**: STAFF. **Response 200**: `Adjustment[]` (bare array).

#### 104. `POST /api/deals/:dealId/commission-adjustments`
- **Who**: BANK_STAFF.
- **Body**: `userId` uuid, `kind` oneOf(`BONUS`|`DEDUCTION`|`RECOVERY`), `description` text(300), `amount` amount,
  `taxable` optional bool (default false; not allowed true for `RECOVERY`), `recoveryId` uuid? — required for `RECOVERY` and only then.
- **Response 201**: `Adjustment[]`. **Errors**: `409 DUPLICATE`, `422 BANK_RULE` (DB: locked once the CDA is issued).

#### 105. `POST /api/commission-adjustments/:id/approve`
- **Who**: BROKER; DB SoD: not whoever added it (no override). Body ignored.
- **Response 200**: `Adjustment[]` (the deal's). **Errors**: `404`, `403`.

#### 106. `POST /api/commission-adjustments/:id/withdraw`
- **Who**: BANK_STAFF. Body ignored. **Response 200**: `Adjustment[]`. **Errors**: `404`.

#### 107. `POST /api/agent-recoveries`
- **Who**: BROKER.
- **Body**: `userId` uuid, `amount` amount, `reason` oneOf(`COMMISSION_RECALLED`|`OVERPAYMENT`|`OTHER`), `note` text(2000), `sourceClosingId` uuid?.
- **Response 201**: `Recovery`.

#### 108. `GET /api/agent-recoveries/:id`
- **Who**: STAFF. **Response 200**: `Recovery`.

#### 109. `POST /api/agent-recoveries/:id/repayments`
- **Who**: BANK_STAFF.
- **Body**: `amount` amount, `paidDate` past date, `reference` text(200).
- **Response 201**: `Recovery`. **Errors**: `404`.

---

### 6.14 Funds & accounting (6)

Source: `accounting/funds.ts`, `accounting/journal.ts`, `accounting/adapter.ts`.

#### 110. `GET /api/funds/availability`
- **Who**: STAFF.
- **Query**: `accountType` = `OPERATING` | `COMMISSION_TRUST`; `accountId` uuid.
- **Response 200**: `FundsAvailability` = `{ account: { type, id }, asOf|null, bankBalance|null, unpresentedPayments, approvedNotSent, returnedStillOwed, obligations: { amount, asOf, source, reference }|null, available|null, blockedBecause: string[], definition }`.
- **Errors**: `422 ACCOUNT_TYPE`, `400 VALIDATION_FAILED` (`accountId`).

#### 111. `POST /api/funds/obligations`
- **Who**: BANK_STAFF. DB: needs the `MANUAL_OBLIGATIONS_PROCEDURE` policy.
- **Body**: `operatingAccountId` uuid, `asOf` past date, `procedureReference` text(500),
  `lines` list (max 500, may be empty) of `{ description text(300), payee text?(200), dueDate date?, amount amount, sourceDocument text(300) }`.
- **Response 201**: `Obligations` = `{ id, operatingAccountId, asOf, amount, source: MANUAL|ACCOUNTING_SYSTEM, sourceReference, lines, preparedBy, attestation: { by, note, at }|null }`.
- **Errors**: `409 POLICY_NOT_APPROVED` (DB).

#### 112. `POST /api/funds/obligations/pull`
- **Who**: BANK_STAFF.
- **Body**: `operatingAccountId` uuid.
- **Response 201**: `Obligations` (source `ACCOUNTING_SYSTEM`).
- **Errors**: `503 ACCOUNTING_NOT_CONNECTED` (always in this release: `server.ts` never configures an adapter),
  `503`/`502 ACCOUNTING_UNAVAILABLE`.

#### 113. `POST /api/funds/obligations/:id/attest`
- **Who**: BANK_STAFF; DB SoD: attester ≠ preparer (override `exceptionReason` + `SOLE_OPERATOR_EXCEPTION`).
- **Body**: `note` text(1000), `exceptionReason` text?(500).
- **Response 200**: `Obligations`. **Errors**: `409 ALREADY_ATTESTED`, `404`, `403`.

#### 114. `GET /api/accounting/journal`
- **Who**: BANK_STAFF. Query is validated before the caller is loaded.
- **Query**: `from` date, `to` date (both required), `format` optional (`csv` → CSV; anything else → JSON). No other query keys allowed.
- **Response 200 JSON**: `{ from, to, entries: JournalEntry[], ready, unmappedRoles: string[] }` where
  `JournalEntry = { sourceId, date, memo, reference|null, lines: [{ role, accountCode|null, debit, credit }], ready }`.
- **Response 200 CSV** (`format=csv`): `text/csv; charset=utf-8`, attachment `journal-<from>-to-<to>.csv`, columns
  `Date,Entry,Memo,Reference,Account role,Account code,Debit,Credit`.

#### 115. `POST /api/accounting/journal/post`
- **Who**: BROKER. Body ignored.
- **Response**: always `409 ACCOUNTING_POSTING_DISABLED`.

---

### 6.15 Dashboards, pipeline, oversight (3)

#### 116. `GET /api/dashboard`
- **Who**: ANY. Source `dashboard/service.ts`. `cache-control: private, no-store`.
- **Response 200**: `DashboardResponse` (**integer cents** in `*Cents` fields):
  `{ viewer: { id, name, role, isPrec }, period: { year, today }, brokerage: BrokerageDashboard|null, personal: PersonalDashboard|null }`.
  `brokerage` for STAFF (financials YTD, trust accounts and balances, deals past closing still holding trust, uncleared deposits,
  `reconciliations: AccountReconStatus[]`, FINTRAC compliance queue for firm deals closing within 14 days);
  `personal` for `AGENT` and `MANAGING_BROKER` (volume, GCI, payouts, PREC HST, cap progress, documents needing revision).
  See the interfaces in `dashboard/service.ts`.

#### 117. `GET /api/pipeline`
- **Who**: ANY; STAFF see all, others only their own listings/deals. Source `pipeline/service.ts`. `cache-control: private, no-store`.
- **Response 200**: `PipelineResponse` = `{ today, month (YYYY-MM), scope: ALL|MINE, columns: { ACTIVE, CONDITIONAL, FIRM, CLOSED: PipelineCard[] } }`;
  `PipelineCard = { id, kind: LISTING|DEAL, href, dealNumber|null, side|null, address, city, mlsNumber|null, agentName|null, priceCents, priceLabel, keyDate: { label, date, daysFromToday }|null, deposit: DepositBadge|null, finalized }`;
  `DepositBadge = { state: CLEARED|AWAITING_BANK|LATE_TO_TRUST|OVERDUE|PARTIAL|DUE|NOT_RECORDED|HELD_ELSEWHERE, tone: good|critical|warning|neutral, label, detail, expectedCents, receivedCents }` (`pipeline/deposit-status.ts`).
  `CLOSED` holds deals closed in the current Toronto calendar month.

#### 118. `GET /api/dashboard/oversight`
- **Who**: `view=broker` → `MANAGING_BROKER`, `COMPLIANCE_ADMIN`; `view=accounting` → `ADMIN`, `MANAGING_BROKER`;
  `view=agent` (default) → ANY (shows the caller's own deals). Source `dashboard/oversight.ts`.
- **Query**: `view` = `broker` | `accounting` | `agent`.
- **Response 200**: `OversightView` = `{ view, asOf, sections: [{ title, metrics: Metric[] }] }`,
  `Metric = { key, label, value (string|number|null), unit: CAD|count|date|days|text, definition, source, asOf, status: ok|attention|critical, items?: string[] }`
  (CAD values are decimal strings).
- **Errors**: `422 UNKNOWN_VIEW`.

---

### 6.16 RECO annual filing (5)

Source: `reco/filing.ts`. Nothing is filed; the broker of record files in MyWeb.

`FilingPackage` = `{ fiscalYear: { start, end }, dueDate, daysToDue, status: SUBMITTED|IN_PREPARATION|READY_FOR_BROKER_TO_FILE, submission: { submittedOn, reference }|null, nonTradingReportSuggested, financialStatements: { CASH…TRUST_INTEREST_RETAINED: { value, source }|null }, checks: string[], trust: [{ account, kind, liabilities, assets, bankBalance }], unclaimed: { unclearEntitlement, ownerCannotBeLocated, heldOverTwoYears, records, source }, bankAccounts: [{ name, institution, branch, accountNumber, type, status }], activity: { closedTrades, source }, attestations: [{ item, statement, basis, exceptions, reviewedBy, reviewNote }], missing: string[], note }`.

`:fiscalYearEnd` is a `YYYY-MM-DD` date; anything else → `404 NOT_FOUND`.

#### 119. `POST /api/reco/filings`
- **Who**: BANK_STAFF (`ADMIN`, `MANAGING_BROKER`).
- **Body**: `fiscalYearStart` date, `fiscalYearEnd` date.
- **Response 201**: `{ fiscalYearStart, fiscalYearEnd, dueDate }`. **Errors**: `409 ALREADY_EXISTS`.

#### 120. `GET /api/reco/filings/:fiscalYearEnd`
- **Who**: STAFF.
- **Query**: `format=csv` → CSV (`text/csv`, attachment `reco-annual-filing-<end>.csv`, columns `Section / item,Value,Source`); otherwise JSON.
- **Response 200**: `FilingPackage`. **Errors**: `404`.

#### 121. `POST /api/reco/filings/:fiscalYearEnd/figures`
- **Who**: BANK_STAFF.
- **Body**: `field` text(100) — one of `CASH`, `TOTAL_ASSETS`, `TOTAL_LIABILITIES`, `EQUITY`, `REVENUE`, `GROSS_PROFIT`, `EXPENSES`,
  `NET_INCOME`, `TRUST_INTEREST_RETAINED`, or `BANK_BRANCH:<account id>`; `amount` decimal string `^-?\d{1,14}(\.\d{1,2})?$`
  (required for financial fields, ignored for branches); `text` text(300) (required for `BANK_BRANCH:`); `source` text(500); `documentFileId` uuid?.
  The latest entry per field wins.
- **Response 201**: `FilingPackage`. **Errors**: `404` (year not set up).

#### 122. `POST /api/reco/filings/:fiscalYearEnd/attestation-reviews`
- **Who**: BROKER; DB: BoR.
- **Body**: `item` oneOf(`TRUST_SUFFICIENCY`|`SEPARATION_OF_FUNDS`|`MONTHLY_RECONCILIATIONS`|`SHORTFALLS_REPORTED`|`NOTICE_OF_CHANGES`|`ACCURACY`), `note` text(2000).
- **Response 201**: `FilingPackage`. **Errors**: `409 ALREADY_EXISTS`, `403`.

#### 123. `POST /api/reco/filings/:fiscalYearEnd/submission`
- **Who**: BROKER; DB: BoR.
- **Body**: `submittedOn` past date, `reference` text(200), `note` text?(2000).
- **Response 201**: `FilingPackage` (status `SUBMITTED`). **Errors**: `409 ALREADY_EXISTS`, `403`.

---

### 6.17 Governance: broker of record, financial policies, business calendar (7)

Source: `bank/governance.ts`, `bank/routes.ts`.

#### 124. `GET /api/broker-of-record`
- **Who**: STAFF.
- **Response 200**: `{ "designations": [{ id, userId, name, role: BROKER_OF_RECORD|DESIGNATED_SUBSTITUTE, effectiveFrom, effectiveTo|null, activeToday, reference, recordedBy }] }`.

#### 125. `POST /api/broker-of-record`
- **Who**: BANK_STAFF; DB: recorded by someone other than the designee (`403`).
- **Body**: `userId` uuid, `role` oneOf(`BROKER_OF_RECORD`|`DESIGNATED_SUBSTITUTE`), `effectiveFrom` date, `effectiveTo` date?, `reference` text(500).
- **Response 201**: `{ "id": "uuid" }`. **Errors**: `403`, `422 BANK_RULE` (DB).

#### 126. `POST /api/broker-of-record/:id/end`
- **Who**: BANK_STAFF.
- **Body**: `effectiveTo` date.
- **Response 200**: `{ id, effectiveTo }`. **Errors**: `404`, `403`/`422` (DB).

#### 127. `GET /api/financial-policies`
- **Who**: STAFF.
- **Response 200**: `{ "policies": [{ policy, description, enabled, history: [{ enabled, reference, note, decidedBy, decidedAt }] }] }` for
  `SOLE_OPERATOR_EXCEPTION`, `THIRD_PARTY_PAYABLES`, `COMMISSION_TRUST_ACCOUNT`, `CIVIC_HOLIDAY_IS_HOLIDAY`,
  `UNCLAIMED_MONEY_REMITTANCE`, `MANUAL_OBLIGATIONS_PROCEDURE` (all off until decided).

#### 128. `POST /api/financial-policies`
- **Who**: BROKER; DB: BoR.
- **Body**: `policy` oneOf(the six keys), `enabled` bool, `reference` text(500) (the counsel/accountant sign-off), `note` text?(2000).
- **Response 200**: the one policy object (as in #127).

#### 129. `GET /api/business-calendar`
- **Who**: STAFF (the proclaimed-holiday list requires `TRUST_VIEWERS`).
- **Query**: `year` (default current Toronto year).
- **Response 200**: `{ year, civicHolidayCounted, holidays: [{ date, name }], proclaimed: [{ date, name, reference, addedBy, addedAt }], rule }`.
  (A non-integer `year` computes 2026's holidays and echoes `year` as `null`.)

#### 130. `POST /api/business-calendar/proclaimed`
- **Who**: BROKER; DB: BoR.
- **Body**: `date` date, `name` text(200), `reference` text(500).
- **Response 201**: `{ date, name, reference }`. **Errors**: `409 HOLIDAY_EXISTS`.

---

### 6.18 Privacy (6)

Source: `security/privacy.ts`. Nothing is deleted or sent.

`Breach` = `{ id, discoveredAt, description, informationInvolved, individualsAffected|null, realRiskOfSignificantHarm|null, closed, outstanding: string[], keepUntil, events: [{ kind, eventDate, reference, note }] }`.

#### 131. `POST /api/privacy/breaches`
- **Who**: STAFF.
- **Body**: `discoveredAt` past date, `occurredFrom` date?, `occurredTo` date?, `description` text(4000),
  `informationInvolved` text(2000), `individualsAffected` optional percent(0..10,000,000) (a count).
- **Response 201**: `Breach`.

#### 132. `GET /api/privacy/breaches/:id`
- **Who**: STAFF. **Response 200**: `Breach`.

#### 133. `POST /api/privacy/breaches/:id/events`
- **Who**: STAFF.
- **Body**: `kind` oneOf(`NOTE`|`CONTAINED`|`RISK_ASSESSED`|`OPC_REPORTED`|`INDIVIDUALS_NOTIFIED`|`ORGANIZATIONS_NOTIFIED`|`CLOSED`),
  `eventDate` optional past date, `realRiskOfSignificantHarm` optional bool — required for `RISK_ASSESSED`,
  `reference` text?(200) — required for `OPC_REPORTED`/`INDIVIDUALS_NOTIFIED`, `note` text(4000).
- **Response 201**: `Breach`. **Errors**: `404`.

#### 134. `POST /api/privacy/legal-holds`
- **Who**: STAFF.
- **Body**: `dealId` uuid? (omit for a brokerage-wide hold), `reason` text(1000).
- **Response 201**: `{ id, dealId|null, reason }`.

#### 135. `POST /api/privacy/legal-holds/:id/release`
- **Who**: `MANAGING_BROKER`, `COMPLIANCE_ADMIN`.
- **Body**: `note` text(1000).
- **Response 200**: `{ "released": "<id>" }`. **Errors**: `404` "Active legal hold".

#### 136. `GET /api/privacy/retention-report`
- **Who**: STAFF.
- **Response 200**: `{ asOf, rules: [{ recordType, retentionYears, startsFrom, legalBasis }], brokerageWideHold, eligibleForDisposalReview: [{ id, dealNumber, closeDate, status }] (max 500), note }`.

---

### 6.19 Ops, health, audit export (3)

Source: `ops/health.ts`. Subject to the per-IP rate limit; no auth on the first two.

#### 137. `GET /healthz`
- **Who**: anyone. **Response 200**: `{ "status": "ok" }`.

#### 138. `GET /readyz`
- **Who**: anyone.
- **Response 200**: `{ "status": "ready", "migration": "018_leases.sql" | "untracked" }`.
- **Response 503**: `{ "status": "not_ready", "reason": "database is at <x>, this release needs 018_leases.sql" | "database unreachable" }`
  (not the error envelope).

#### 139. `GET /api/audit/export`
- **Who**: STAFF. Audited.
- **Query**: `from` date, `to` date (Toronto days, inclusive), `format` optional `json` (default) | `csv`. No other keys.
- **Response 200 JSON**: `{ from, to, count, truncated (true at 100,000 rows), entries: [{ id, at, userId|null, entity, entityId, action, outcome|null, ip|null, route|null }] }`.
- **Response 200 CSV**: `text/csv; charset=utf-8`, attachment `audit-<from>-to-<to>.csv`, columns `id,at,userId,entity,entityId,action,outcome,ip,route`.

---

### 6.20 Lists, look-ups and work queues (12, added 2026-10-19)

Source: `directory/routes.ts`. These are read-only, except the two set-up actions marked. Permissions follow the rules above.

| Route | Who | Returns |
|---|---|---|
| `GET /api/users?role=&includeInactive=true` | ANY | STAFF: `{ users: [{ id, email, firstName, lastName, role, phone, isActive, recoRegistrationNo, isPrec, precLegalName, hstNumber, passwordSet, mfaEnabled, locked, createdAt }] }`. Agents: active agents and brokers, `{ id, firstName, lastName, role }` only. |
| `POST /api/users/:id/profile` (set-up) | ADMIN | Body: any of `firstName`, `lastName`, `phone`, `role` (not your own), `recoRegistrationNo`, `isPrec`, `precLegalName`, `hstNumber`. Returns `{ user }`. A role change ends that user's sessions. |
| `GET /api/deals?q=&status=&side=` | DEAL (agents: own deals) | `{ deals: [{ id, dealNumber, side, status, streetAddress, unit, city, mlsNumber, offerDate, closeDate, salePrice, trustDepositHolder, agents: [names] }], truncated }`. `q` searches deal number, address, city, MLS® and party names. Max 200. |
| `GET /api/deals/:dealId` | DEAL | `{ deal: { …all deal terms, commission figures, agents: [{ userId, name, role, splitPct, gciSharePct, isPrec, precLegalName }], parties: [{ id, role, entityType, fullName, email, phone, representation }], cda: { cdaNumber, revision, finalizedAt, voided } \| null } }` |
| `GET /api/trust/accounts` | STAFF | `{ accounts: [{ id, name, kind, bankName, accountLast4, isActive, balance }] }` (ledger balance) |
| `POST /api/trust/accounts` (set-up) | BROKER | Body: `name`, `bankName`, `accountLast4` (4 digits), `kind` (`REAL_ESTATE_TRUST` default, or `COMMISSION_TRUST`). 201 `{ account }`. |
| `GET /api/operating-accounts` | BANK_STAFF | `{ accounts: [{ id, name, bankName, accountLast4, isActive }] }` |
| `GET /api/bank/statements?accountId=` | STAFF | `{ statements: [{ id, kind, account: { type, id, name }, periodStart, periodEnd, closingBalance, fileName, importedAt, importedBy, verified: { at, by } \| null }] }` |
| `GET /api/trust/reconciliations?trustAccountId=` | STAFF | `{ reconciliations: [{ id, trustAccountId, trustAccountName, statementId, periodEnd, isBalanced, difference, status, preparedAt, preparedBy, signedAt, signedBy }] }` |
| `GET /api/work/approvals` | BANK_STAFF | `{ payouts: [{ dealId, dealNumber, address, line: PayoutLine, action }], plans: [...], adjustments: [...], statements: [unverified], reconciliationsToSign: [...] }`. Payout states come from `getPayouts`. |
| `GET /api/work/reviews` | REVIEWERS | `{ items: [{ slotId, document, fintrac, party, dealId, dealNumber, address, closeDate, uploadedAt, uploadedBy, fileId }] }`, oldest upload first. |

Also: `POST /api/deals/:dealId/trade-record/sign` now checks deal access in the app as well as the database (gap 5 below, fixed).
First admin on a fresh install: `backend/scripts/create-first-admin.ts` prints a one-time invitation link (`/accept-invite#token=…`).

## Route count verification

Command (run from the repository root):

```sh
grep -rEn "app\.(get|post|put|patch|delete|route|all)\b" backend/src --include=*.ts | grep -v '\.test\.ts' | wc -l
# → 132
```

132 registration call sites. One of them, in `backend/src/closing/routes.ts`, is inside a loop:

```ts
for (const [collection, kind] of [["payouts", "payout"], ["payables", "payable"]] as const)
  for (const [action, handler] of Object.entries(actions))   // approve, paid, payment-reversed, cancel
    app.post(`/api/${collection}/:id/${action}`, …)
```

It registers 2 × 4 = 8 routes, so the total is 132 − 1 + 8 = **139**, which matches the 139 routes
numbered in §6 (#1–#139). There are no `app.route(…)` or `app.all(…)` calls. The `.register(` calls
in `app.ts` (17 plugins) and `compliance/routes.ts` (`@fastify/multipart`) register plugins, not routes.

Per-file call sites (routes in brackets where different): `security/http.ts` 16, `compliance/routes.ts` 10,
`deals/lifecycle.ts` 10, `obligations/service.ts` 12, `deals/trade-record.ts` 5, `trust/routes.ts` 10,
`bank/routes.ts` 22, `bank/unclaimed.ts` 6, `closing/routes.ts` 8 [15], `commission/service.ts` 10,
`accounting/funds.ts` 6, `dashboard/routes.ts` 1, `pipeline/routes.ts` 1, `dashboard/oversight.ts` 1,
`reco/filing.ts` 5, `security/privacy.ts` 6, `ops/health.ts` 3.

Per area in this document: Auth & users 16, Notifications 3, Deals & lifecycle 12, Documents 5,
Obligations 12, Trade record 5, Trust ledger 10, Bank 8, Reconciliation & incidents 7, Unclaimed 6,
Closing 4, Payouts 11, Commission 10, Funds & accounting 6, Dashboards 3, RECO 5, Governance 7,
Privacy 6, Ops 3 = 139.

---

## Gaps and ambiguities

Things a frontend developer may expect but the code does not provide, or could not be fully determined
from the TypeScript:

1. **No self-service password reset request.** Resets are issued by an admin (#13) and the token is
   returned in the API response for out-of-band delivery; there is no e-mail sending.
2. **Missing read/list endpoints**: no `GET /api/users` (user list), no `GET /api/deals` or
   `GET /api/deals/:dealId` (deal detail; use the pipeline, documents, lifecycle, obligations and trust
   views), no list of trust accounts or operating accounts (only via `GET /api/dashboard` brokerage section and
   `/api/trust/reconciliation-status`), no list of bank statements, reconciliations, commission plans across
   agents, recoveries, breaches, legal holds, RECO filing years or obligations snapshots. No route creates a
   trust account or a listing, or waives a document slot.
3. **Exact per-field requirements of disclosures (#39)** and some rules (offer acceptance, designations,
   commission plan dating, bank match rules, payout rules) live in database CHECKs/triggers; only the
   resulting error codes are documented here. The `BANK_RULE` (422) message text is the authoritative
   explanation for the user.
4. **Database errors vs app errors for the same code**: `POLICY_NOT_APPROVED` and `FUNDS_NOT_AVAILABLE` are
   422 when raised by the app (payout approval pre-checks) but 409 when raised by the database; the frontend
   should key on `code`, not status.
5. `POST /api/deals/:dealId/trade-record/sign` (#52) has no application-level role or deal check; only the
   database restricts it to the deal's agents.
6. `POST /api/deals/:dealId/amendments` accepts a `description` key but never stores or uses it.
7. `exceptionReason` on the agent trade-record signature is read but not used.
8. `TRUST_HOLD_ACTIVE` is 423 from the trust ledger but 422 from the closing calculator.
9. Unknown routes return Fastify's default 404 body, not the `{ error: … }` envelope.
10. The SSE hub is in-process; with more than one server instance, notifications only reach clients on the
    instance that created them. The stream does not replay missed events (`Last-Event-ID` ignored).
11. `POST /api/funds/obligations/pull` always fails with `503 ACCOUNTING_NOT_CONNECTED` in this release
    (no accounting adapter is wired in `server.ts`), and `POST /api/accounting/journal/post` is always 409.
12. Some unique/foreign-key violations are not translated and surface as `500 INTERNAL` (e.g. admin MFA reset
    for a user with no credential row; duplicate broker-of-record designations, depending on DB constraints).
13. The exact list of TRESA/FINTRAC `Finding.rule` identifiers and their messages is in
    `obligations/tresa.ts` and `obligations/fintrac.ts` and is not reproduced here.
