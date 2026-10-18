/**
 * Accounting system adapters: QuickBooks Online and Xero.
 *
 * Read-only by design. The one thing the back office reads is the operating
 * account's open payables (bills not yet paid), so the available-funds check
 * can subtract obligations this system doesn't pay. Posting journals to a
 * live ledger is not implemented: postJournal always refuses, and the journal
 * is exported for the accountant instead (see journal.ts).
 *
 * Nothing here holds credentials. The caller supplies an access-token
 * function (OAuth 2.0 is the accounting provider's; tokens are kept outside
 * this codebase) and, in tests, a fake fetch.
 */

import { parseAmount, type Cents } from "../lib/money.ts";

export interface ObligationLine {
  externalId: string;
  description: string;
  payee: string | null;
  dueDate: string | null;
  amount: Cents;
}

export interface AccountingAdapter {
  readonly provider: "QUICKBOOKS_ONLINE" | "XERO";
  /** Where the figures came from, for the record: provider and company / tenant */
  readonly sourceLabel: string;
  openPayables(asOf: string): Promise<ObligationLine[]>;
  postJournal(entries: unknown): Promise<never>;
}

export class AccountingError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export class AccountingPostingDisabled extends Error {
  constructor() {
    super("Posting to the accounting system is disabled; export the journal for the accountant instead");
  }
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface Common {
  accessToken: () => Promise<string>;
  fetch?: Fetch;
}

const money = (v: unknown, what: string): Cents => {
  const n = typeof v === "number" ? v.toFixed(2) : typeof v === "string" ? v : null;
  const negative = n?.startsWith("-");
  const c = n === null ? null : parseAmount(negative ? n.slice(1) : n);
  if (c === null) throw new AccountingError(`Unreadable amount for ${what}: ${JSON.stringify(v)}`, 502);
  return negative ? -c : c;
};

async function getJson(f: Fetch, url: string, token: string, extra: Record<string, string> = {}) {
  const res = await f(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...extra } });
  if (!res.ok) {
    throw new AccountingError(res.status === 401 ? "The accounting connection needs to be re-authorized" : `Accounting system returned ${res.status}`,
      res.status === 401 ? 401 : 502);
  }
  return res.json();
}

/** QuickBooks Online Accounting API v3: unpaid bills (Balance > 0). */
export class QuickBooksOnlineAdapter implements AccountingAdapter {
  readonly provider = "QUICKBOOKS_ONLINE" as const;
  readonly sourceLabel: string;
  readonly #opts: Common & { realmId: string; baseUrl: string };

  constructor(opts: Common & { realmId: string; baseUrl?: string }) {
    this.#opts = { ...opts, baseUrl: opts.baseUrl ?? "https://quickbooks.api.intuit.com" };
    this.sourceLabel = `QuickBooks Online company ${opts.realmId}`;
  }

  async openPayables(asOf: string): Promise<ObligationLine[]> {
    const f = this.#opts.fetch ?? (globalThis.fetch as unknown as Fetch);
    const out: ObligationLine[] = [];
    for (let start = 1; ; start += 1000) {
      const query = `SELECT * FROM Bill WHERE Balance > '0' AND TxnDate <= '${asOf}' STARTPOSITION ${start} MAXRESULTS 1000`;
      const url = `${this.#opts.baseUrl}/v3/company/${encodeURIComponent(this.#opts.realmId)}/query?query=${encodeURIComponent(query)}&minorversion=75`;
      const body = await getJson(f, url, await this.#opts.accessToken()) as { QueryResponse?: { Bill?: Record<string, unknown>[] } };
      const bills = body.QueryResponse?.Bill ?? [];
      for (const b of bills) {
        const vendor = (b.VendorRef as { name?: string } | undefined)?.name ?? null;
        out.push({
          externalId: `Bill:${String(b.Id)}`,
          description: `Bill ${b.DocNumber ?? b.Id}${vendor ? ` from ${vendor}` : ""}`,
          payee: vendor,
          dueDate: typeof b.DueDate === "string" ? b.DueDate : null,
          amount: money(b.Balance, `bill ${String(b.Id)}`),
        });
      }
      if (bills.length < 1000) return out;
    }
  }

  postJournal(): Promise<never> {
    return Promise.reject(new AccountingPostingDisabled());
  }
}

/** Xero Accounting API: authorised bills (ACCPAY invoices) with an amount still due. */
export class XeroAdapter implements AccountingAdapter {
  readonly provider = "XERO" as const;
  readonly sourceLabel: string;
  readonly #opts: Common & { tenantId: string; baseUrl: string };

  constructor(opts: Common & { tenantId: string; baseUrl?: string }) {
    this.#opts = { ...opts, baseUrl: opts.baseUrl ?? "https://api.xero.com/api.xro/2.0" };
    this.sourceLabel = `Xero organisation ${opts.tenantId}`;
  }

  async openPayables(asOf: string): Promise<ObligationLine[]> {
    const f = this.#opts.fetch ?? (globalThis.fetch as unknown as Fetch);
    const [y, m, d] = asOf.split("-");
    const out: ObligationLine[] = [];
    for (let page = 1; ; page++) {
      const where = `Type=="ACCPAY" AND Status=="AUTHORISED" AND Date<=DateTime(${y},${m},${d})`;
      const url = `${this.#opts.baseUrl}/Invoices?where=${encodeURIComponent(where)}&page=${page}`;
      const body = await getJson(f, url, await this.#opts.accessToken(), { "xero-tenant-id": this.#opts.tenantId }) as {
        Invoices?: Record<string, unknown>[];
      };
      const invoices = body.Invoices ?? [];
      for (const i of invoices) {
        const due = money(i.AmountDue, `bill ${String(i.InvoiceID)}`);
        if (due <= 0) continue;
        const contact = (i.Contact as { Name?: string } | undefined)?.Name ?? null;
        out.push({
          externalId: `Invoice:${String(i.InvoiceID)}`,
          description: `Bill ${i.InvoiceNumber ?? i.InvoiceID}${contact ? ` from ${contact}` : ""}`,
          payee: contact,
          dueDate: typeof i.DueDateString === "string" ? i.DueDateString.slice(0, 10) : null,
          amount: due,
        });
      }
      if (invoices.length < 100) return out; // Xero pages hold 100
    }
  }

  postJournal(): Promise<never> {
    return Promise.reject(new AccountingPostingDisabled());
  }
}

