import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DepositBadge, PipelineBoard, PipelinePage } from "../src/pipeline/components/PipelineBoard.tsx";
import { demoPipeline } from "../src/pipeline/demo-data.ts";

const ENTITIES: Record<string, string> = { "&#x27;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">" };
const html = (node: JSX.Element) => renderToStaticMarkup(node);
const text = (node: JSX.Element) =>
  html(node).replace(/<[^>]+>/g, " ").replace(/&#x27;|&quot;|&amp;|&lt;|&gt;/g, (e) => ENTITIES[e]!).replace(/\s+/g, " ");

describe("pipeline board", () => {
  test("four columns in lifecycle order with counts", () => {
    const t = text(<PipelineBoard data={demoPipeline} />);
    const order = ["Active / Listed", "Conditional Offer", "Firm / Pending Close", "Closed (October)"].map((h) => t.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(t).toContain("11 on the board");
  });

  test("cards show address, MLS, agent and the price in Canadian dollars", () => {
    const t = text(<PipelineBoard data={demoPipeline} />);
    expect(t).toContain("1205 – 88 Queens Quay W");
    expect(t).toMatch(/MLS® W\d{7}/);
    expect(t).toContain("Agent Jane Smith");
    expect(t).toContain("$1,100,000");
    expect(t).toContain("Exclusive / not posted");
  });

  test("conditional cards show the condition deadline; firm cards the closing date", () => {
    const t = text(<PipelineBoard data={demoPipeline} />);
    expect(t).toContain("Conditions due Oct 19 · in 1d");
    expect(t).toContain("Closing Oct 21 · in 3d");
  });

  test("deposit badges: green when cleared, pulsing red when missing or late", () => {
    const markup = html(<PipelineBoard data={demoPipeline} />);
    expect(text(<PipelineBoard data={demoPipeline} />)).toContain("2 deposit issues");
    const red = html(<DepositBadge deposit={demoPipeline.columns.CONDITIONAL[1]!.deposit!} />);
    expect(red).toContain("motion-safe:animate-pulse");
    expect(red).toContain("Deposit Missing / Overdue");
    expect(red).toContain("$30,000 was due Oct 14");
    const green = html(<DepositBadge deposit={demoPipeline.columns.FIRM[1]!.deposit!} />);
    expect(green).toContain("Deposit Received &amp; Cleared");
    expect(green).not.toContain("animate-pulse");
    expect(markup).toContain("Deposited late to trust");
  });

  test("search pre-filled from a link narrows every column", () => {
    const t = text(<PipelineBoard data={demoPipeline} initialQuery="haddad" />);
    expect(t).toContain("4 of 11 match");
    expect(t).toContain("88 Bay St N");
    expect(t).not.toContain("Queens Quay");
    // A column with no hits says so instead of going blank
    expect(text(<PipelineBoard data={demoPipeline} initialQuery="smith" />)).toContain("No matches");
  });

  test("column totals use compact Canadian dollars", () => {
    const t = text(<PipelineBoard data={demoPipeline} initialQuery="haddad" />);
    expect(t).toContain("$649K");
    expect(t).not.toContain("$649.0K");
  });

  test("search with no results says so", () => {
    expect(text(<PipelineBoard data={demoPipeline} initialQuery="zzz" />)).toContain("Nothing matches “zzz”");
  });

  test("loading and error states", () => {
    expect(html(<PipelinePage state={{ status: "loading" }} onRetry={() => {}} />)).toContain('aria-busy="true"');
    expect(text(<PipelinePage state={{ status: "error", message: "Sign in required" }} onRetry={() => {}} />)).toContain("The pipeline didn't load");
  });
});
