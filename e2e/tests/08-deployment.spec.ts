/** Only against a deployed stack over HTTPS (the staging rehearsal): what the browser actually receives. */
import { test, expect } from "@playwright/test";
import { signIn } from "../lib/people.ts";

test.skip(!process.env.E2E_BASE_URL?.startsWith("https://"), "runs against the HTTPS staging rehearsal only");

test("the session cookie is Secure, HttpOnly and SameSite=Strict; pages carry HSTS and a content security policy", async ({ page, context }) => {
  const res = await page.goto("/");
  const headers = res!.headers();
  expect(headers["strict-transport-security"]).toContain("max-age=");
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["x-frame-options"]).toBe("DENY");
  await signIn(page, "broker", { fresh: true });
  const session = (await context.cookies()).filter((c) => c.httpOnly);
  expect(session.length).toBeGreaterThan(0);
  for (const c of session) {
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe("Strict");
  }
  const api = await page.request.get("/api/auth/me");
  expect(api.headers()["cache-control"] ?? "").toMatch(/no-store/);
});
