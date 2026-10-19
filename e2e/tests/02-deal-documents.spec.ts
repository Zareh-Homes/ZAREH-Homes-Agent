import { test, expect } from "@playwright/test";
import { signIn, shot } from "../lib/people.ts";
import { day, PDF, remember, run } from "../lib/state.ts";

test.describe.configure({ mode: "serial" });

test("agent: the new-deal form explains what's missing, then opens the deal", async ({ page }) => {
  await signIn(page, "agent");
  await page.goto("/deals/new");
  await page.getByRole("button", { name: "Open the deal" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The deal wasn't opened" })).toBeVisible();
  await shot(page, "07-new-deal-errors");

  await page.getByLabel("Street address").fill("12 Lakeshore Rd");
  await page.getByLabel("City").fill("Oakville");
  await page.getByLabel("Sale price").fill("899000");
  await page.getByLabel("Offer date").fill(day(-3));
  await page.getByLabel("Closing date").fill(day(45));
  await page.getByLabel(/^Deposit( \*)?$/).fill("50000");
  await page.getByLabel("Deposit due").fill(day(-2));
  await page.getByLabel("Who holds the deposit").selectOption("OUR_BROKERAGE");
  await page.getByLabel("Our commission").fill("22475");
  await page.getByLabel("Split %").fill("70");
  await page.getByLabel("Full legal name").fill("Jordan Seller");
  await page.getByLabel("Representation").selectOption("OUR_CLIENT");
  await page.getByRole("button", { name: "Open the deal" }).click();

  await expect(page).toHaveURL(/\/deals\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: "12 Lakeshore Rd, Oakville" })).toBeVisible();
  remember({ dealId: page.url().split("/").pop()! });
  await shot(page, "08-deal-overview");
});

test("agent uploads the listing agreement; compliance sends it back, then approves the new version", async ({ browser }) => {
  const { dealId } = run();
  const agentCtx = await browser.newContext(); const agent = await agentCtx.newPage();
  await signIn(agent, "agent");
  await agent.goto(`/deals/${dealId}/documents`);
  const slot = agent.getByTestId("slot-FORM_200");
  await slot.getByRole("button", { name: "Upload" }).click();
  await slot.locator("input[type=file]").setInputFiles({ name: "form-200.pdf", mimeType: "application/pdf", buffer: PDF });
  await slot.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(slot.getByText("Pending review")).toBeVisible();
  await shot(agent, "09-documents-uploaded");

  const compCtx = await browser.newContext(); const comp = await compCtx.newPage();
  await signIn(comp, "compliance");
  await comp.goto("/compliance");
  await expect(comp.getByText("Listing Agreement (Form 200)")).toBeVisible();
  await shot(comp, "10-review-queue");
  await comp.getByRole("button", { name: "Review" }).first().click();
  await comp.getByLabel("Comment").fill("Seller's initials are missing on page 2.");
  await comp.getByRole("button", { name: "Send back" }).click();
  await expect(comp.getByText("Listing Agreement (Form 200)")).toHaveCount(0);

  await agent.reload();
  await expect(slot.getByText("Sent back: Seller's initials are missing on page 2.")).toBeVisible();
  await slot.getByRole("button", { name: "Upload a new version" }).click();
  await slot.locator("input[type=file]").setInputFiles({ name: "form-200-initialled.pdf", mimeType: "application/pdf", buffer: PDF });
  await slot.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(slot.getByText("Pending review")).toBeVisible();

  await comp.reload();
  await comp.getByRole("button", { name: "Review" }).first().click();
  await comp.getByRole("button", { name: "Approve" }).click();
  await agent.reload();
  await expect(slot.getByText("Approved")).toBeVisible();
  await shot(agent, "11-documents-approved");
  await agentCtx.close(); await compCtx.close();
});

test("trade record sheet: prepared, shown with its items, and printable", async ({ page }) => {
  const { dealId } = run();
  await signIn(page, "agent");
  await page.goto(`/deals/${dealId}/record`);
  await page.getByRole("button", { name: "Prepare the trade record sheet" }).click();
  await expect(page.getByRole("heading", { name: "Record" })).toBeVisible();
  await shot(page, "12-trade-record");
  await page.getByRole("link", { name: "Printable copy" }).click();
  await expect(page.getByRole("heading", { name: "Trade record sheet" })).toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.getByRole("button", { name: "Print" })).toBeHidden();
  await shot(page, "13-trade-record-print");
});
