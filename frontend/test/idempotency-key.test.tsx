import { afterEach, expect, test, vi } from "vitest";
import { newKey } from "../src/app/api.ts";

afterEach(() => vi.unstubAllGlobals());

test("idempotency keys are random v4 UUIDs, even where crypto.randomUUID is missing (plain http)", () => {
  const real = globalThis.crypto;
  vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) }); // no randomUUID, as on http://web:8080
  const keys = new Set(Array.from({ length: 200 }, () => newKey()));
  expect(keys.size).toBe(200);
  for (const k of keys) expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
