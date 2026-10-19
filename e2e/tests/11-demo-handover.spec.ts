/**
 * The demo handover (backend/scripts/demo-handover.ts): every demo account gets a fresh one-time link, the old
 * passwords and sessions stop working, and following the link leads to a new password and two-factor setup.
 * Runs last: it ends every session the journey made. ops/local-trial.sh demo runs the script itself instead.
 */
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { enrolMfa, PEOPLE, person } from "../lib/people.ts";

test.skip(!!process.env.E2E_BASE_URL, "the demo runs the handover itself, after this suite");

test("handover: one link per account; the old password no longer works; the link sets a new one and two-factor", async ({ page }) => {
  const out = execFileSync("node", ["scripts/demo-handover.ts", "--app-url", "http://localhost:8080"], {
    cwd: new URL("../../backend", import.meta.url).pathname,
    env: { ...process.env, NODE_ENV: "development", DATABASE_URL: readFileSync(new URL("../.state/app-database-url", import.meta.url), "utf8").trim() },
    encoding: "utf8",
  });
  const links = [...out.matchAll(/\/reset-password#token=[\w-]+/g)].map((m) => m[0]);
  expect(links).toHaveLength(Object.keys(PEOPLE).length);

  await page.goto("/");
  await page.getByLabel("Email").fill(PEOPLE.broker.email);
  await page.getByLabel("Password").fill(person("broker").password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/email or password/i)).toBeVisible(); // the journey's password is gone
  await page.goto(links[0]!); // the broker's link (listed first) sets a new one, and two-factor starts over
  const password = "Escarpment sunrise over Grimsby harbour";
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Type it again").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await page.getByRole("button", { name: "Go to sign in" }).click();
  await page.getByLabel("Email").fill(PEOPLE.broker.email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await enrolMfa(page, "broker");
  await expect(page.getByRole("heading", { name: "Brokerage overview" })).toBeVisible();
});
