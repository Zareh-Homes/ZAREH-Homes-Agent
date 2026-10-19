/**
 * The people in the journey and how to sign in as each. Passwords and
 * authenticator secrets are made during the run (accept-invite, MFA setup)
 * and kept in .state/people.json for the later test files.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { totp } from "./totp.ts";

export type Who = "admin" | "broker" | "compliance" | "agent";
export interface Person { email: string; first: string; last: string; role: string; password: string; secret?: string; recovery?: string[] }

const FILE = new URL("../.state/people.json", import.meta.url);

export const PEOPLE: Record<Who, Omit<Person, "password">> = {
  admin: { email: "admin@e2e.test", first: "Avery", last: "Admin", role: "ADMIN" },
  broker: { email: "broker@e2e.test", first: "Blake", last: "Broker", role: "MANAGING_BROKER" },
  compliance: { email: "compliance@e2e.test", first: "Casey", last: "Compliance", role: "COMPLIANCE_ADMIN" },
  agent: { email: "agent@e2e.test", first: "Morgan", last: "Agent", role: "AGENT" },
};

export function load(): Partial<Record<Who, Person>> {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
}
export function save(who: Who, p: Person) {
  writeFileSync(FILE, JSON.stringify({ ...load(), [who]: p }, null, 2));
}
export function person(who: Who): Person {
  const p = load()[who];
  if (!p) throw new Error(`${who} hasn't been set up yet (run the files in order)`);
  return p;
}

export const passwordFor = (who: Who) => `Correct horse battery staple ${who.length}${who.charCodeAt(0)} test`;

/** On the invitation link: set a password, then (privileged roles) set up two-factor. */
export async function acceptInvite(page: Page, who: Who, link: string) {
  const password = passwordFor(who);
  await page.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(page.getByRole("heading", { name: "Set your password" })).toBeVisible();
  await page.getByLabel("New password").fill(password);
  await page.getByLabel("Type it again").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("You can sign in now")).toBeVisible();
  await page.getByRole("button", { name: "Go to sign in" }).click();
  save(who, { ...PEOPLE[who], password });
  await signInWithPassword(page, who);
  if (who !== "agent") await enrolMfa(page, who);
}

export async function signInWithPassword(page: Page, who: Who) {
  const p = { ...PEOPLE[who], ...load()[who] };
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(p.email);
  await page.getByLabel("Password").fill(p.password ?? passwordFor(who));
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function enrolMfa(page: Page, who: Who) {
  await expect(page.getByRole("heading", { name: "Set up two-factor sign-in" })).toBeVisible();
  await page.getByRole("button", { name: "Start setup" }).click();
  await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
  const secret = (await page.getByTestId("mfa-secret").textContent())!.trim();
  await page.getByLabel("Authenticator code").fill(await totp(secret));
  await page.getByRole("button", { name: "Turn on two-factor sign-in" }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
  const recovery = await page.getByRole("list", { name: "Recovery codes" }).locator("li").allTextContents();
  expect(recovery).toHaveLength(10);
  save(who, { ...person(who), secret, recovery });
  await page.getByLabel("I've saved these codes").check();
  await page.getByRole("button", { name: "Continue to the back office" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

const sessionFile = (who: Who) => new URL(`../.state/session-${who}.json`, import.meta.url);

/**
 * Signed in as `who`. Reuses that person's session from an earlier test when
 * it's still valid (the API allows 5 sign-ins per account per minute), and
 * otherwise signs in with password and authenticator code.
 */
export async function signIn(page: Page, who: Who, opts: { fresh?: boolean } = {}) {
  const file = sessionFile(who);
  if (!opts.fresh && existsSync(file)) {
    await page.context().addCookies(JSON.parse(readFileSync(file, "utf8")).cookies);
    const me = await page.request.get("/api/auth/me");
    const mfa = me.ok() ? (await me.json()).mfa : null;
    if (mfa && !(mfa.required && !mfa.satisfied)) {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
      return;
    }
    
    await page.context().clearCookies();
  }
  await page.goto("/");
  await signInWithPassword(page, who);
  const p = person(who);
  if (p.secret) {
    await expect(page.getByRole("heading", { name: "Two-factor sign-in" })).toBeVisible();
    await page.getByLabel("Authenticator code").fill(await totp(p.secret));
    await page.getByRole("button", { name: "Verify" }).click();
  }
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.context().storageState({ path: file.pathname });
}

/** Invites someone from Admin → People and returns the one-time link the screen shows. */
export async function invite(page: Page, who: Who): Promise<string> {
  const p = PEOPLE[who];
  await page.goto("/admin");
  await page.getByRole("button", { name: "Invite someone" }).click();
  await page.getByLabel("First name").fill(p.first);
  await page.getByLabel("Last name").fill(p.last);
  await page.getByLabel("Email").fill(p.email);
  await page.getByLabel("Role").selectOption(p.role);
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = page.getByTestId("one-time-link");
  await expect(link).toBeVisible();
  return (await link.textContent())!.trim();
}

export const shot = (page: Page, name: string) => page.screenshot({ path: `report/screens/${name}.png`, fullPage: true });
