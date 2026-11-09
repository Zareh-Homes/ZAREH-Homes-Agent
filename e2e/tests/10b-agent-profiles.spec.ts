/**
 * Agent profiles, standard plans and RECO renewal reminders, in the browser. The broker fills in Jamie's profile
 * (start date, RECO expiry, address and date of birth required; the rest optional), sets up a standard plan and
 * picks it for Jamie's next plan, then runs the renewal check: Jamie's registration expires in 10 days, so the
 * 14-day reminder is created. No email service is configured here, so it waits in the outbox.
 */
import { test, expect } from "@playwright/test";
import { shot } from "../lib/people.ts";
import { as, closeWindowsAfterEach } from "../lib/contexts.ts";
import { day } from "../lib/state.ts";

test.describe.configure({ mode: "serial" });
closeWindowsAfterEach();

test("agent profile: required fields, encrypted details, registration status on the people list", async ({ browser }) => {
  const broker = await as(browser, "broker");
  await broker.goto("/admin");
  const jamie = broker.locator("li", { hasText: "Jamie Rivera" }).first();
  await expect(jamie.getByText("Profile not filled in")).toBeVisible();
  await jamie.getByRole("button", { name: "Agent profile" }).click();
  // The four required fields can't be left empty; everything else can
  for (const label of ["Start date", "RECO registration expiry", "Home address", "Date of birth"]) {
    await expect(jamie.getByLabel(label)).toHaveAttribute("required", "");
  }
  await expect(jamie.getByLabel("E&O insurer")).not.toHaveAttribute("required", "");
  await jamie.getByRole("button", { name: "Save profile" }).click();
  await expect(jamie.getByText("Profile not filled in")).toBeVisible(); // nothing saved
  await jamie.getByLabel("Start date").fill("2025-02-03");
  await jamie.getByLabel("RECO registration expiry").fill(day(10));
  await jamie.getByLabel("Home address").fill("88 Charlton Ave W, Hamilton ON L8P 2C1");
  await jamie.getByLabel("Date of birth").fill("1991-04-22");
  await jamie.getByLabel("How we bill them").selectOption("PRE_AUTHORIZED_DEBIT");
  await jamie.getByLabel("Billing note").fill("$250 desk fee on the 1st");
  await jamie.getByLabel("Emergency contact", { exact: true }).fill("Alex Rivera");
  await jamie.getByLabel("Account holder").fill("Jamie Rivera");
  await jamie.getByLabel("Institution #").fill("004");
  await jamie.getByLabel("Transit #").fill("12345");
  await jamie.getByLabel("Account #").fill("7654321");
  await shot(broker, "agent-01-profile-form");
  await jamie.getByRole("button", { name: "Save profile" }).click();
  await expect(jamie.getByText("RECO expires in 10 days")).toBeVisible();
  await shot(broker, "agent-02-people-list");
});

test("standard plans: set up once, picked from a list for an agent", async ({ browser }) => {
  const broker = await as(browser, "broker");
  await broker.goto("/admin/plans");
  await broker.getByRole("button", { name: "Add a standard plan" }).click();
  await broker.getByLabel("Name").fill("80/20 capped at $20,000");
  await broker.getByLabel("Agent's split (%)").fill("80");
  await broker.getByLabel("Annual cap").fill("20000");
  await broker.getByRole("button", { name: "Add a fee" }).click();
  await broker.getByLabel("Fee", { exact: true }).fill("Desk fee");
  await broker.getByLabel("Amount").fill("250");
  await broker.getByRole("button", { name: "Save standard plan" }).click();
  await expect(broker.getByText("80% to the agent · cap $20,000.00 · Desk fee $250.00")).toBeVisible();

  await broker.getByRole("combobox", { name: "Agent", exact: true }).selectOption({ label: "Jamie Rivera" });
  await broker.getByRole("button", { name: "Propose a new version" }).click();
  await broker.getByLabel("Standard plan", { exact: true }).selectOption({ label: "80/20 capped at $20,000" });
  await expect(broker.getByLabel("Agent's split (%)")).toHaveValue("80");
  await broker.getByLabel("Effective from").fill(day(30));
  await shot(broker, "agent-03-pick-standard-plan");
  await broker.getByRole("button", { name: "Propose" }).click();
  await expect(broker.getByText("80/20 capped at $20,000").last()).toBeVisible();
  await expect(broker.getByText("Proposed").first()).toBeVisible(); // a second broker approves it
});

