# Open-source reuse audit (2026-10-19)

Read-only review of nine public repositories against this platform. Each was cloned at a pinned commit and its
source, tests, dependencies and license files were read. Nothing from them was installed, built or run, and no code
in this repository was changed.

## Verdict

**Proceed with the existing application.** No repository justifies replacing anything. Five small, low-risk
improvements are worth considering, and only the first is a candidate before staging. Every financial, trust and
compliance control stays as it is.

## Evidence by repository

| Repository (pinned commit, date) | License verified | What it is | Recommendation |
|---|---|---|---|
| pdfme/pdfme `d3dba92` 2026-10-19 | MIT, "© 2020 HandDot"; bundled pdf-lib fork MIT "© 2019 Andrew Dillon"; embedded Roboto font (Apache-2.0/OFL) has no notice in the repo | PDF template designer and generator; 97 test files | **KEEP EXISTING** CDA and TRS. The CDA is already stored immutably at finalize as self-contained HTML with a SHA-256 of the computation. Rebuilding it as coordinate-based PDF templates would take 4–6 days, add about 20 server dependencies (including browser UI packages pulled in by `@pdfme/schemas`) and a template expression interpreter in the financial record path. Use it only if a true PDF CDA is ever required, with every `@pdfme/*` version pinned (its peers float on `latest`). |
| wojtekmaj/react-pdf `8a50185` 2026-10-16 | MIT "© 2017–2026 Wojciech Maj"; pulls pdf.js (Apache-2.0, NOTICE required) | In-page PDF viewer; 14 specs | **Not usable now:** v11 requires React 19 (`peerDependencies: react ^19.0.0`), and we run 18.3.1. It is also about 1 MB+ of pdf.js, needs a self-hosted worker and CSP changes, and doesn't handle JPEG/PNG. See improvement 1 for a no-dependency alternative. |
| shadcn-ui/ui `daaf156` 2026-10-18 | MIT "© 2023 shadcn" | Copy-in components on Radix/Base UI, cva, tailwind-merge, lucide | **KEEP EXISTING** kit. The current registry targets React 19 (forwardRef removed: refs would be silently dropped on React 18) and its own theme tokens. Its simple components add nothing over `ui/kit.tsx`, which already has labelled fields, `aria-invalid`, `aria-describedby`, `aria-busy` buttons and alert/status notices. Its complex ones (dialogs, custom selects) conflict with our deliberate inline forms and native selects (better on phones), and would break the 244 role/label lookups in the browser tests. About 4–8 days for a restyle. |
| TanStack/table `95c4768` 2026-10-12 | MIT "© 2016 Tanner Linsley" | Headless table state (v9) | **KEEP EXISTING.** Lists are filtered on the server, with at most 200 deals. Bank lines are tens to hundreds and must stay in statement order for reconciliation. It ships no `aria-sort` markup. If staff ask for column sorting: about half a day in our own `Table`, no new dependency. |
| clauderic/dnd-kit `01bc678` 2026-10-15 | MIT "© 2021 Claudéric Demers" | Drag and drop (pre-1.0, 0.5.1) | **Don't adopt.** Pipeline columns are read-only views. Moving a deal (firm, closed, terminated) is a legal event entered through a form with required fields. Dragging would bypass or duplicate that, and it fights the board's swipe-between-columns layout on phones. |
| better-auth/better-auth `f9ac706` 2026-10-19 | MIT "© 2024 Bereket Engida"; all 22 packages MIT | Auth framework; 345 test files | **KEEP EXISTING.** Ours is equal or stronger where it matters: SameSite=Strict cookies (theirs default to Lax), an explicit CSRF token on top of the origin check, TOTP replay refusal, and hashed recovery codes. Migrating would mean reworking the user and session schema, invitations, audit and encryption, plus about 17 new dependencies. Worth porting: their breached-password check (improvement 2) and, later, their database-backed rate limiter (improvement 5). |
| bbl-dres/transaction-portal `f84e6ce` 2026-10-14 | MIT "© 2025 Digital Real Estate und Support" | Static vanilla-JS mockup ("not intended for production use"); Swiss federal properties; no tests | **KEEP EXISTING.** Ideas only: a stage stepper that names who's responsible at each stage (improvement 4), and filters kept in the address bar so a view can be shared. |
| orteug/agency-os `344176f` 2026-06-17 | MIT "© 2026 Ariel Ortiz" | 60 Markdown prompt files, no code ("This is not software"); US/Texas examples | **KEEP EXISTING** deterministic oversight. Its daily-brief tiers (🔴 within 24 h or overdue, 🟡 within 72 h, "decisions, not status updates") are a good spec for wording (improvement 3). AI judgements of risk can't serve as compliance evidence. |
| prolinkinfo/RealEstateCRM `a770042` 2025-01-31 | **Unclear: treat as unlicensed.** No LICENSE file; README says MIT; `server/package.json` says ISC; no copyright holder | MERN CRM; no tests, no CI | **Do not reuse.** Serious security flaws: hardcoded JWT secret (`"secret_key"`), unauthenticated super-admin registration, any user can change roles, NoSQL query injection from `req.query`, mass assignment, open CORS. Front-office CRM scope anyway. |

## Top five improvements (none required for staging)

| # | Improvement | Source | Value | Effort | Regression risk | Upkeep | Before staging? |
|---|---|---|---|---|---|---|---|
| 1 | **Inline document preview** in the review queue and Documents tab: the browser's own PDF viewer in a sandboxed frame, `<img>` for JPEG/PNG; needs an inline variant of the file endpoint (today it downloads) | Our own; react-pdf rejected | High for the compliance reviewer (no downloads of ID documents to a laptop) | 0.5–1 day | Low (new view; the downloads stay) | None (no dependency) | **Candidate**: small and reduces ID files on staff computers |
| 2 | **Breached-password check** at invite, reset and password change (k-anonymity: only 5 characters of a hash leave the server) | better-auth `plugins/haveibeenpwned` (MIT, technique ported) | Medium–high security | 0.5 day | Low | Low (one outbound HTTPS host) | Before production |
| 3 | **Daily-brief tiers and wording** on the broker oversight page: due within 24 h or overdue / within 72 h, phrased as decisions | agency-os rules (MIT, spec only) | Medium usability | 1 day | Low (display only) | Low | After staff feedback |
| 4 | **Deal stage stepper** with who's responsible at each step | transaction-portal (idea only) | Medium usability | 1 day | Low | Low | After staff feedback |
| 5 | **Database-backed rate limiter** (today it's in memory, correct only on one server) | better-auth guarded-update pattern | Needed only with more than one app instance | 1 day | Low | Low | Before scaling past one instance |

## Not recommended

Replacing the UI kit (shadcn/ui), tables (TanStack), pipeline interaction (dnd-kit), CDA/TRS rendering (pdfme),
document viewer (react-pdf, until a React 19 upgrade has its own reason), authentication (better-auth), or adopting
anything from RealEstateCRM.

## Licensing notes if any code is ever copied

Keep the MIT copyright and license text for copied code. pdf.js (Apache-2.0) and the Roboto font need their own
notices. Ideas and techniques borrowed without copying code (improvements 2–5) need no notice; improvement 2's
source is credited in a code comment anyway.
