import { test, expect } from "@playwright/test";
import { signIn, shot } from "../lib/people.ts";
import { run } from "../lib/state.ts";

test("an agent only sees agent sections, and staff pages say so plainly", async ({ page }) => {
  await signIn(page, "agent");
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const name of ["Dashboard", "Deals", "Pipeline", "My compliance"]) await expect(nav.getByRole("link", { name })).toBeVisible();
  for (const name of ["Trust", "Bank & reconciliation", "Approvals & payouts", "Admin", "Compliance review"]) await expect(nav.getByRole("link", { name })).toHaveCount(0);
  for (const path of ["/bank", "/trust", "/approvals", "/admin", "/compliance"]) {
    await page.goto(path);
    await expect(page.getByText("Your role doesn't include this page")).toBeVisible();
  }
  await shot(page, "14-agent-forbidden");
});

test("the server refuses an agent even when the screen is bypassed", async ({ page }) => {
  await signIn(page, "agent");
  const me = await (await page.request.get("/api/auth/me")).json();
  const headers = { "x-csrf-token": me.csrfToken, "idempotency-key": crypto.randomUUID() };
  expect((await page.request.get("/api/trust/accounts")).status()).toBe(403);
  expect((await page.request.get("/api/work/approvals")).status()).toBe(403);
  expect((await page.request.post("/api/users", { headers, data: { email: "x@e2e.test", firstName: "X", lastName: "Y", role: "ADMIN" } })).status()).toBe(403);
  // a client-supplied identity is ignored: the session decides who this is
  const spoofed = await page.request.get("/api/auth/me", { headers: { "x-user-id": "00000000-0000-0000-0000-000000000000" } });
  expect((await spoofed.json()).email).toBe("agent@e2e.test");
});

test("changes without the session's CSRF token are refused", async ({ page }) => {
  await signIn(page, "admin");
  const res = await page.request.post("/api/users", { headers: { "idempotency-key": crypto.randomUUID() }, data: { email: "y@e2e.test", firstName: "Y", lastName: "Z", role: "AGENT" } });
  expect(res.status()).toBe(403);
  expect((await res.json()).error.code).toBe("CSRF_TOKEN");
});

test("compliance can review but can't record trust money", async ({ page }) => {
  const { dealId } = run();
  await signIn(page, "compliance");
  await page.goto(`/deals/${dealId}/trust`);
  await expect(page.getByRole("heading", { name: "Ledger" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record a deposit received" })).toHaveCount(0);
  const me = await (await page.request.get("/api/auth/me")).json();
  const res = await page.request.post("/api/trust/deposits", {
    headers: { "x-csrf-token": me.csrfToken, "idempotency-key": crypto.randomUUID() },
    data: { dealId, trustAccountId: crypto.randomUUID(), amount: "1.00", method: "WIRE", dateReceived: "2026-10-01", dateDeposited: "2026-10-01", payorName: "X", bankReference: "X" },
  });
  expect(res.status()).toBe(403);
});
