import { readFileSync, writeFileSync, existsSync } from "node:fs";

const FILE = new URL("../.state/run.json", import.meta.url);
type Run = { dealId?: string; dealNumber?: string; saleId?: string; payoutId?: string; leaseId?: string; condoId?: string; grimsbyId?: string; dualId?: string };
export const run = (): Run => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {});
export const remember = (patch: Run) => writeFileSync(FILE, JSON.stringify({ ...run(), ...patch }, null, 2));

/** YYYY-MM-DD in Ontario time (the brokerage's, the server's and the test browser's), `days` from today */
export function day(days = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date(Date.now() + days * 86_400_000));
}

/** A small valid PDF, so the server's file-type check sees real PDF bytes */
export const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
