/**
 * One place for the browser test stack's settings: API on 3100 against a disposable
 * "_e2e_test" database, the built PWA served on 5174. Values are test-only.
 */
const base = process.env.TEST_DATABASE_URL ?? "postgres://tappay:tappay@localhost:5432/tappay_test";
const dbUrl = new URL(base);
dbUrl.pathname = "/tappay_e2e_test";

export const E2E = {
  apiPort: 3100,
  webPort: 5174,
  apiUrl: "http://localhost:3100",
  webUrl: "http://localhost:5174",
  databaseUrl: dbUrl.toString(),
  waAppSecret: "e2e-wa-app-secret",
};

export const apiEnv: Record<string, string> = {
  NODE_ENV: "test",
  PRODUCT_NAME: "TestPay",
  LOG_LEVEL: "warn",
  PORT: String(E2E.apiPort),
  DATABASE_URL: E2E.databaseUrl,
  PUBLIC_API_URL: E2E.apiUrl,
  PUBLIC_WEB_URL: E2E.webUrl,
  PUBLIC_TAP_DOMAIN: `localhost:${E2E.apiPort}`,
  JWT_SECRET: "test-only-not-a-secret-e2e-jwt-000000",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  HASH_PEPPER: "test-only-not-a-secret-e2e-pepper-0000",
  TAG_MASTER_KEY: "00112233445566778899aabbccddeeff",
  WA_MODE: "sim",
  WA_PHONE_NUMBER: "27600000000",
  WA_APP_SECRET: E2E.waAppSecret,
  WA_VERIFY_TOKEN: "e2e-verify",
  WA_SIM_URL: "http://localhost:4999",
};
