/**
 * Rounds the journey out into a small working brokerage for the local demo (ops/local-trial.sh demo): a second
 * agent, an active condo listing with a document waiting for review, a conditional buyer deal, and a commission
 * plan waiting for the broker's approval. Everything is fictional and goes through the real screens and rules.
 */
import { test, expect, type Page } from "@playwright/test";
import { acceptInvite, invite } from "../lib/people.ts";
import { as, closeWindowsAfterEach } from "../lib/contexts.ts";
import { day, PDF, remember } from "../lib/state.ts";

test.describe.configure({ mode: "serial" });
closeWindowsAfterEach();

async function newDeal(page: Page, d: { side: string; street: string; unit?: string; city: string; price: string; deposit: string;
  holder: string; gci: string; conditionsDue?: string; parties: [string, string, string][] }) {
  await page.goto("/deals/new");
  await page.getByLabel("Our side").selectOption(d.side);
  await page.getByLabel("Street address").fill(d.street);
  if (d.unit) await page.getByLabel("Unit").fill(d.unit);
  await page.getByLabel("City").fill(d.city);
  await page.getByLabel("Sale price").fill(d.price);
  await page.getByLabel("Offer date").fill(day(-4));
  if (d.conditionsDue) await page.getByLabel("Conditions due").fill(d.conditionsDue);
  await page.getByLabel("Closing date").fill(day(60));
  await page.getByLabel(/^Deposit( \*)?$/).fill(d.deposit);
  await page.getByLabel("Deposit due").fill(day(-3));
  await page.getByLabel("Who holds the deposit").selectOption(d.holder);
  await page.getByLabel("Our commission").fill(d.gci);
  await page.getByLabel("Split %").fill("75");
  for (const [i, [role, name, rep]] of d.parties.entries()) {
    if (i > 0) await page.getByRole("button", { name: "Add a person" }).click();
    const person = page.getByRole("group", { name: `Person ${i + 1}` });
    await person.getByLabel("Role").selectOption(role);
    await person.getByLabel("Full legal name").fill(name);
    if (rep) await person.getByLabel("Representation").selectOption(rep);
  }
  await page.getByRole("button", { name: "Open the deal" }).click();
  await expect(page).toHaveURL(/\/deals\/[0-9a-f-]{36}$/);
  return page.url().split("/").pop()!;
}

test("a second agent joins, with a commission plan proposed for the broker to approve", async ({ browser }) => {
  const admin = await as(browser, "admin");
  const link = await invite(admin, "agent2");
  const jamie = await browser.newPage();
  await acceptInvite(jamie, "agent2", link);
  await jamie.close();

  await admin.goto("/admin/plans");
  await admin.getByRole("combobox", { name: "Agent" }).selectOption({ label: "Jamie Rivera" });
  await admin.getByRole("button", { name: "Propose a new version" }).click();
  await admin.getByLabel("Effective from").fill("2026-01-01");
  await admin.getByLabel("Agent's split (%)").fill("75");
  await admin.getByLabel("Reason").fill("Standard plan for a new agent (demo)");
  await admin.getByRole("button", { name: "Propose" }).click();
  await expect(admin.getByText("Proposed").first()).toBeVisible();
});

test("the second agent's deals: a Hamilton condo listing and a conditional buyer deal in Grimsby", async ({ browser }) => {
  const jamie = await as(browser, "agent2");
  const condoId = await newDeal(jamie, { side: "LISTING", street: "88 Charlton Ave W", unit: "1204", city: "Hamilton", price: "529000",
    deposit: "25000", holder: "OUR_BROKERAGE", gci: "13225", conditionsDue: day(5), parties: [["SELLER", "Dana Whitfield", "OUR_CLIENT"]] });
  const grimsbyId = await newDeal(jamie, { side: "BUYER", street: "15 Ontario St", city: "Grimsby", price: "1045000",
    deposit: "50000", holder: "COOP_BROKERAGE", gci: "26125", conditionsDue: day(3),
    parties: [["BUYER", "Sam Okafor", "OUR_CLIENT"], ["COOP_BROKERAGE", "Escarpment Realty Inc.", ""]] });
  remember({ condoId, grimsbyId });

  // The listing agreement, uploaded and waiting for the compliance review
  await jamie.goto(`/deals/${condoId}/documents`);
  const slot = jamie.getByTestId("slot-FORM_200");
  await slot.getByRole("button", { name: "Upload" }).click();
  await slot.locator("input[type=file]").setInputFiles({ name: "listing-agreement.pdf", mimeType: "application/pdf", buffer: PDF });
  await slot.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(slot.getByText("Pending review")).toBeVisible();
});
