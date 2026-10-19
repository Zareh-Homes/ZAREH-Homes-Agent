import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Dashboard, DashboardPage } from "../src/dashboard/components/Dashboard.tsx";
import { CapTracker } from "../src/dashboard/components/AgentDashboard.tsx";
import { demoBrokerage, demoPersonal, demoResponses } from "../src/dashboard/demo-data.ts";
import type { DashboardResponse } from "../src/dashboard/types.ts";

const html = (node: JSX.Element) => renderToStaticMarkup(node);
/** Text only, so assertions don't depend on markup */
const ENTITIES: Record<string, string> = { "&#x27;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">" };
const text = (node: JSX.Element) =>
  html(node).replace(/<[^>]+>/g, " ").replace(/&#x27;|&quot;|&amp;|&lt;|&gt;/g, (e) => ENTITIES[e]!).replace(/\s+/g, " ");

describe("role-based layout", () => {
  test("compliance admin gets the brokerage view only, no toggle", () => {
    const t = text(<Dashboard data={demoResponses.admin!} />);
    expect(t).toContain("Brokerage overview");
    expect(t).toContain("Company dollar YTD");
    expect(t).toContain("Statutory trust account");
    expect(t).toContain("FINTRAC exceptions");
    expect(t).not.toContain("Commission cap");
    expect(html(<Dashboard data={demoResponses.admin!} />)).not.toContain('role="tablist"');
  });

  test("agent gets their own business only", () => {
    const t = text(<Dashboard data={demoResponses.agent!} />);
    expect(t).toContain("Your business");
    expect(t).toContain("Volume sold YTD");
    expect(t).not.toContain("Company dollar");
    expect(t).not.toContain("Statutory trust account");
  });

  test("managing broker who also sells gets a Brokerage / My business toggle", () => {
    const markup = html(<Dashboard data={demoResponses.broker!} />);
    expect(markup).toContain('role="tablist"');
    expect(markup).toMatch(/aria-selected="true"[^>]*>Brokerage</);
  });
});

describe("admin widgets", () => {
  test("financial summary: company dollar, volume, net HST estimate", () => {
    const t = text(<Dashboard data={demoResponses.admin!} />);
    expect(t).toContain("$186,425");
    expect(t).toContain("$42.2M");
    expect(t).toContain("Net HST on closed deals YTD (est.) $24,235");
  });

  test("trust widget: total and every deal past closing still holding funds", () => {
    const t = text(<Dashboard data={demoResponses.admin!} />);
    expect(t).toContain("$612,500");
    expect(t).toContain("2026-0117");
    expect(t).toContain("17 days ago");
    expect(t).toContain("On hold");
  });

  test("trust widget: money not yet cleared at the bank, and each account's reconciliation status", () => {
    const t = text(<Dashboard data={demoResponses.admin!} />);
    expect(t).toContain("$50,000.00 is recorded but not yet confirmed by a bank file");
    expect(t).toContain("1 month to sign · due Nov 2"); // 30 days after the statement arrived, not after month end
    expect(t).toContain("Signed to Sep 30");
    expect(t).toContain("$12.50 shortfall in Pre-construction Trust.");
    expect(t).toContain("Notify the RECO registrar and replenish");
  });

  test("compliance queue: overdue first, each missing record named with its client", () => {
    const t = text(<Dashboard data={demoResponses.admin!} />);
    expect(t).toContain("1 day overdue");
    expect(t).toContain("Maria Santos");
    expect(t).toContain("Not set up");
    expect(t.indexOf("2026-0148")).toBeLessThan(t.indexOf("2026-0160"));
  });

  test("empty states say all clear instead of showing an empty table", () => {
    const quiet: DashboardResponse = {
      ...demoResponses.admin!,
      brokerage: { ...demoBrokerage, complianceQueue: [], trust: { ...demoBrokerage.trust, pastClosing: [] } },
    };
    const t = text(<Dashboard data={quiet} />);
    expect(t).toContain("Every firm deal closing in the next 14 days is FINTRAC approved.");
    expect(t).toContain("No deal is holding trust funds past its closing date.");
  });
});

describe("agent widgets", () => {
  test("PREC panel shows HST received, labelled exactly", () => {
    const t = text(<Dashboard data={demoResponses.agent!} />);
    expect(t).toContain("HST Received on Commissions YTD $29,458");
    expect(t).toContain("Jane Smith Real Estate Professional Corporation");
  });

  test("no PREC panel for agents who aren't a PREC", () => {
    const notPrec = { ...demoResponses.agent!, personal: { ...demoPersonal, prec: null } };
    expect(text(<Dashboard data={notPrec} />)).not.toContain("HST Received on Commissions YTD");
  });

  test("cap tracker: '$12,450 paid of $15,000 cap' with an accessible meter", () => {
    const markup = html(<CapTracker cap={demoPersonal.cap} year={2026} />);
    expect(markup).toContain("$12,450 paid of $15,000 cap");
    expect(markup).toContain('role="meter"');
    expect(markup).toContain('aria-valuenow="1245000"');
    expect(markup).toContain('aria-valuemax="1500000"');
    expect(markup).toContain("width:83%");
  });

  test("cap tracker: capped and no-cap states", () => {
    const capped = text(<CapTracker cap={{ ...demoPersonal.cap!, paidCents: 1_500_000 }} year={2026} />);
    expect(capped).toContain("Capped · 100% split");
    expect(text(<CapTracker cap={null} year={2026} />)).toContain("Your plan has no annual cap.");
  });

  test("document warnings show the reviewer's comment and an upload action", () => {
    const t = text(<Dashboard data={demoResponses.agent!} />);
    expect(t).toContain("APS missing Seller initials on page 3");
    expect(t).toContain("Daniel Zareh");
    expect(t).toContain("Upload revision");
  });
});

describe("page states", () => {
  test("loading and error", () => {
    expect(html(<DashboardPage state={{ status: "loading" }} onRetry={() => {}} />)).toContain('aria-busy="true"');
    const err = text(<DashboardPage state={{ status: "error", message: "Sign in required" }} onRetry={() => {}} />);
    expect(err).toContain("The dashboard didn't load");
    expect(err).toContain("Sign in required");
  });
});
