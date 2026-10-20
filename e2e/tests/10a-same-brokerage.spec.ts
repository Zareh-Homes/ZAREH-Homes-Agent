/**
 * Both sides with our brokerage, in the browser (O. Reg. 567/05 s.22 to s.22.0.3; RECO Bulletins 2.2, 2.3, 3.2, 3.3).
 *
 * A fully compliant fictional $1,000,000 sale in Hamilton, 2% per side: Morgan acts for the seller and Jamie for the
 * buyer under separate designated representation agreements. The seller pays the listing side and $10,000 of the buyer
 * side; the buyer pays the other $10,000 under their own agreement. Not multiple representation, so no consents; each
 * client gets both agreements' remuneration terms in writing; each agent sees only their own client's records; the CDA
 * bills $40,000 + HST once, directs each lawyer to pay only their own client's part, and pays each agent from their own
 * side. The trade record (item 10: completion date) is signed by the agent and the broker of record.
 *
 * Then a multiple-representation deal: one agent for both clients under brokerage representation. It can't go firm
 * until compliance records each client's signed consent (uploaded), with when the multiple representation arose.
 */
import { test, expect, type Page } from "@playwright/test";
import { shot } from "../lib/people.ts";
import { apiAs, as, closeWindowsAfterEach } from "../lib/contexts.ts";
import { day, PDF, remember, run } from "../lib/state.ts";

test.describe.configure({ mode: "serial" });
closeWindowsAfterEach();

async function partyIds(page: Page, dealId: string) {
  const d = (await apiAs(page, "GET", `/api/deals/${dealId}`)).body.deal;
  const id = (role: string) => d.parties.find((p: { role: string }) => p.role === role).id as string;
  const agent = (first: string) => d.agents.find((a: { name: string }) => a.name.startsWith(first)).userId as string;
  return { seller: id("SELLER"), buyer: id("BUYER"), morgan: agent("Morgan"), jamie: agent("Jamie") };
}

const agreement = (page: Page, dealId: string, partyId: string, type: "BROKERAGE" | "DESIGNATED", reps: string[] = []) =>
  apiAs(page, "POST", `/api/deals/${dealId}/representation-agreements`, {
    partyId, type, ...(type === "DESIGNATED" ? { designatedRepresentativeIds: reps } : {}), signedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    effectiveFrom: day(-30), expiresOn: day(150), remunerationTerms: "2% of the sale price plus HST", services: "Full representation", terminationTerms: "On written notice" });

async function uploadId(page: Page, dealId: string, name: string) {
  await page.goto(`/deals/${dealId}/documents`);
  const slot = page.getByTestId("slot-FINTRAC_INDIVIDUAL");
  await expect(slot).toHaveCount(1); // only their own client's record
  await slot.getByRole("button", { name: "Upload" }).click();
  await slot.locator("input[type=file]").setInputFiles({ name: "id-record.pdf", mimeType: "application/pdf", buffer: PDF });
  for (const [label, value] of [["Full legal name", name], ["Date of birth", "1980-02-02"], ["Address", "1 Escarpment Cres, Hamilton ON"],
    ["Occupation", "Teacher"], ["ID number", "D1234-56789-01234"], ["Issued by", "Ontario"], ["ID expiry", "2031-02-02"], ["Verified on", day(-10)]] as const) {
    await slot.getByLabel(label).fill(value);
  }
  await slot.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(slot.getByText("Pending review")).toBeVisible();
}

