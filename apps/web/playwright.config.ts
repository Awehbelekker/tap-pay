import { defineConfig, devices } from "@playwright/test";
import { E2E } from "./e2e/env";

/**
 * Browser tests for the merchant PWA (MILESTONES M4). Runs the production build (service
 * worker included) against the real API. Set PW_CHROMIUM_PATH to use a preinstalled Chromium.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: E2E.webUrl,
    ...devices["Pixel 7"],
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node --import tsx e2e/start-api.ts",
      url: `${E2E.apiUrl}/readyz`,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
    },
    {
      command: `vite build --mode e2e && vite preview --port ${E2E.webPort} --strictPort`,
      url: E2E.webUrl,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { VITE_PUBLIC_API_URL: E2E.apiUrl, VITE_PRODUCT_NAME: "TestPay" },
    },
  ],
});
