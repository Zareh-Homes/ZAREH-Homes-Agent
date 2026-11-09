/**
 * The deal check, in the browser. An agent opens a deal with mistakes in it: closing lands on a Saturday and the
 * deposit we hold was due yesterday with nothing in trust. The deal's Overview lists what to fix, grouped, with a
 * link to the right tab; the deal secretary sees the same deal in Compliance review → Deal check.
 */
import { test, expect } from "@playwright/test";
import { shot } from "../lib/people.ts";
import { as, closeWindowsAfterEach } from "../lib/contexts.ts";
import { day } from "../lib/state.ts";

test.describe.configure({ mode: "serial" });
closeWindowsAfterEach();

/** The first Saturday at least `from` days out */
function saturday(from: number): string {
  for (let n = from; ; n++) if (new Date(`${day(n)}T12:00:00Z`).getUTCDay() === 6) return day(n);
}

test("deal check: the agent sees what's wrong on submit; the deal secretary gets the queue", async ({ browser }) => {
  const close = saturday(50);
  const agent = await as(browser, "agent");
  await agent.goto("/deals/new");
  await agent.getByLabel("Street address").fill("27 King St W");
  await agent.getByLabel("City").fill("Stoney Creek");
  await agent.getByLabel("Sale price").fill("749000");
  await agent.getByLabel("Offer date").fill(day(-4));
  await agent.getByLabel("Closing date").fill(close);
  await agent.getByLabel(/^Deposit( \*)?$/).fill("35000");
  await agent.getByLabel("Deposit due").fill(day(-1));
  await agent.getByLabel("Who holds the deposit").selectOption("OUR_BROKERAGE");
  await agent.getByLabel("Our commission").fill("18725");
  await agent.getByLabel("Split %").fill("70");
  await agent.getByLabel("Full legal name").fill("Morgan Vale");
  await agent.getByLabel("Representation").selectOption("OUR_CLIENT");
  await agent.getByRole("button", { name: "Open the deal" }).click();
  await expect(agent).toHaveURL(/\/deals\/[0-9a-f-]{36}$/);

  const check = agent.getByRole("region", { name: "Deal check" });
  await expect(check.getByText(/^Deal check: \d+ to fix/)).toBeVisible();
  await expect(check.getByText(`Closing is on ${close} (a weekend)`, { exact: false })).toBeVisible();
  await expect(check.getByText(`The deposit was due ${day(-1)} and isn't recorded in trust`, { exact: false })).toBeVisible();
  await expect(check.getByText("No buyer on the deal", { exact: false })).toBeVisible();
  await expect(check.getByText("No seller's lawyer", { exact: false })).toBeVisible();
  await shot(agent, "check-01-deal-overview");
  const dealId = agent.url().split("/").pop()!;

  const secretary = await as(browser, "compliance");
  await secretary.goto("/compliance/deals");
  const row = secretary.getByRole("row", { name: /27 King St W/ });
  await expect(row.getByText(/\d+ to fix/)).toBeVisible();
  await shot(secretary, "check-02-queue");
  await row.getByRole("link", { name: /^Deal / }).click();
  await expect(secretary).toHaveURL(new RegExp(`/deals/${dealId}$`));
  await expect(secretary.getByRole("region", { name: "Deal check" })).toBeVisible();
});