test("two of our agents on opposite sides: the deal form takes each side's commission and each agent's side", async ({ browser }) => {
  // Jamie's commission plan (proposed in 09) approved by the broker, so both agents are paid under approved plans
  const broker = await as(browser, "broker");
  await broker.goto("/approvals");
  const waiting = (await apiAs(broker, "GET", "/api/work/approvals")).body.plans as { id: string; agent: string }[];
  for (const p of waiting.filter((x) => x.agent === "Jamie Rivera")) {
    expect((await apiAs(broker, "POST", `/api/commission-plans/${p.id}/approve`)).status).toBeLessThan(300);
  }

  const morgan = await as(browser, "agent");
  await morgan.goto("/deals/new");
  await morgan.getByLabel("Our side").selectOption("DUAL");
  await morgan.getByLabel("Street address").fill("1 Escarpment Cres");
  await morgan.getByLabel("City").fill("Hamilton");
  await morgan.getByLabel("Sale price").fill("1000000");
  await morgan.getByLabel("Offer date").fill(day(-5));
  await morgan.getByLabel("Closing date").fill(day(0));
  await morgan.getByLabel(/^Deposit( \*)?$/).fill("50000");
  await morgan.getByLabel("Who holds the deposit").selectOption("LAWYER");
  await morgan.getByLabel("Listing-side commission").fill("20000");
  await morgan.getByLabel("Buyer-side commission").fill("20000");
  await morgan.getByLabel("Of the buyer side, the seller pays").fill("10000");
  await morgan.getByLabel("Where each payment obligation is written").fill(
    "Listing agreement s.3: the seller pays the listing side and $10,000 of the buyer side; buyer's agreement s.4: the buyer pays the rest");
  const a1 = morgan.getByRole("group", { name: "Agent 1" });
  await a1.getByLabel("Represents").selectOption("LISTING");
  await a1.getByLabel("Split %").fill("70");
  await morgan.getByRole("button", { name: "Add an agent" }).click();
  const a2 = morgan.getByRole("group", { name: "Agent 2" });
  await a2.getByLabel("Agent").selectOption({ label: "Jamie Rivera" });
  await a2.getByLabel("Represents").selectOption("BUYER");
  await a2.getByLabel("Split %").fill("75");
  for (const [i, [role, name, rep]] of [["SELLER", "Ana Seller", "OUR_CLIENT"], ["BUYER", "Ben Buyer", "OUR_CLIENT"], ["SELLER_LAWYER", "Escarpment Law LLP", ""],
    ["BUYER_LAWYER", "Lakeview Legal LLP", ""]].entries()) {
    if (i > 0) await morgan.getByRole("button", { name: "Add a person" }).click();
    const p = morgan.getByRole("group", { name: `Person ${i + 1}` });
    await p.getByLabel("Role").selectOption(role!);
    await p.getByLabel("Full legal name").fill(name!);
    if (rep) await p.getByLabel("Representation").selectOption(rep);
    if (role === "SELLER_LAWYER") await p.getByLabel("Email").fill("closings@escarpmentlaw.test");
    if (role === "BUYER_LAWYER") await p.getByLabel("Email").fill("deals@lakeviewlegal.test");
  }
  await shot(morgan, "dual-01-new-deal");
  await morgan.getByRole("button", { name: "Open the deal" }).click();
  await expect(morgan).toHaveURL(/\/deals\/[0-9a-f-]{36}$/);
  const dealId = morgan.url().split("/").pop()!;
  remember({ dualId: dealId });
  await expect(morgan.getByText("listing side $20,000.00 · buyer side $20,000.00")).toBeVisible();
  await expect(morgan.getByText("Seller $30,000.00 · buyer $10,000.00 (each under their own agreement)")).toBeVisible();
  await expect(morgan.getByText(/Morgan Agent.*represents the seller|represents the seller/).first()).toBeVisible();
  await shot(morgan, "dual-02-overview");
});

