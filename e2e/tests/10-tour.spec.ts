/**
 * The walkthrough in docs/demo-walkthrough.md, screen by screen: what the broker of record sees at each step,
 * then what an agent sees. Read-only apart from signing in; the pictures go to report/screens/tour-*.png.
 */
import { test, expect } from "@playwright/test";
import { person, shot, signInWithPassword } from "../lib/people.ts";
import { as, closeWindowsAfterEach } from "../lib/contexts.ts";
import { totp } from "../lib/totp.ts";
import { run } from "../lib/state.ts";

test.describe.configure({ mode: "serial" });
closeWindowsAfterEach();

test("1. the broker of record signs in with a password and an authenticator code", async ({ page }) => {
  await page.goto("/");
  await shot(page, "tour-01a-sign-in");
  await signInWithPassword(page, "broker");
  await expect(page.getByRole("heading", { name: "Two-factor sign-in" })).toBeVisible();
  await shot(page, "tour-01b-two-factor");
  await page.getByLabel("Authenticator code").fill(await totp(person("broker").secret!));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("2–9. the broker's screens, in the order of the walkthrough", async ({ browser }) => {
  const { saleId, condoId } = run();
  const broker = await as(browser, "broker");
  const visit = async (path: string, name: string, ready: RegExp | string) => {
    await broker.goto(path);
    await expect(broker.getByText(ready).first()).toBeVisible();
    await shot(broker, name);
  };
  await visit("/", "tour-02-dashboard", "Brokerage overview");
  await visit("/deals", "tour-03a-deals", "88 Charlton Ave W");
  await visit("/deals/new", "tour-03b-new-deal", "Our side");
  await visit("/compliance", "tour-04a-review-queue", "Listing Agreement (Form 200)");
  await broker.locator("li", { hasText: "88 Charlton Ave W" }).getByRole("button", { name: "Review" }).click();
  await expect(broker.getByRole("button", { name: "Approve" })).toBeVisible();
  await shot(broker, "tour-04b-review");
  await broker.goto(`/deals/${condoId}/trust`);
  await broker.getByRole("button", { name: "Record a deposit received" }).click();
  await expect(broker.getByLabel("Amount")).toBeVisible();
  await shot(broker, "tour-05a-record-deposit");
  await visit("/bank", "tour-05b-bank-files", "Verified");
  await visit(`/deals/${saleId}/record`, "tour-06-trade-record", "210 Navy St");
  await visit(`/deals/${saleId}/closing`, "tour-07-cda", /-R1 issued/);
  await visit("/approvals", "tour-08a-approvals", "Jamie Rivera");
  await visit("/bank/funds", "tour-08b-available-funds", "Payouts can be approved");
  await visit("/bank/reconciliations", "tour-09a-reconciliations", "Signed");
  await visit("/trust", "tour-09b-trust", "Real Estate Trust Account");
  await visit("/oversight/broker", "tour-09c-broker-oversight", /^As of /);
  await visit("/oversight/accounting", "tour-09d-accounting", /^As of /);
});

test("10. an agent sees only their own deals, and no CDA or bank screens", async ({ browser }) => {
  const { saleId } = run();
  const morgan = await as(browser, "agent");
  await expect(morgan.getByRole("link", { name: "Bank & reconciliation" })).toHaveCount(0);
  await shot(morgan, "tour-10a-agent-dashboard");
  await morgan.goto("/deals");
  await expect(morgan.getByText("210 Navy St")).toBeVisible();
  await expect(morgan.getByText("15 Ontario St")).toHaveCount(0); // Jamie's deal
  await shot(morgan, "tour-10b-agent-deals");
  await morgan.goto(`/deals/${saleId}`);
  await expect(morgan.getByRole("link", { name: "Documents" })).toBeVisible();
  await expect(morgan.getByRole("link", { name: "Closing & CDA" })).toHaveCount(0);
  await shot(morgan, "tour-10c-agent-deal");
});
