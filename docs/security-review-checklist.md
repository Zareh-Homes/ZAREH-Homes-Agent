# Security review checklist

Status key: **Done (tested)** = built and covered by an automated test. **Done (manual)** = checked by hand in this environment. **Open** = not done. **External** = needs someone outside this project.

> **No independent penetration test or external security review has been performed.** Nothing below replaces one.

## Authentication and sessions

| Check | Status | Evidence |
|---|---|---|
| Client-supplied user id or role is never trusted | Done (tested) | `auth.int.test.ts` "a client-supplied user id is never trusted"; production smoke test: forged `x-user-id` → 401 |
| Passwords hashed with scrypt; reset links single-use | Done (tested) | `auth.int.test.ts` |
| MFA (TOTP) required for privileged roles; codes not replayable; recovery codes single-use | Done (tested) | `auth.int.test.ts` |
| Lockout after 10 failures; same answer for unknown emails | Done (tested) | `auth.int.test.ts` |
| Rate limit: >5 attempts/min per email refused | Done (tested) | `auth.int.test.ts` |
| Idle timeout 30 min; logout ends the session; suspension/role change ends sessions at once | Done (tested) | `auth.int.test.ts` |
| CSRF: cookie alone can't change anything | Done (tested) | `auth.int.test.ts` |
| Dev auth header refused in production | Done (tested + manual) | `check-config.ts`; CI step "refuses an unsafe configuration" |
| SSO / hardware keys | Open | Not built; TOTP only |

## Authorization

| Check | Status | Evidence |
|---|---|---|
| Agents can't see or touch other agents' deals through any route | Done (tested) | `access.int.test.ts` |
| Money and compliance actions checked in the database too | Done (tested) | `money-controls.int.test.ts` restricted-role tests |
| Segregation of duties (record ≠ approve ≠ pay; prepare ≠ sign) | Done (tested) | `money-controls.int.test.ts`, `uat.int.test.ts` A |
| App role can't edit history, disable triggers or bypass rules | Done (tested) | `money-controls.int.test.ts` "restricted database role…" |
| App refuses to start as a superuser | Done (manual) | production smoke test |

## Data protection

| Check | Status | Evidence |
|---|---|---|
| ID numbers and receipt-of-funds payer details encrypted (AES-256-GCM, separate key) | Done (tested) | `access.int.test.ts`, `obligations.int.test.ts` |
| Uploaded files encrypted at rest; type checked by content | Done (tested) | `compliance.int.test.ts` |
| Every view of sensitive data audited | Done (tested) | `access.int.test.ts` |
| Backups encrypted (age); unencrypted backups refused | Done (manual) | `ops/backup.sh`; tampered backup refused |
| Logs carry ids only, no personal or banking data | Done (manual) | JSON log review in smoke test |
| Key rotation procedure | Open | Keys are env secrets; no re-encryption tool yet |

## Transport and browser

| Check | Status | Evidence |
|---|---|---|
| HSTS, CSP, X-Frame-Options, nosniff, Referrer-Policy | Done (tested) | `auth.int.test.ts` "security headers" |
| TLS termination and redirect | Done (config only) | `ops/nginx.conf`; not exercised against a real certificate here |
| Database over TLS (`verify-full`) | Done (config only) | `ops/env/production.env.example` |

## Supply chain

| Check | Status | Evidence |
|---|---|---|
| Exact dependency versions, lockfiles committed | Done | `package-lock.json` per package |
| `npm audit`, backend production dependencies | **Open: 4 high** | All in Prisma's own tooling (`@prisma/config` → `effect`, `deepmerge-ts`). The fix is the Prisma 7 major upgrade. They are not in a request path, but they ship with the client. CI fails on any other high/critical advisory; these two (GHSA-ggr8-5vv4-36mx, GHSA-38f7-945m-qr2g) are listed in `backend/scripts/audit-gate.ts` as accepted open findings, and the gate also fails once they disappear so the list can't go stale. |
| `npm audit`, frontend | Open: dev-only findings | vitest/vite/esbuild dev server; fixes need major upgrades. Nothing ships to the browser bundle. |
| Secret scanning | In CI (gitleaks) | Not run locally in this environment |
| Container image scan | Open | Images weren't built here (no Docker daemon) |

## External (none done)

- [ ] Independent penetration test of staging, including auth, IDOR, file upload, CSRF and session handling
- [ ] Review of the hosting account (IAM, network, backups, logging)
- [ ] Privacy review by counsel (PIPEDA; retention schedule)
- [ ] Re-test after Prisma 7 upgrade