test("separate designated representatives: not multiple representation; remuneration terms disclosed; each agent sees only their own client's records", async ({ browser }) => {
  const { dualId } = run();
  const morgan = await as(browser, "agent");
  const ids = await partyIds(morgan, dualId!);
  expect((await agreement(morgan, dualId!, ids.seller, "DESIGNATED", [ids.morgan])).status).toBe(201);
  const jamie = await as(browser, "agent2");
  expect((await agreement(jamie, dualId!, ids.buyer, "DESIGNATED", [ids.jamie])).status).toBe(201);
  // Jamie works only on his own client's records
  expect((await agreement(jamie, dualId!, ids.seller, "DESIGNATED", [ids.jamie])).status).toBe(403);

  await morgan.goto(`/deals/${dualId}/compliance`);
  await expect(morgan.getByText("Separate designated representatives: not multiple representation")).toBeVisible();
  await expect(morgan.getByText(/Multiple representation \(/)).toHaveCount(0);
  // Each client is told both agreements' remuneration terms in writing (RECO Bulletin 3.3): Morgan tells the seller here
  await expect(morgan.getByText("Give Ana Seller written disclosure of the remuneration terms in both representation agreements")).toBeVisible();
  await expect(morgan.getByText(/^Give Ben Buyer|^Ben Buyer: /)).toHaveCount(0); // the buyer's items are Jamie's
  await morgan.getByRole("button", { name: "A disclosure or consent" }).click();
  await morgan.getByLabel("What").selectOption({ label: "Both agreements' remuneration terms, in writing (we act for seller and buyer)" });
  await morgan.getByLabel("To").selectOption({ label: "Ana Seller (seller)" });
  await morgan.getByLabel("Delivered").fill(`${day(-6)}T10:00`);
  await morgan.getByLabel("How").fill("Emailed both agreements' remuneration clauses");
  await morgan.getByLabel("What was disclosed").fill("Seller's agreement: 2% to each side, $10,000 of the buyer side paid by the seller. Buyer's agreement: 2%, the rest paid by the buyer.");
  await morgan.getByRole("button", { name: "Record", exact: true }).scrollIntoViewIfNeeded();
  await morgan.screenshot({ path: "report/screens/dual-03a-remuneration-disclosure.png" });
  await morgan.getByRole("button", { name: "Record", exact: true }).click();
  await expect(morgan.getByText("Give Ana Seller written disclosure of the remuneration terms in both representation agreements")).toHaveCount(0);
  expect((await apiAs(jamie, "POST", `/api/deals/${dualId}/disclosures`, { kind: "REMUNERATION_DISCLOSURE", partyId: ids.buyer, deliveredAt: `${day(-6)}T11:00:00-04:00`,
    method: "Emailed both agreements' remuneration clauses", content: "Both agreements' remuneration terms" })).status).toBe(201);

  // The rest of a complete file: Information Guides and FINTRAC determinations, each by the client's own agent
  for (const [page, party] of [[morgan, ids.seller], [jamie, ids.buyer]] as const) {
    expect((await apiAs(page, "POST", `/api/deals/${dualId}/disclosures`, { kind: "INFORMATION_GUIDE", partyId: party, deliveredAt: `${day(-40)}T10:00:00-04:00`,
      explainedAt: `${day(-40)}T10:20:00-04:00`, acknowledgedAt: `${day(-40)}T10:25:00-04:00`, method: "In person" })).status).toBe(201);
    for (const [kind, result] of [["PEP_HIO", "NONE"], ["BUSINESS_RELATIONSHIP", "Purchase and sale of a principal residence"]] as const) {
      expect((await apiAs(page, "POST", `/api/parties/${party}/fintrac-determinations`, { kind, result, riskRating: "LOW", details: "Asked and recorded at the meeting" })).status).toBe(201);
    }
  }
  await morgan.goto(`/deals/${dualId}/compliance`);
  await shot(morgan, "dual-03-separate-designated");

  await uploadId(morgan, dualId!, "Ana Seller");
  await expect(morgan.getByText("Ben Buyer")).toHaveCount(0); // the buyer's record belongs to Jamie
  await uploadId(jamie, dualId!, "Ben Buyer");
  const comp = await as(browser, "compliance");
  await comp.goto("/compliance");
  for (const name of ["Ana Seller", "Ben Buyer"]) {
    await comp.locator("li", { hasText: name }).getByRole("button", { name: "Review" }).click();
    await comp.getByRole("button", { name: "Approve" }).click();
    await expect(comp.locator("li", { hasText: name })).toHaveCount(0);
  }
  // Nothing outstanding for the broker of record
  const ob = (await apiAs(comp, "GET", `/api/deals/${dualId}/obligations`)).body;
  expect([...ob.tresa, ...ob.fintrac].filter((f: { severity: string }) => f.severity === "BLOCKING").map((f: { message: string }) => f.message)).toEqual([]);

  // No consents needed: the deal goes firm and closes
  await morgan.goto(`/deals/${dualId}/overview`);
  await morgan.getByRole("button", { name: "Mark firm" }).click();
  await morgan.getByRole("group", { name: "Mark firm" }).getByRole("button", { name: "Mark firm" }).click();
  await morgan.getByRole("button", { name: "Record the closing" }).click();
  await morgan.getByLabel("Closed on").fill(day(0));
  await morgan.getByRole("button", { name: "Mark closed" }).click();
  await expect(morgan.getByText("Closed", { exact: true }).first()).toBeVisible();
  await expect(morgan.getByText("Trade record sheet: not prepared yet")).toBeVisible();
});

test("the CDA bills $40,000 + HST once, directs each lawyer to pay only their own client's part, and gives each agent their own statement", async ({ browser }) => {
  const { dualId } = run();
  const broker = await as(browser, "broker");
  await broker.goto(`/deals/${dualId}/closing`);
  await expect(broker.getByText("ready to finalize")).toBeVisible();
  await expect(broker.getByText("$40,000.00 + HST $5,200.00 = $45,200.00")).toBeVisible();
  await expect(broker.getByText("listing side $20,000.00 · buyer side $20,000.00 (billed once)")).toBeVisible();
  // Each client pays under their own agreement: never assumed to be the seller's lawyer for everything
  await expect(broker.getByText("$33,900.00 through Escarpment Law LLP")).toBeVisible();
  await expect(broker.getByText("$11,300.00 through Lakeview Legal LLP")).toBeVisible();
  await expect(broker.getByText("HST collected on the commission")).toBeVisible();
  await expect(broker.getByText("Represents the seller: $20,000.00 from the listing side")).toBeVisible();
  await expect(broker.getByText("Represents the buyer: $20,000.00 from the buyer side")).toBeVisible();
  // Morgan 70% of $20,000; Jamie 75% of $20,000; the brokerage keeps $6,000 + $5,000, once
  await expect(broker.getByRole("cell", { name: "$14,000.00" }).first()).toBeVisible();
  await expect(broker.getByRole("cell", { name: "$15,000.00" }).first()).toBeVisible();
  await expect(broker.getByText("$11,000.00").first()).toBeVisible();
  await expect(broker.getByText("Co-operating brokerage")).toHaveCount(0); // our own agent is never treated as a co-op
  await shot(broker, "dual-04-cda-preview");

  await broker.getByRole("button", { name: "Finalize the CDA" }).click();
  await broker.getByRole("group", { name: "Finalize the CDA" }).getByRole("button", { name: "Finalize the CDA" }).click();
  await expect(broker.getByText(/^CDA .* issued/)).toBeVisible();
  await broker.getByRole("button", { name: "Internal copy" }).click();
  const cda = broker.frameLocator("iframe[title='Commission direction']");
  await expect(cda.getByText("of which listing side (seller's agreement)")).toBeVisible();
  await expect(cda.getByRole("heading", { name: "Morgan Agent" })).toBeVisible();
  await expect(cda.getByRole("heading", { name: "Jamie Rivera" })).toBeVisible();
  await expect(cda.getByText(/Represents the seller: \$20,000\.00 from the listing side/)).toBeVisible();
  await expect(cda.getByText(/Represents the buyer: \$20,000\.00 from the buyer side/)).toBeVisible();
  await expect(broker.getByText(/No approved commission plan/)).toHaveCount(0); // both agents paid under approved plans
  await cda.getByRole("heading", { name: "Morgan Agent" }).scrollIntoViewIfNeeded();
  await broker.locator("iframe[title='Commission direction']").screenshot({ path: "report/screens/dual-05-cda-statements.png" });
  await broker.getByRole("button", { name: "Show lawyer copy" }).click();
  await expect(cda.getByText("Payable by the buyer, through Lakeview Legal LLP")).toBeVisible();
  await expect(cda.getByText(/directs Escarpment Law LLP to pay \$33,900\.00 .* and Lakeview Legal LLP to pay \$11,300\.00/)).toBeVisible();
  await expect(cda.getByText(/Buyer\(s\) acknowledgment – Ben Buyer/)).toBeVisible();
  await cda.getByRole("heading", { name: "4. Payment instructions" }).scrollIntoViewIfNeeded();
  await broker.locator("iframe[title='Commission direction']").screenshot({ path: "report/screens/dual-05b-cda-payers.png" });
  const payouts = (await apiAs(broker, "GET", `/api/deals/${dualId}/closing/payouts`)).body.payouts as { payeeName: string; amount: string }[];
  expect(payouts.map((p) => [p.payeeName, p.amount]).sort()).toEqual([["Jamie Rivera", "15000.00"], ["Morgan Agent", "14000.00"]]);
  await broker.goto(`/deals/${dualId}/record`);
  const prepare = broker.getByRole("button", { name: "Prepare the trade record sheet" });
  const record = broker.getByRole("heading", { name: "Record", exact: true });
  await expect(prepare.or(record)).toBeVisible();
  if (await prepare.isVisible()) await prepare.click();
  await expect(record).toBeVisible();
  // Item 10: the scheduled completion date (no amendment)
  await expect(broker.getByText("10. Completion date (scheduled, and amended if any)")).toBeVisible();
  // Signed by the agent, then reviewed and signed by the broker of record (s.17(3), (5))
  const morgan = await as(browser, "agent");
  expect((await apiAs(morgan, "POST", `/api/deals/${dualId}/trade-record/sign`, {})).status).toBe(200);
  expect((await apiAs(broker, "POST", `/api/deals/${dualId}/trade-record/broker-sign`, {})).status).toBe(200);
  await broker.reload();
  await expect(broker.getByText(/^Signed by the broker of record/)).toBeVisible();
  await shot(broker, "dual-06-trade-record");
  await broker.goto(`/deals/${dualId}/overview`);
  await expect(broker.getByText(/^Trade record sheet:/)).toHaveCount(0); // nothing left on the deal's next steps
});

test("one agent on both sides under brokerage representation: no firm deal until compliance records each client's signed consent", async ({ browser }) => {
  const morgan = await as(browser, "agent");
  const res = await apiAs(morgan, "POST", "/api/deals", {
    side: "DUAL", streetAddress: "9 Ridge Rd", city: "Grimsby", salePrice: "1000000", offerDate: day(-2), closeDate: day(40),
    depositAmount: "50000", trustDepositHolder: "LAWYER", listingSideGci: "20000", buyerSideGci: "20000",
    buyerSideSellerPays: "20000", remunerationSource: "Listing agreement s.3: the seller pays 2% to each side",
    agents: [{ userId: (await apiAs(morgan, "GET", "/api/auth/me")).body.id, role: "PRIMARY", splitPct: 70, side: "BOTH" }],
    parties: [{ role: "SELLER", fullName: "Cora Seller", representation: "OUR_CLIENT" }, { role: "BUYER", fullName: "Dev Buyer", representation: "OUR_CLIENT" }],
  });
  expect(res.status).toBe(201);
  const dealId = res.body.deal.id as string;
  const d = (await apiAs(morgan, "GET", `/api/deals/${dealId}`)).body.deal;
  const [seller, buyer] = ["SELLER", "BUYER"].map((r) => d.parties.find((p: { role: string }) => p.role === r).id as string);
  for (const p of [seller!, buyer!]) {
    expect((await agreement(morgan, dealId, p, "BROKERAGE")).status).toBe(201);
    expect((await apiAs(morgan, "POST", `/api/deals/${dealId}/disclosures`, { kind: "REMUNERATION_DISCLOSURE", partyId: p, deliveredAt: `${day(-20)}T10:00:00-04:00`,
      method: "Email", content: "Both agreements: 2% to each side, paid by the seller" })).status).toBe(201);
  }

  await morgan.goto(`/deals/${dealId}/compliance`);
  await expect(morgan.getByText("Multiple representation (brokerage representation)")).toBeVisible();
  await morgan.goto(`/deals/${dealId}/overview`);
  await morgan.getByRole("button", { name: "Mark firm" }).click();
  await morgan.getByRole("group", { name: "Mark firm" }).getByRole("button", { name: "Mark firm" }).click();
  await expect(morgan.getByRole("alert").filter({ hasText: /written disclosure and consent/ })).toBeVisible();
  await shot(morgan, "dual-07-consent-required");

  // The agent delivers the written disclosure, saying what it explained; the consent is compliance's to record
  for (const p of [seller!, buyer!]) {
    expect((await apiAs(morgan, "POST", `/api/deals/${dealId}/disclosures`, { kind: "MULTIPLE_REPRESENTATION_DISCLOSURE", partyId: p,
      deliveredAt: `${day(-20)}T10:00:00-04:00`, acknowledgedAt: `${day(-20)}T10:30:00-04:00`, method: "Written disclosure, signed",
      confirms: ["DUTIES", "SERVICES", "REMUNERATION", "INDEPENDENT_ADVICE"] })).status).toBe(201);
  }
  const comp = await as(browser, "compliance");
  // The signed consents, uploaded to the slot that appeared when consent became necessary
  await comp.goto(`/deals/${dealId}/documents`);
  const slot = comp.getByTestId("slot-REPRESENTATION_CONSENTS");
  await expect(slot).toHaveCount(1);
  await slot.getByRole("button", { name: "Upload" }).click();
  await slot.locator("input[type=file]").setInputFiles({ name: "signed-consents.pdf", mimeType: "application/pdf", buffer: PDF });
  await slot.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(slot.getByText("Pending review")).toBeVisible();
  const file = (await apiAs(comp, "GET", `/api/deals/${dealId}/documents`)).body.slots.find((x: { code: string }) => x.code === "REPRESENTATION_CONSENTS").latestFile.id;
  expect((await apiAs(morgan, "POST", `/api/deals/${dealId}/disclosures`, { kind: "MULTIPLE_REPRESENTATION_CONSENT", partyId: seller,
    deliveredAt: `${day(-20)}T10:00:00-04:00`, method: "Signed consent", acknowledgedAt: `${day(-20)}T10:40:00-04:00`, situationAroseOn: day(-20), documentFileId: file })).status).toBe(403);

  // Compliance records the seller's consent in the form: when it was signed, when the multiple representation arose, the signed copy
  await comp.goto(`/deals/${dealId}/compliance`);
  await comp.getByRole("button", { name: "A disclosure or consent" }).click();
  await comp.getByLabel("What").selectOption({ label: "Multiple representation: client's signed consent" });
  await comp.getByLabel("To").selectOption({ label: "Cora Seller (seller)" });
  await comp.getByLabel("Delivered").fill(`${day(-20)}T10:00`);
  await comp.getByLabel("How").fill("Signed consent (RECO-approved wording)");
  await comp.getByLabel("Consent signed").fill(`${day(-20)}T10:40`);
  await comp.getByLabel("When the multiple representation arose").fill(day(-20));
  await expect(comp.getByText(/Signed copy: signed-consents\.pdf/)).toBeVisible();
  await comp.getByRole("button", { name: "Record", exact: true }).scrollIntoViewIfNeeded();
  await comp.screenshot({ path: "report/screens/dual-08-consent-form.png" }); // the form in view, without the sticky header over a long page
  await comp.getByRole("button", { name: "Record", exact: true }).click();
  await expect(comp.getByText(/give Cora Seller the written disclosure/)).toHaveCount(0);
  expect((await apiAs(comp, "POST", `/api/deals/${dealId}/disclosures`, { kind: "MULTIPLE_REPRESENTATION_CONSENT", partyId: buyer,
    deliveredAt: `${day(-20)}T10:00:00-04:00`, method: "Signed consent", acknowledgedAt: `${day(-20)}T10:45:00-04:00`, situationAroseOn: day(-20), documentFileId: file })).status).toBe(201);
  expect((await apiAs(morgan, "POST", `/api/deals/${dealId}/firm`)).status).toBe(200);
  await comp.reload();
  await expect(comp.getByText(/Multiple representation \(brokerage/)).toBeVisible();
  await expect(comp.getByText(/written disclosure and get their signed written consent/)).toHaveCount(0);
  await shot(comp, "dual-09-consents-recorded");
});
