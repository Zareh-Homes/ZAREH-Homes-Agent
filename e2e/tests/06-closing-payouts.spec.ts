/**
 * The money path after closing, in the browser: CDA preview, finalize (double-click safe), void and
 * reissue, commission received in parts, bank verification, available funds, payout approval,
 * cancellation, recording the payment (double-click safe), a returned payment and its replacement.
 * Role restrictions are checked on the screen and directly against the API.
 */
import { test, expect } from "@playwright/test";
import { shot } from "../lib/people.ts";
import { apiAs, as, closeWindowsAfterEach } from "../lib/contexts.ts";
import { day, PDF, remember, run } from "../lib/state.ts";

test.describe.configure({ mode: "serial" });
closeWindowsAfterEach();

const dealUrl = (tab: string) => `/deals/${run().saleId}/${tab}`;

test("setup: a buyer-side sale, FINTRAC ID approved, the agent's commission plan approved", async ({ browser }) => {
  const agent = await as(browser, "agent");
  await agent.goto("/deals/new");
  await agent.getByLabel("Our side").selectOption("BUYER");
  await agent.getByLabel("Street address").fill("210 Navy St");
  await agent.getByLabel("City").fill("Oakville");
  await agent.getByLabel("Sale price").fill("750000");
  await agent.getByLabel("Offer date").fill(day(-20));
  await agent.getByLabel("Closing date").fill(day(0));
  await agent.getByLabel(/^Deposit( \*)?$/).fill("30000");
  await agent.getByLabel("Who holds the deposit").selectOption("COOP_BROKERAGE");
  await agent.getByLabel("Our commission").fill("18750");
  await agent.getByLabel("Split %").fill("70");
  const people = [["BUYER", "Riley Buyer", "OUR_CLIENT"], ["BUYER_LAWYER", "Shah Law", ""], ["COOP_BROKERAGE", "Lakeshore Realty Ltd.", ""]];
  for (const [i, [role, name, rep]] of people.entries()) {
    if (i > 0) await agent.getByRole("button", { name: "Add a person" }).click();
    const person = agent.getByRole("group", { name: `Person ${i + 1}` });
    await person.getByLabel("Role").selectOption(role!);
    await person.getByLabel("Full legal name").fill(name!);
    if (rep) await person.getByLabel("Representation").selectOption(rep);
  }
  await agent.getByRole("button", { name: "Open the deal" }).click();
  await expect(agent).toHaveURL(/\/deals\/[0-9a-f-]{36}$/);
  remember({ saleId: agent.url().split("/").pop()! });

  // FINTRAC identification for the buyer, uploaded by the agent, approved by compliance
  await agent.goto(dealUrl("documents"));
  const slot = agent.getByTestId("slot-FINTRAC_INDIVIDUAL");
  await slot.getByRole("button", { name: "Upload" }).click();
  await slot.locator("input[type=file]").setInputFiles({ name: "id-record.pdf", mimeType: "application/pdf", buffer: PDF });
  for (const [label, value] of [["Full legal name", "Riley Buyer"], ["Date of birth", "1985-04-04"], ["Address", "12 Elm St, Oakville ON"],
    ["Occupation", "Engineer"], ["ID number", "R1234-56789-01234"], ["Issued by", "Ontario"], ["ID expiry", "2031-04-04"], ["Verified on", day(-19)]] as const) {
    await slot.getByLabel(label).fill(value);
  }
  await slot.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(slot.getByText("Pending review")).toBeVisible();
  const comp = await as(browser, "compliance");
  await comp.goto("/compliance");
  await comp.locator("li", { hasText: "Riley Buyer" }).getByRole("button", { name: "Review" }).click();
  await comp.getByRole("button", { name: "Approve" }).click();
  await expect(comp.locator("li", { hasText: "Riley Buyer" })).toHaveCount(0);

  // Commission plan: proposed by the admin, approved by the broker (a second person)
  const admin = await as(browser, "admin");
  await admin.goto("/admin/plans");
  await admin.getByRole("combobox", { name: "Agent" }).selectOption({ label: "Morgan Agent" });
  await admin.getByRole("button", { name: "Propose a new version" }).click();
  await admin.getByLabel("Effective from").fill("2026-01-01");
  await admin.getByLabel("Agent's split (%)").fill("70");
  await admin.getByLabel("Reason").fill("Pilot plan (test)");
  await admin.getByRole("button", { name: "Propose" }).click();
  await expect(admin.getByText("Proposed").first()).toBeVisible();
  await expect(admin.getByRole("button", { name: "Approve" })).toHaveCount(0); // admins can't approve plans
  const broker = await as(browser, "broker");
  await broker.goto("/admin/plans");
  await broker.getByRole("combobox", { name: "Agent" }).selectOption({ label: "Morgan Agent" });
  await broker.getByRole("button", { name: "Approve" }).click();
  await expect(broker.getByText("In force")).toBeVisible();

  // Firm, then closed, by the agent
  await agent.goto(dealUrl("overview"));
  await agent.getByRole("button", { name: "Mark firm" }).click();
  await agent.getByRole("group", { name: "Mark firm" }).getByRole("button", { name: "Mark firm" }).click();
  await agent.getByRole("button", { name: "Record the closing" }).click();
  await agent.getByLabel("Closed on").fill(day(0));
  await agent.getByRole("button", { name: "Mark closed" }).click();
  await expect(agent.getByText("Closed", { exact: true }).first()).toBeVisible();
});

