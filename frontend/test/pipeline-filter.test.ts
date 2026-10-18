import { test } from "node:test";
import assert from "node:assert/strict";
import { cardMatches, filterColumns } from "../src/pipeline/filter.ts";
import { demoPipeline } from "../src/pipeline/demo-data.ts";
import type { PipelineCard } from "../src/pipeline/types.ts";

const card = (over: Partial<PipelineCard>): PipelineCard => ({
  id: "c", kind: "DEAL", href: "#", dealNumber: "2026-0150", side: "LISTING", address: "1205 – 88 Queens Quay W",
  city: "Toronto", mlsNumber: "C1234567", agentName: "Jane Smith", priceCents: 1, priceLabel: "Sale price",
  keyDate: null, deposit: null, finalized: false, ...over,
});

test("matches agent name, MLS number and street address, ignoring case and punctuation", () => {
  const c = card({});
  assert.ok(cardMatches(c, "SMITH"));
  assert.ok(cardMatches(c, "c1234"));
  assert.ok(cardMatches(c, "1234567")); // without the board letter
  assert.ok(cardMatches(c, "queens quay"));
  assert.ok(cardMatches(c, "  ")); // empty search shows everything
  assert.ok(!cardMatches(c, "Toronto")); // city isn't a search field
  assert.ok(!cardMatches(c, "Haddad"));
});

test("every word must match something: 'smith queens' narrows, 'smith barton' finds nothing", () => {
  const c = card({});
  assert.ok(cardMatches(c, "smith queens"));
  assert.ok(!cardMatches(c, "smith barton"));
});

test("accents don't matter", () => {
  assert.ok(cardMatches(card({ agentName: "Zoë Côté" }), "zoe cote"));
});

test("filters every column at once", () => {
  const out = filterColumns(demoPipeline.columns, "smith");
  assert.deepEqual(
    Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])),
    { ACTIVE: 1, CONDITIONAL: 1, FIRM: 1, CLOSED: 0 },
  );
});
