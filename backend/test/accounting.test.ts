import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountingError, AccountingPostingDisabled, QuickBooksOnlineAdapter, XeroAdapter } from "../src/accounting/adapter.ts";
import { buildJournal, journalCsv } from "../src/accounting/journal.ts";

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("QuickBooks Online: pages through unpaid bills as of the date, read-only", async () => {
  const urls: string[] = [];
  const page = (n: number, start: number) => Array.from({ length: n }, (_, i) => ({ Id: String(start + i), Balance: 10, VendorRef: { name: "V" } }));
  const qbo = new QuickBooksOnlineAdapter({
    realmId: "123", accessToken: async () => "t", baseUrl: "https://sandbox-quickbooks.api.intuit.com",
    fetch: async (url) => {
      urls.push(url);
      return reply({ QueryResponse: { Bill: urls.length === 1 ? page(1000, 1) : page(3, 1001) } });
    },
  });
  const lines = await qbo.openPayables("2026-12-10");
  assert.equal(lines.length, 1003);
  assert.equal(lines.reduce((s, l) => s + l.amount, 0), 1003 * 1000);
  assert.equal(urls.length, 2);
  assert.match(decodeURIComponent(urls[1]!), /Balance > '0' AND TxnDate <= '2026-12-10' STARTPOSITION 1001 MAXRESULTS 1000/);
  await assert.rejects(qbo.postJournal(), AccountingPostingDisabled);
});

test("QuickBooks Online: an expired authorization or a bad amount is an error, never a zero", async () => {
  const expired = new QuickBooksOnlineAdapter({ realmId: "1", accessToken: async () => "t", fetch: async () => reply({}, 401) });
  await assert.rejects(expired.openPayables("2026-12-10"), (e: unknown) => e instanceof AccountingError && e.status === 401);
  const garbled = new QuickBooksOnlineAdapter({ realmId: "1", accessToken: async () => "t", fetch: async () => reply({ QueryResponse: { Bill: [{ Id: "9", Balance: "lots" }] } }) });
  await assert.rejects(garbled.openPayables("2026-12-10"), /Unreadable amount for bill 9/);
});

test("Xero: authorised bills with an amount due, tenant header sent", async () => {
  let headers: Record<string, string> = {};
  let url = "";
  const xero = new XeroAdapter({
    tenantId: "tenant-1", accessToken: async () => "t",
    fetch: async (u, init) => {
      url = u;
      headers = init.headers;
      return reply({ Invoices: [
        { InvoiceID: "a", InvoiceNumber: "B-1", AmountDue: 250.5, Contact: { Name: "Landlord" }, DueDateString: "2026-12-31T00:00:00" },
        { InvoiceID: "b", AmountDue: 0 },
      ] });
    },
  });
  const lines = await xero.openPayables("2026-12-10");
  assert.deepEqual(lines, [{ externalId: "Invoice:a", description: "Bill B-1 from Landlord", payee: "Landlord", dueDate: "2026-12-31", amount: 25_050 }]);
  assert.equal(headers["xero-tenant-id"], "tenant-1");
  assert.match(decodeURIComponent(url), /Type=="ACCPAY" AND Status=="AUTHORISED" AND Date<=DateTime\(2026,12,10\)/);
});

test("journal: every movement balances; unmapped roles are flagged; CSV can't carry a formula", () => {
  const entries = buildJournal([
    { id: "p1", date: "2026-12-02", kind: "PAYOUT_SENT", amount: 600_000, dealNumber: "D-1", reference: "=HYPERLINK(1)", bank: "BANK_OPERATING",
      payable: "AGENT_COMMISSION_PAYABLE", payee: "Ava Agent PREC" },
    { id: "r1", date: "2026-12-01", kind: "COMMISSION_RECEIVED", amount: 800_000, dealNumber: "D-1", reference: "WIRE", bank: "BANK_OPERATING" },
  ], { BANK_OPERATING: "1010", COMMISSION_CLEARING: "2150" });
  assert.deepEqual(entries.map((e) => [e.sourceId, e.ready]), [["r1", true], ["p1", false]]);
  for (const e of entries) {
    const debit = e.lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = e.lines.reduce((s, l) => s + Number(l.credit), 0);
    assert.equal(debit, credit);
  }
  assert.equal(entries[1]!.memo, "Payout sent · D-1 · Ava Agent PREC");
  const csv = journalCsv(entries);
  assert.ok(csv.includes("'=HYPERLINK(1)"));
  assert.ok(csv.includes("AGENT_COMMISSION_PAYABLE,UNMAPPED,6000.00,0.00"));
});
