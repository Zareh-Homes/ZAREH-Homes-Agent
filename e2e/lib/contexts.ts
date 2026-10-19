import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { signIn, type Who } from "./people.ts";

const open: BrowserContext[] = [];

/** Closes the windows a test opened for each person, after every test in the file that calls it. */
export function closeWindowsAfterEach() {
  test.afterEach(async () => { await Promise.all(open.splice(0).map((c) => c.close())); });
}

/** A separate browser window signed in as `who` (each person has their own cookies, as in real life). */
export async function as(browser: Browser, who: Who): Promise<Page> {
  const ctx = await browser.newContext();
  open.push(ctx);
  const page = await ctx.newPage();
  await signIn(page, who);
  return page;
}

/** Calls the API as the person signed in on `page`, with their CSRF token, bypassing the screen. */
export async function apiAs(page: Page, method: "GET" | "POST", path: string, data?: object) {
  const me = await (await page.request.get("/api/auth/me")).json();
  const res = method === "GET" ? await page.request.get(path)
    : await page.request.post(path, { headers: { "x-csrf-token": me.csrfToken, "idempotency-key": crypto.randomUUID() }, data: data ?? {} });
  return { status: res.status(), body: await res.json().catch(() => null) };
}
