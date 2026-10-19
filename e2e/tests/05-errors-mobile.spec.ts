import { test, expect } from "@playwright/test";
import { signIn, shot } from "../lib/people.ts";
import { run } from "../lib/state.ts";

test("when the server can't be reached the screen says so and offers nothing misleading", async ({ page }) => {
  await signIn(page, "agent");
  await page.route("**/api/deals?**", (r) => r.abort());
  await page.route("**/api/deals", (r) => r.abort());
  await page.goto("/deals");
  await expect(page.getByText("Can't reach the server")).toBeVisible();
  await shot(page, "22-network-error");
});

test("an unknown link shows a way back", async ({ page }) => {
  await signIn(page, "agent");
  await page.goto("/no/such/page");
  await expect(page.getByText("Nothing here")).toBeVisible();
  await page.goto("/deals/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("This deal couldn't be opened")).toBeVisible();
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("sign-in, menu and the main screens fit a phone without sideways scrolling", async ({ page }) => {
    await signIn(page, "broker");
    await shot(page, "23-mobile-dashboard");
    await page.getByRole("button", { name: "Menu" }).click();
    await page.locator("#mobile-nav").getByRole("link", { name: "Deals" }).click();
    await expect(page).toHaveURL(/\/deals$/);
    const { dealId } = run();
    for (const path of ["/deals", `/deals/${dealId}`, `/deals/${dealId}/documents`, `/deals/${dealId}/trust`, "/bank", "/trust", "/approvals", "/admin"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
    }
    await page.goto(`/deals/${dealId}/trust`);
    await expect(page.getByRole("heading", { name: "Ledger" })).toBeVisible();
    await shot(page, "24-mobile-trust");
  });
});
