import { defineConfig, devices } from "@playwright/test";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const state = (f: string) => { try { return readFileSync(new URL(`./.state/${f}`, import.meta.url), "utf8").trim(); } catch { return ""; } };
const API_PORT = 3100;
const WEB = "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "tests",
  // One journey: the admin set up in 01 invites the people later files sign in as
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }], ["json", { outputFile: "report/results.json" }]],
  outputDir: "test-results",
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: [{ name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } } }],
  webServer: [
    {
      // The real API in session mode (cookies, CSRF, MFA), as in production apart from https
      command: "node src/server.ts",
      cwd: "../backend",
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: false,
      stdout: "pipe",
      env: {
        DATABASE_URL: state("database-url"),
        PORT: String(API_PORT),
        NODE_ENV: "test",
        APP_ORIGINS: WEB,
        COOKIE_SECURE: "false",
        FIELD_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        FILE_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        UPLOAD_DIR: new URL("./.state/uploads", import.meta.url).pathname,
        // Printed on draft CDAs in this throwaway database only
        BROKERAGE_LEGAL_NAME: "E2E Test Brokerage Inc. (not a real brokerage)",
        BROKERAGE_ADDRESS: "1 Test Street, Testville ON",
        BROKERAGE_PHONE: "000-000-0000",
        BROKERAGE_EMAIL: "office@e2e.test",
        BROKERAGE_HST_NUMBER: "TEST-ONLY",
        BROKER_OF_RECORD: "Blake Broker (test)",
      },
    },
    {
      command: "npx vite preview --host 127.0.0.1 --port 4173 --strictPort",
      cwd: "../frontend",
      url: WEB,
      reuseExistingServer: false,
      env: { API_URL: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
