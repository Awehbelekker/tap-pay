import type { Clock } from "@tappay/core";

/** Controllable clock for time-travel tests (reminders, expiry). */
export class FixedClock implements Clock {
  constructor(private t: Date = new Date("2026-10-02T08:00:00+02:00")) {}
  now(): Date {
    return new Date(this.t);
  }
  set(d: Date): void {
    this.t = new Date(d);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

/** A complete, valid development environment for tests. Never real secrets. */
export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "test",
    PRODUCT_NAME: "TestPay",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    DATABASE_URL: "postgres://tappay:tappay@localhost:5432/tappay_test",
    PUBLIC_API_URL: "http://localhost:3000",
    PUBLIC_WEB_URL: "http://localhost:5173",
    PUBLIC_TAP_DOMAIN: "localhost:3000",
    JWT_SECRET: "j".repeat(32),
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    HASH_PEPPER: "p".repeat(32),
    TAG_MASTER_KEY: "00112233445566778899aabbccddeeff",
    WA_PHONE_NUMBER: "27600000000",
    WA_APP_SECRET: "test-app-secret",
    WA_VERIFY_TOKEN: "test-verify",
    ...overrides,
  };
}
