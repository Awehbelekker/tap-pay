import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/index.js";

export const validEnv = {
  PRODUCT_NAME: "TestPay",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  PUBLIC_API_URL: "http://localhost:3000",
  PUBLIC_WEB_URL: "http://localhost:5173",
  PUBLIC_TAP_DOMAIN: "localhost:3000",
  JWT_SECRET: "x".repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  HASH_PEPPER: "p".repeat(32),
  TAG_MASTER_KEY: "00112233445566778899aabbccddeeff",
  WA_PHONE_NUMBER: "27600000000",
  WA_APP_SECRET: "app-secret",
  WA_VERIFY_TOKEN: "verify",
};

describe("loadConfig", () => {
  it("accepts a minimal dev environment and applies defaults", () => {
    const c = loadConfig(validEnv);
    expect(c.PROVIDER).toBe("mock");
    expect(c.SPLIT_STRATEGY).toBe("ledger_only");
    expect(c.CLAIM_TOKEN_TTL_SECONDS).toBe(120);
    expect(c.SESSION_TTL_MINUTES).toBe(10);
    expect(c.FUNDS_FLOW_LEGAL_SIGNOFF).toBe(false);
  });

  it("fails loudly and lists every missing variable", () => {
    try {
      loadConfig({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      for (const k of ["PRODUCT_NAME", "DATABASE_URL", "ENCRYPTION_KEY", "WA_APP_SECRET"]) expect(msg).toContain(k);
    }
  });

  it("rejects a wrong-length encryption key without echoing it", () => {
    const bad = Buffer.alloc(16, 7).toString("base64");
    expect(() => loadConfig({ ...validEnv, ENCRYPTION_KEY: bad })).toThrow(/ENCRYPTION_KEY: must be 32 bytes/);
    try {
      loadConfig({ ...validEnv, ENCRYPTION_KEY: bad });
    } catch (e) {
      expect((e as Error).message).not.toContain(bad);
    }
  });

  it("requires cloud credentials when WA_MODE=cloud", () => {
    expect(() => loadConfig({ ...validEnv, WA_MODE: "cloud" })).toThrow(/WA_ACCESS_TOKEN: required when WA_MODE=cloud/);
  });

  it("requires provider credentials for real providers", () => {
    expect(() => loadConfig({ ...validEnv, PROVIDER: "peach" })).toThrow(/PEACH_ENTITY_ID/);
    expect(() => loadConfig({ ...validEnv, PROVIDER: "payfast" })).toThrow(/PAYFAST_PASSPHRASE/);
  });

  describe("production guards", () => {
    const prod = {
      ...validEnv,
      NODE_ENV: "production",
      PROVIDER: "peach",
      PEACH_ENTITY_ID: "e",
      PEACH_ACCESS_TOKEN: "t",
      PEACH_WEBHOOK_SECRET: "s",
      WA_MODE: "cloud",
      WA_PHONE_NUMBER_ID: "1",
      WA_BUSINESS_ACCOUNT_ID: "2",
      WA_ACCESS_TOKEN: "3",
    };

    it("accepts a complete production config", () => {
      expect(loadConfig(prod).NODE_ENV).toBe("production");
    });

    it("refuses the development placeholder secrets from .env.example", async () => {
      const { readFile } = await import("node:fs/promises");
      const example = await readFile(new URL("../../../.env.example", import.meta.url), "utf8");
      const vars = Object.fromEntries(
        example
          .split("\n")
          .filter((l) => /^[A-Z_]+=/.test(l))
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
      // The example itself must be a valid dev config.
      expect(loadConfig(vars).NODE_ENV).toBe("development");
      for (const k of ["JWT_SECRET", "ENCRYPTION_KEY", "HASH_PEPPER", "TAG_MASTER_KEY", "WA_APP_SECRET"]) {
        expect(() => loadConfig({ ...prod, [k]: vars[k] })).toThrow(new RegExp(`${k}: is a development placeholder`));
      }
    });

    it("refuses the mock provider and the WhatsApp simulator", () => {
      expect(() => loadConfig({ ...prod, PROVIDER: "mock" })).toThrow(/mock provider is not allowed/);
      expect(() => loadConfig({ ...prod, WA_MODE: "sim" })).toThrow(/simulator is not allowed/);
    });

    it("refuses collect_then_payout without legal sign-off", () => {
      expect(() => loadConfig({ ...prod, SPLIT_STRATEGY: "collect_then_payout" })).toThrow(/FUNDS_FLOW_LEGAL_SIGNOFF/);
      expect(
        loadConfig({ ...prod, SPLIT_STRATEGY: "collect_then_payout", FUNDS_FLOW_LEGAL_SIGNOFF: "true" }).SPLIT_STRATEGY,
      ).toBe("collect_then_payout");
    });
  });
});