test("only a managing broker issues a CDA: agents don't see it; compliance can look but not finalize", async ({ browser }) => {
  const agent = await as(browser, "agent");
  await agent.goto(dealUrl("overview"));
  await expect(agent.getByRole("link", { name: "Closing & CDA" })).toHaveCount(0);
  expect((await apiAs(agent, "GET", `/api/deals/${run().saleId}/closing`)).status).toBe(403);

  const comp = await as(browser, "compliance");
  await comp.goto(dealUrl("closing"));
  await expect(comp.getByRole("heading", { name: "Commission", exact: true })).toBeVisible();
  await expect(comp.getByRole("button", { name: "Finalize the CDA" })).toHaveCount(0);
  expect((await apiAs(comp, "POST", `/api/deals/${run().saleId}/closing/finalize`)).status).toBe(403);
});

test("broker: preview, finalize with a double-click (one CDA), view it, void it and issue the correction", async ({ browser }) => {
  const broker = await as(browser, "broker");
  await broker.goto(dealUrl("closing"));
  await expect(broker.getByText("ready to finalize")).toBeVisible();
  await expect(broker.getByText("$21,187.50").first()).toBeVisible(); // $18,750 + 13% HST, as the server computed it
  await shot(broker, "25-cda-preview");

  const finals: number[] = [];
  broker.on("response", (r) => { if (r.url().endsWith("/closing/finalize")) finals.push(r.status()); });
  await broker.getByRole("button", { name: "Finalize the CDA" }).click();
  await broker.getByRole("group", { name: "Finalize the CDA" }).getByRole("button", { name: "Finalize the CDA" }).dblclick();
  await expect(broker.getByText(/^CDA .* issued/)).toBeVisible();
  await expect.poll(() => finals.length).toBeGreaterThan(0);
  expect(finals.filter((s) => s === 201)).toHaveLength(1); // a second click, if sent, replays: never a second CDA

  await broker.getByRole("button", { name: "Show lawyer copy" }).click();
  const cda = broker.frameLocator("iframe[title='Commission direction']");
  await expect(cda.getByRole("heading", { name: "Commission Disbursement Authorization" })).toBeVisible();
  await shot(broker, "26-cda-issued");

  await broker.getByRole("button", { name: "Void the CDA" }).click();
  await broker.getByLabel("Reason").fill("Lawyer's name misspelled; reissuing");
  await broker.getByRole("button", { name: "Void", exact: true }).click();
  await expect(broker.getByText("ready to finalize")).toBeVisible();
  await broker.getByRole("button", { name: "Finalize the CDA" }).click();
  await broker.getByRole("group", { name: "Finalize the CDA" }).getByRole("button", { name: "Finalize the CDA" }).click();
  await expect(broker.getByText(/^CDA .*-R1 issued/)).toBeVisible();
});

test("available funds: the operating account, an attested obligations figure (entered by one person, attested by another)", async ({ browser }) => {
  const admin = await as(browser, "admin");
  await admin.goto("/admin/governance");
  await admin.getByRole("button", { name: "Add an operating account" }).click();
  await admin.getByLabel("Account name").fill("General Operating");
  await admin.getByLabel("Bank").fill("Test Bank");
  await admin.getByLabel("Last 4 digits").fill("2200");
  await admin.getByRole("button", { name: "Add account" }).click();
  await expect(admin.getByText("General Operating")).toBeVisible();

  const broker = await as(browser, "broker");
  await broker.goto("/admin/governance");
  const policy = broker.locator("li", { hasText: "Manual obligations procedure" });
  await policy.getByRole("button", { name: "Turn on" }).click();
  await policy.getByLabel("Sign-off reference").fill("Accountant's obligations procedure v1 (test)");
  await policy.getByRole("button", { name: "Turn on" }).click();
  await expect(policy.getByText("On", { exact: true })).toBeVisible();

  await admin.goto("/bank/funds");
  await expect(admin.getByText("Payouts blocked")).toBeVisible();
  await admin.getByRole("button", { name: "Enter obligations" }).click();
  await admin.getByLabel("Procedure reference").fill("Procedure v1: no unpaid bills this week (test)");
  await admin.getByRole("button", { name: "Save", exact: true }).click();
  await expect(admin.getByText("Not attested")).toBeVisible();
  await admin.getByRole("button", { name: "Attest" }).click();
  await admin.getByLabel("What you checked").fill("Payables list");
  await admin.getByRole("button", { name: "Attest", exact: true }).click();
  await expect(admin.getByRole("alert")).toBeVisible(); // the person who entered it can't attest it

  await broker.goto("/bank/funds");
  await broker.getByRole("button", { name: "Attest" }).click();
  await broker.getByLabel("What you checked").fill("Compared with the payables list and payroll");
  await broker.getByRole("button", { name: "Attest", exact: true }).click();
  await expect(broker.getByText("Attested by Blake Broker")).toBeVisible();
});

