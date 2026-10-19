/** Leases can be recorded and their deposit held, but settlement stays off until counsel signs off. */
import { test, expect } from "@playwright/test";
import { shot } from "../lib/people.ts";
import { apiAs, as, closeWindowsAfterEach } from "../lib/contexts.ts";
import { day, remember } from "../lib/state.ts";

closeWindowsAfterEach();

test("a lease: deposit received into trust, but no CDA and nothing paid out of trust while LEASE_SETTLEMENT is off", async ({ browser }) => {
  const agent = await as(browser, "agent");
  await agent.goto("/deals/new");
  await agent.getByLabel("Our side").selectOption("LANDLORD");
  await agent.getByLabel("Street address").fill("41 Ridge Rd");
  await agent.getByLabel("City").fill("Stoney Creek");
  await agent.getByLabel("Monthly rent").fill("3000");
  await agent.getByLabel("Agreement date").fill(day(-10));
  await agent.getByLabel("Lease commencement").fill(day(0));
  await agent.getByLabel(/^Deposit \(e\.g\./).fill("6000");
  await agent.getByLabel("Who holds the deposit").selectOption("OUR_BROKERAGE");
  await agent.getByLabel("Our commission").fill("3000");
  await agent.getByLabel("Split %").fill("70");
  await agent.getByLabel("Full legal name").fill("Rita Olsen");
  await agent.getByLabel("Representation").selectOption("OUR_CLIENT");
  await agent.getByRole("button", { name: "Open the deal" }).click();
  await expect(agent).toHaveURL(/\/deals\/[0-9a-f-]{36}$/);
  const dealId = agent.url().split("/").pop()!;
  remember({ leaseId: dealId });
  await expect(agent.getByText("Outside the pilot")).toBeVisible();
  await agent.getByRole("button", { name: "Mark firm" }).click();
  await agent.getByRole("group", { name: "Mark firm" }).getByRole("button", { name: "Mark firm" }).click();
  await agent.getByRole("button", { name: "Record commencement" }).click();
  await agent.getByRole("button", { name: "Mark closed" }).click();

  const broker = await as(browser, "broker");
  await broker.goto(`/deals/${dealId}/trust`);
  await broker.getByRole("button", { name: "Record a deposit received" }).click();
  await broker.getByLabel("Amount").fill("6000");
  await broker.getByLabel("Payor").fill("Kofi Mensah");
  await broker.getByLabel(/^Received( \*)?$/).fill(day(0));
  await broker.getByLabel("Deposited at the bank").fill(day(0));
  await broker.getByLabel("Bank reference").fill("CHQ-7781");
  await broker.getByRole("button", { name: "Record deposit" }).click();
  await expect(broker.getByRole("table").getByText("Deposit received")).toBeVisible();

  await broker.getByRole("button", { name: "Record a payment out" }).click();
  await broker.getByLabel("Amount").fill("915");
  await broker.getByLabel("Paid to").selectOption("LANDLORD");
  await broker.getByLabel("Payee name").fill("Rita Olsen");
  await broker.getByRole("button", { name: "Record payment" }).click();
  await expect(broker.getByRole("alert").filter({ hasText: /lease stays disabled.*LEASE_SETTLEMENT/ })).toBeVisible();

  await broker.goto(`/deals/${dealId}/closing`);
  await expect(broker.getByText("Lease settlement isn't enabled")).toBeVisible();
  await expect(broker.getByRole("button", { name: "Finalize the CDA" })).toHaveCount(0);
  const res = await apiAs(broker, "POST", `/api/deals/${dealId}/closing/finalize`);
  expect([res.status, res.body.error.code]).toEqual([409, "POLICY_NOT_APPROVED"]);
  await shot(broker, "30-lease-settlement-off");
});
