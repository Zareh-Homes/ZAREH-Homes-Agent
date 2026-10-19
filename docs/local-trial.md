# Try it free on your own computer

The whole back office (database, app, web screens) runs on your computer. Same sign-in, two-factor, permissions
and money rules as a hosted setup; only https and a public address are missing. Fictional data only.

## Once

1. Install **Docker Desktop** (free for small businesses): https://www.docker.com/products/docker-desktop/
   Open it and let it finish starting.
2. Get the code: on GitHub, the repository's green **Code** button → **Download ZIP** (branch
   `claude/realestate-brokerage-schema-sfn0i9`), and unzip it. Or `git clone` if you use git.

## Start

Open **Terminal** (Mac) in the unzipped folder and run:

```sh
ops/local-trial.sh
```

On Windows, use the **WSL** (Ubuntu) terminal that Docker Desktop offers, in the same folder.

The first start takes a few minutes. It ends by printing a link like
`http://localhost:8080/accept-invite#token=…`. Open it in Chrome, set your password, and set up two-factor with
your phone's authenticator app. You're the admin.

Then work through `docs/pilot-test-checklist.md`. For the second person the system requires (a different person
must approve, verify or sign), invite a plus-address of your email and use a second browser (or a private window).

## Or: a demo brokerage, already filled in

```sh
ops/local-trial.sh demo
```

Builds the same app, then fills it with a fictional brokerage (two agents, five deals including a lease, documents,
deposits, a CDA, commission plans, a paid payout and a signed reconciliation) and prints a sign-in link for each demo
person. Follow `demo-walkthrough.md`. It erases any earlier trial data.

## Stop, restart, erase

- `ops/local-trial.sh stop`: stops it; your test data stays.
- `ops/local-trial.sh`: starts it again (no new link; sign in at http://localhost:8080).
- `ops/local-trial.sh reset`: erases everything and starts over next time.

## Limits

- Only on that computer. Your phone can't reach it, so do the phone part of the checklist on the hosted staging.
- No https; the hosted setup adds it.
- Don't enter real client names, ID or bank details: this computer isn't set up to hold them.
