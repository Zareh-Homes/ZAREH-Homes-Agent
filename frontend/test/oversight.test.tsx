import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { formatValue, OversightPanel } from "../src/oversight/OversightPanel.tsx";
import type { OversightView } from "../src/oversight/types.ts";

const view: OversightView = {
  view: "broker", asOf: "2026-10-18T14:00:00.000Z",
  sections: [{ title: "Trust", metrics: [
    { key: "trust.total", label: "Held in real estate trust", value: "125000.00", unit: "CAD", status: "ok", asOf: "2026-10-18T14:00:00.000Z",
      definition: "Sum of every deal's trust ledger balance", source: "Trust ledger" },
    { key: "trust.openShortfalls", label: "Open trust shortfalls", value: 1, unit: "count", status: "critical", asOf: "2026-10-18T14:00:00.000Z",
      definition: "Shortfall incidents not yet resolved", source: "Trust incidents", items: ["Trust: $12.50 since 2026-10-17"] },
  ] }],
};

describe("oversight panel", () => {
  test("every figure shows its definition, source and as-of time, and status in words", () => {
    const html = renderToStaticMarkup(<OversightPanel data={view} />);
    expect(html).toContain("Broker of record");
    expect(html).toContain("Sum of every deal&#x27;s trust ledger balance");
    expect(html).toContain("Trust ledger");
    expect(html.match(/As of/g)!.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("Act now");
    expect(html).toContain("Trust: $12.50 since 2026-10-17");
  });

  test("money is formatted; a missing figure shows a dash, not zero", () => {
    expect(formatValue(view.sections[0]!.metrics[0]!)).toBe("$125,000.00");
    expect(formatValue({ ...view.sections[0]!.metrics[0]!, value: null })).toBe("—");
  });
});
