import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { acceptInvite, invite, person, signIn, signInWithPassword, shot } from "../lib/people.ts";

test.describe.configure({ mode: "serial" });

test("first admin: invitation link → password → two-factor setup → back office", async ({ page }) => {
  const link = readFileSync(new URL("../.state/admin-invite", import.meta.url), "utf8").trim();
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await shot(page, "01-set-password");
  await acceptInvite(page, "admin", link);
  await expect(page.getByRole("heading", { name: "Brokerage overview" })).toBeVisible();
  await shot(page, "02-admin-dashboard");
});

test("a used invitation link can't be used again", async ({ page }) => {
  const link = readFileSync(new URL("../.state/admin-invite", import.meta.url), "utf8").trim();
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await page.getByLabel("New password").fill("another long passphrase here");
  await page.getByLabel("Type it again").fill("another long passphrase here");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("You can sign in now")).toHaveCount(0);
});

test("wrong password is refused with a clear message", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(person("admin").email);
  await page.getByLabel("Password").fill("not the right password at all");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/email or password/i)).toBeVisible();
  await shot(page, "03-sign-in-error");
});

test("two-factor: a wrong code is refused; the right one signs in", async ({ page }) => {
  await page.goto("/");
  await signInWithPassword(page, "admin");
  await expect(page.getByRole("heading", { name: "Two-factor sign-in" })).toBeVisible();
  await page.getByLabel("Authenticator code").fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That code didn't match" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Two-factor sign-in" })).toBeVisible();
  await shot(page, "04-mfa-wrong-code");
  await page.getByRole("button", { name: "Sign in as someone else" }).click();
  await signIn(page, "admin", { fresh: true });
});

test("admin invites the broker, compliance admin and an agent; each sets up their account", async ({ browser }) => {
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await signIn(admin, "admin");
  for (const who of ["broker", "compliance", "agent"] as const) {
    const link = await invite(admin, who);
    if (who === "broker") await shot(admin, "05-invitation-link");
    await admin.getByRole("button", { name: "Done" }).click();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await acceptInvite(page, who, link);
    await ctx.close();
  }
  await admin.goto("/admin");
  for (const email of ["broker@e2e.test", "compliance@e2e.test", "agent@e2e.test"]) await expect(admin.getByText(email)).toBeVisible();
  await shot(admin, "06-admin-people");
  await adminCtx.close();
});

test("two-factor: a recovery code works once", async ({ page }) => {
  const code = person("compliance").recovery![0]!;
  for (const attempt of [1, 2]) {
    await page.goto("/");
    await signInWithPassword(page, "compliance");
    await page.getByRole("button", { name: "I can't use my authenticator app" }).click();
    await page.getByLabel("Recovery code").fill(code);
    await page.getByRole("button", { name: "Verify" }).click();
    if (attempt === 1) {
      await expect(page.getByText("9 recovery codes left")).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Sign out" }).click();
    } else {
      await expect(page.getByText("You can sign in now")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Two-factor sign-in" })).toBeVisible();
      await expect(page.getByRole("alert")).toBeVisible();
    }
  }
});

test("signing out ends the session on the server", async ({ page, context }) => {
  await signIn(page, "agent", { fresh: true });
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const res = await context.request.get("/api/auth/me");
  expect(res.status()).toBe(401);
});
