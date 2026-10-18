/**
 * Global board search: agent name, MLS® number, street address.
 * Every word typed must match one of those fields ("smith lakeshore"
 * finds Jane Smith's Lakeshore Rd deal). Case, accents and punctuation are
 * ignored, so "w1234" finds MLS W1234567 and "queens quay" finds "Queens Quay W".
 */

import type { ColumnKey, PipelineCard, PipelineResponse } from "./types.ts";

export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function cardMatches(card: PipelineCard, query: string): boolean {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const fields = [card.agentName ?? "", card.mlsNumber ?? "", card.address].map(normalize);
  // MLS numbers are often typed without the letter or with spaces
  const mlsCompact = (card.mlsNumber ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return words.every((w) => fields.some((f) => f.includes(w)) || (mlsCompact !== "" && mlsCompact.includes(w)));
}

export function filterColumns(columns: PipelineResponse["columns"], query: string): PipelineResponse["columns"] {
  const out = {} as PipelineResponse["columns"];
  for (const key of Object.keys(columns) as ColumnKey[]) out[key] = columns[key].filter((c) => cardMatches(c, query));
  return out;
}
