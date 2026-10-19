import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { signIn, shot, type Who } from "../lib/people.ts";
import { day, run } from "../lib/state.ts";

test.describe.configure({ mode: "serial" });

const open: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(open.splice(0).map((c) => c.close())); });

async function as(browser: Browser, who: Who) {
  const ctx = await browser.newContext();
  open.push(ctx);
  const page = await ctx.newPage();
  await signIn(page, who);
  return page;
}

test("governance: admin designates the broker of record; the broker opens the trust account", async ({ browser }) => {
  const admin = await as(browser, "admin");
  await admin.goto("/admin/governance");
  await admin.getByRole("button", { name: "Record a designation" }).click();
  await admin.getByRole("combobox", { name: /^Broker/ }).selectOption({ label: "Blake Broker" });
  await admin.getByLabel("From").fill(day(-30));
  await admin.getByLabel("Reference").fill("RECO designation notice (test)");
  await admin.getByRole("button", { name: "Record", exact: true }).click();
  await expect(admin.getByText("Blake Broker").first()).toBeVisible();

  const broker = await as(browser, "broker");
  await broker.goto("/admin/governance");
  await broker.getByRole("button", { name: "Add a trust account" }).click();
  await broker.getByLabel("Account name").fill("Real Estate Trust Account");
  await broker.getByLabel("Bank").fill("Test Bank");
  await broker.getByLabel("Last 4 digits").fill("4321");
  await broker.getByRole("button", { name: "Add account" }).click();
  await expect(broker.getByText("Real Estate Trust Account")).toBeVisible();
  await shot(broker, "15-governance");
});

test("broker records the deposit; the ledger shows the server's running balance", async ({ browser }) => {
  const { dealId } = run();
  const broker = await as(browser, "broker");
  await broker.goto(`/deals/${dealId}/trust`);
  await broker.getByRole("button", { name: "Record a deposit received" }).click();
  await broker.getByLabel("Amount").fill("50000");
  await broker.getByLabel("Method").selectOption("WIRE");
  await broker.getByLabel("Payor").fill("Jordan Buyer");
  await broker.getByLabel(/^Received( \*)?$/).fill(day(0));
  await broker.getByLabel("Deposited at the bank").fill(day(0));
  await broker.getByLabel("Bank reference").fill("WIRE-E2E-1");
  await broker.getByRole("button", { name: "Record deposit" }).click();
  const ledger = broker.getByRole("table");
  await expect(ledger.getByText("Deposit received")).toBeVisible();
  await expect(ledger.getByText("$50,000.00").first()).toBeVisible();
  await shot(broker, "16-trust-ledger");
});

test("bank file: admin imports, can't verify their own import, the broker verifies", async ({ browser }) => {
  const admin = await as(browser, "admin");
  await admin.goto("/bank");
  await admin.getByRole("button", { name: "Import a bank file" }).click();
  const start = `${day(0).slice(0, 8)}01`;
  await admin.getByLabel("Period from").fill(start);
  await admin.getByLabel("Period to").fill(day(0));
  await admin.getByLabel("Opening balance").fill("0.00");
  await admin.getByLabel("Closing balance").fill("50000.00");
  await admin.getByLabel("Received from the bank").fill(day(0));
  await admin.getByLabel("Date format in the file").selectOption("YMD");
  const csv = `Date,Description,Amount,Balance\n${day(0)},WIRE IN WIRE-E2E-1 JORDAN BUYER,50000.00,50000.00\n`;
  await admin.getByLabel("CSV file from the bank").setInputFiles({ name: "trust-statement.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await admin.getByRole("button", { name: "Import", exact: true }).click();
  await expect(admin).toHaveURL(/\/bank\/statements\//);
  const statementUrl = admin.url();
  await expect(admin.getByText("1 of 1")).toBeVisible();
  await shot(admin, "17-statement-imported");

  await admin.getByRole("button", { name: "Verify against the bank" }).click();
  await admin.getByLabel("How you checked it").fill("Compared with the bank portal");
  await admin.getByRole("button", { name: "Verified" }).click();
  await expect(admin.getByRole("alert")).toBeVisible(); // segregation of duties: the importer can't verify
  await shot(admin, "18-sod-refused");

  const broker = await as(browser, "broker");
  await broker.goto(statementUrl.replace(/^https?:\/\/[^/]+/, ""));
  await broker.getByRole("button", { name: "Verify against the bank" }).click();
  await broker.getByLabel("How you checked it").fill("Compared balance and line with the bank portal");
  await broker.getByRole("button", { name: "Verified" }).click();
  await expect(broker.getByText("Verified by Blake Broker")).toBeVisible();
});

test("reconciliation: admin prepares it, the broker of record signs it", async ({ browser }) => {
  const admin = await as(browser, "admin");
  await admin.goto("/bank");
  await admin.getByRole("table").getByRole("link").first().click();
  await expect(admin.getByText("Balances")).toBeVisible();
  await admin.getByRole("button", { name: "Prepare the reconciliation" }).click();
  await admin.getByRole("button", { name: "Prepare", exact: true }).click();
  await expect(admin).toHaveURL(/\/bank\/reconciliations\//);
  const url = admin.url().replace(/^https?:\/\/[^/]+/, "");
  await shot(admin, "19-reconciliation-prepared");

  const broker = await as(browser, "broker");
  await broker.goto("/approvals");
  await expect(broker.getByText(/reconciliation/i).first()).toBeVisible();
  await shot(broker, "20-approvals-queue");
  await broker.goto(url);
  await broker.getByRole("button", { name: "Sign as broker of record" }).click();
  await broker.getByRole("button", { name: "Sign", exact: true }).click();
  await expect(broker.getByText("Signed by Blake Broker")).toBeVisible();
  await shot(broker, "21-reconciliation-signed");
});
