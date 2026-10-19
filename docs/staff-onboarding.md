# Staff onboarding (staging trial)

How each person gets a sign-in on the staging host. Staging holds **synthetic data only**.

## 1. First admin (once, at installation)

Whoever deploys runs, against the staging database:

```sh
node scripts/create-first-admin.ts --email you@zarehhomes.ca --first <first> --last <last> --app-url https://<staging host>
```

It prints a one-time link (valid 72 hours, works once). It refuses once an admin has set a password.

## 2. Everyone else (the admin, from the app)

1. **Admin → People → Invite someone.** Name, work email, role:
   - **Managing broker**: approves payouts, signs reconciliations, records trust money. Two-factor required.
   - **Admin**: imports bank files, records commission and payments, invites people. Two-factor required.
   - **Compliance admin**: reviews documents and FINTRAC records. Two-factor required.
   - **Agent**: their own deals only.
2. The screen shows a one-time link **once**. Send it by a channel you trust (a text to their phone, not a shared inbox).
3. The person opens it, chooses a password (12+ characters), and if their role needs it, sets up two-factor:
   scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password),
   type the 6-digit code, and **save the 10 recovery codes** somewhere safe.
4. **Admin → Broker of record & accounts → Record a designation**: someone other than the broker of record records
   Daniel's designation (with the RECO reference). Without it, trust and reconciliation actions are refused.

## Lost access

- **Forgot password**: an admin uses *Password reset link* on their row; same one-time link process.
- **Lost phone**: sign in with a recovery code; or an admin uses *Reset two-factor* and they set it up again.
- **Someone leaves**: *Suspend*. They're signed out at once.

## Test sign-ins for the trial

Create one account per real person (not shared). For trying roles you don't hold, use plus-addresses of your own
email (`daniel+agent@…`, `daniel+compliance@…`) so each test login is still yours and goes to your inbox. Suspend
them after the trial.