test("renewal reminders: the 14-day reminder for Jamie, with the penalties, waiting for the email service", async ({ browser }) => {
  const broker = await as(browser, "broker");
  await broker.goto("/admin/emails");
  await expect(broker.getByText("Email isn't set up yet")).toBeVisible();
  await expect(broker.locator("tr", { hasText: "Jamie Rivera" }).getByText("10 days left")).toBeVisible();
  await broker.getByRole("button", { name: "Run the check now" }).click();
  await expect(broker.getByText(/reminder\(s\) created/)).toBeVisible();
  const email = broker.locator("li", { hasText: "Urgent: your RECO registration expires" });
  await expect(email.getByText("Waiting")).toBeVisible();
  await email.getByText("Show the email").click();
  await expect(email.getByText(/fined up to \$50,000, jailed for up to two years less a day, or both/)).toBeVisible();
  await shot(broker, "agent-04-reminder-email");
  await broker.goto("/oversight/broker");
  await expect(broker.getByText("RECO registrations needing attention")).toBeVisible();
});

test("import & export: download the deals spreadsheet; import agents from a spreadsheet, previewed first", async ({ browser }) => {
  const admin = await as(browser, "admin");
  await admin.goto("/admin/data");
  const download = admin.waitForEvent("download");
  await admin.getByRole("link", { name: "Download deals" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^zareh-deals-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await (await file.createReadStream()).toArray().then((c) => Buffer.concat(c as Buffer[]).toString("utf8"));
  expect(text).toContain("1 Escarpment Cres");

  const csv = [
    "First Name,Last Name,Email,Role,Start Date,RECO Expiry Date,Address,Date of Birth,Billing Method",
    `Priya,Nair,priya.nair@e2e.test,AGENT,2026-11-01,2028-11-01,"14 Main St W, Grimsby ON",1993-09-09,DEDUCT_FROM_COMMISSION`,
    `Tom,Lee,tom.lee@e2e.test,AGENT,2026-11-01,,"3 Elm St, Stoney Creek",1989-01-01,`,
  ].join("\n");
  await admin.getByLabel("Import agents: CSV file").setInputFiles({ name: "agents.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  const box = admin.getByRole("region", { name: "Import agents" });
  await box.getByRole("button", { name: "Check the file" }).click();
  await expect(box.getByText("Preview: nothing saved yet")).toBeVisible();
  await expect(box.getByText("recoExpiryDate is required for an agent's profile")).toBeVisible();
  await shot(admin, "agent-05-import-preview");
  await box.getByRole("button", { name: "Import 1 row(s)" }).click();
  await expect(box.getByText("Imported", { exact: true })).toBeVisible();
  await admin.goto("/admin");
  const priya = admin.locator("li", { hasText: "Priya Nair" });
  await expect(priya.getByText("Invitation not accepted")).toBeVisible();
  // Test person only: suspended again so the demo brokerage keeps its own people
  await priya.getByRole("button", { name: "Suspend" }).click();
  await priya.getByRole("group", { name: "Suspend" }).getByRole("button", { name: "Suspend" }).click();
  await expect(admin.locator("li", { hasText: "Priya Nair" })).toHaveCount(0);
});

test("document preview: a reviewer sees the file in place, without downloading it", async ({ browser }) => {
  const { dualId } = (await import("../lib/state.ts")).run();
  const comp = await as(browser, "compliance");
  const blocked: string[] = [];
  comp.on("console", (m) => { if (/Content Security Policy|Refused to (frame|load)/i.test(m.text())) blocked.push(m.text()); });
  await comp.goto(`/deals/${dualId}/documents`);
  const slot = comp.getByTestId("slot-FINTRAC_INDIVIDUAL").first();
  await slot.getByRole("button", { name: "Show file" }).click();
  const frame = slot.locator("iframe[title^='Preview of']");
  await expect(frame).toBeVisible();
  await expect.poll(() => frame.getAttribute("src")).toMatch(/^blob:/);
  await shot(comp, "agent-06-document-preview");
  await slot.getByRole("button", { name: "Hide file" }).click();
  await expect(frame).toHaveCount(0);
  expect(blocked).toEqual([]); // the page's security policy allows the preview (checked behind nginx in CI's staging run)
});