test("commission received in two parts: partial, duplicate and over-receipt are handled; nothing is payable until all of it is in", async ({ browser }) => {
  const admin = await as(browser, "admin");
  await admin.goto(dealUrl("closing"));
  const receive = async (amount: string, reference: string) => {
    await admin.getByRole("button", { name: "Record commission received" }).click();
    await admin.getByLabel("Amount").fill(amount);
    await admin.getByLabel("Reference").fill(reference);
    await admin.getByRole("button", { name: "Record", exact: true }).click();
  };
  await receive("10000.00", "WIRE-LAKESHORE-1");
  await expect(admin.getByText("partly received: payouts wait for the rest")).toBeVisible();
  await expect(admin.getByText(/Paying part of a commission isn't supported/).first()).toBeVisible();
  await shot(admin, "27-partial-receipt");
  const payoutId = (await apiAs(admin, "GET", `/api/deals/${run().saleId}/closing/payouts`)).body.payouts[0].id as string;
  remember({ payoutId });
  const broker = await as(browser, "broker");
  const early = await apiAs(broker, "POST", `/api/payouts/${payoutId}/approve`, {});
  expect([early.status, early.body.error.code]).toEqual([422, "COMMISSION_NOT_RECEIVED"]);

  await receive("10000.00", "WIRE-LAKESHORE-1");
  await expect(admin.getByRole("alert").filter({ hasText: "already recorded" })).toBeVisible();
  await admin.getByRole("button", { name: "Cancel" }).click();
  await receive("11187.51", "WIRE-LAKESHORE-2");
  await expect(admin.getByRole("alert").filter({ hasText: "is owed $21187.50" })).toBeVisible();
  await admin.getByRole("button", { name: "Cancel" }).click();
  await receive("11187.50", "WIRE-LAKESHORE-2");
  await expect(admin.getByText("Due $21,187.50 · received $21,187.50")).toBeVisible();
  await expect(admin.getByText("Received, but not yet matched to a bank file someone else verified.")).toBeVisible();
});

test("bank file for the operating account: imported by the admin, verified by the broker; the payout becomes ready", async ({ browser }) => {
  const admin = await as(browser, "admin");
  await admin.goto("/bank");
  await admin.getByRole("button", { name: "Import a bank file" }).click();
  await admin.getByLabel("Account").selectOption({ label: "General Operating ••2200 (operating)" });
  await admin.getByLabel("File", { exact: true }).selectOption("INTERIM");
  await admin.getByLabel("Period from").fill(day(0));
  await admin.getByLabel("Period to").fill(day(0));
  await admin.getByLabel("Closing balance").fill("21187.50");
  await admin.getByLabel("Received from the bank").fill(day(0));
  await admin.getByLabel("Date format in the file").selectOption("YMD");
  const csv = `Date,Description,Amount\n${day(0)},WIRE IN WIRE-LAKESHORE-1,10000.00\n${day(0)},WIRE IN WIRE-LAKESHORE-2,11187.50\n`;
  await admin.getByLabel("CSV file from the bank").setInputFiles({ name: "operating-today.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await admin.getByRole("button", { name: "Import", exact: true }).click();
  await expect(admin.getByText("2 of 2")).toBeVisible();
  const url = admin.url().replace(/^https?:\/\/[^/]+/, "");

  const broker = await as(browser, "broker");
  await broker.goto(url);
  await broker.getByRole("button", { name: "Verify against the bank" }).click();
  await broker.getByLabel("How you checked it").fill("Both wires seen in the bank portal");
  await broker.getByRole("button", { name: "Verified" }).click();
  await expect(broker.getByText("Verified by Blake Broker")).toBeVisible();
  await broker.goto(dealUrl("closing"));
  await expect(broker.getByText("Ready for approval")).toBeVisible();
});

test("approval: not by the admin; the broker approves, cancels, approves again", async ({ browser }) => {
  const admin = await as(browser, "admin");
  await admin.goto(dealUrl("closing"));
  await expect(admin.getByText("Ready for approval")).toBeVisible();
  await expect(admin.getByRole("button", { name: "Approve" })).toHaveCount(0);
  expect((await apiAs(admin, "POST", `/api/payouts/${run().payoutId}/approve`, {})).status).toBe(403);

  const broker = await as(browser, "broker");
  await broker.goto(dealUrl("closing"));
  const approve = async () => {
    await broker.getByRole("button", { name: "Approve" }).click();
    await broker.getByRole("button", { name: "Approve", exact: true }).last().click();
    await expect(broker.getByText("Approved", { exact: true }).first()).toBeVisible();
  };
  await approve();
  await broker.getByRole("button", { name: "Cancel", exact: true }).first().click();
  await broker.getByLabel("Reason").fill("Agent asked to change the paying account details first");
  await broker.getByRole("button", { name: "Cancel payout" }).click();
  await expect(broker.getByText("Ready for approval")).toBeVisible();
  await approve();
  await shot(broker, "28-payout-approved");
});

test("payment: the approver can't record it; the admin records it once even with a double-click; a returned payment is replaced", async ({ browser }) => {
  const broker = await as(browser, "broker");
  await broker.goto(dealUrl("closing"));
  await broker.getByRole("button", { name: "Record payment sent" }).click();
  await broker.getByLabel("Bank reference").fill("EFT-9001");
  await broker.getByRole("button", { name: "Record payment" }).click();
  await expect(broker.getByRole("alert").filter({ hasText: /different person/ })).toBeVisible();

  const admin = await as(browser, "admin");
  await admin.goto(dealUrl("closing"));
  await admin.getByRole("button", { name: "Record payment sent" }).click();
  await admin.getByLabel("Bank reference").fill("EFT-9001");
  await admin.getByRole("button", { name: "Record payment" }).dblclick();
  await expect(admin.getByText("Sent, not confirmed by the bank", { exact: true }).first()).toBeVisible(); // recorded, not yet on a verified bank file
  const paid = (await apiAs(admin, "GET", `/api/deals/${run().saleId}/closing/payouts`)).body.payouts[0];
  expect(paid.history.filter((h: { kind: string }) => h.kind === "PAID")).toHaveLength(1);

  await admin.getByRole("button", { name: "Payment came back" }).click();
  await admin.getByLabel("Reason").fill("Returned by the bank: account closed");
  await admin.getByLabel("Reference").fill("EFT-9001-RETURN");
  await admin.getByRole("button", { name: "Record returned payment" }).click();
  await expect(admin.getByText("Payment returned", { exact: true }).first()).toBeVisible();
  await admin.getByRole("button", { name: "Record payment sent" }).click();
  await admin.getByLabel("Bank reference").fill("EFT-9002");
  await admin.getByRole("button", { name: "Record payment" }).click();
  await expect(admin.getByText("Sent, not confirmed by the bank", { exact: true }).first()).toBeVisible();
  // Accounting counts only the replacement as outstanding: the returned payment is no longer "sent"
  const accounting = (await apiAs(admin, "GET", "/api/dashboard/oversight?view=accounting")).body;
  const unconfirmed = accounting.sections.flatMap((s: { metrics: { key: string; value: string }[] }) => s.metrics).find((m: { key: string }) => m.key === "payments.unconfirmed");
  expect(unconfirmed.value).toBe("13125.00");
  const final = (await apiAs(admin, "GET", `/api/deals/${run().saleId}/closing/payouts`)).body.payouts[0];
  expect(final.history.map((h: { kind: string }) => h.kind)).toEqual(["APPROVED", "CANCELLED", "APPROVED", "PAID", "PAYMENT_REVERSED", "PAID"]);
  await admin.getByText("History").last().click();
  await shot(admin, "29-payout-history");
});

test("trade record sheet: signing is refused, in plain words, until every item is complete", async ({ browser }) => {
  const agent = await as(browser, "agent");
  await agent.goto(dealUrl("record"));
  await agent.getByRole("button", { name: "Prepare the trade record sheet" }).click();
  await agent.getByRole("button", { name: "Sign as the agent" }).click();
  await agent.getByRole("group", { name: "Sign as the agent" }).getByRole("button", { name: "Sign as the agent" }).click();
  // The seller and the other brokerage's agent aren't on this deal yet
  await expect(agent.getByRole("alert").filter({ hasText: "Complete these items before signing: 4. Parties (both sides of the trade must be named)" })).toBeVisible();
  await expect(agent.getByText(/"amount"/)).toHaveCount(0); // no raw data in messages
  await expect(agent.getByText("Prepared; not signed")).toBeVisible();
  await shot(agent, "31-trade-record-incomplete");
});
