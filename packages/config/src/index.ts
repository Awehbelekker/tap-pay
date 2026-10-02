import { z } from "zod";

/**
 * Environment loading and validation. Every app calls `loadConfig()` at start-up and refuses to
 * run on invalid config (ARCHITECTURE: packages/config). Every variable here is listed in
 * `.env.example`.
 */

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64 encoded");

const hexKey16 = z
  .string()
  .regex(/^[0-9a-fA-F]{32}$/, "must be 16 bytes (32 hex characters)");

const bool = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

const optional = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const SECRET_KEYS = ["JWT_SECRET", "ENCRYPTION_KEY", "HASH_PEPPER", "TAG_MASTER_KEY", "WA_APP_SECRET", "WA_VERIFY_TOKEN"] as const;

/** Values from .env.example must never reach production. */
function isDevPlaceholder(v: string): boolean {
  if (/dev-only/i.test(v)) return true;
  if (/^0+$/.test(v)) return true;
  return Buffer.from(v, "base64").toString("utf8").includes("dev only");
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    TZ: z.literal("Africa/Johannesburg").default("Africa/Johannesburg"),
    PRODUCT_NAME: z.string().min(1),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    DATABASE_URL: z.string().url(),
    PUBLIC_API_URL: z.string().url(),
    PUBLIC_WEB_URL: z.string().url(),
    PUBLIC_TAP_DOMAIN: z.string().min(1),

    JWT_SECRET: z.string().min(32, "must be at least 32 characters"),
    ENCRYPTION_KEY: base64Key32,
    HASH_PEPPER: z.string().min(32, "must be at least 32 characters"),
    TAG_MASTER_KEY: hexKey16,

    CLAIM_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(120),
    SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(10),
    BILL_EXPIRY_HOURS: z.coerce.number().int().positive().default(24),

    WA_MODE: z.enum(["sim", "cloud"]).default("sim"),
    WA_PHONE_NUMBER: z.string().regex(/^\d{8,15}$/, "digits only, international format without +"),
    WA_PHONE_NUMBER_ID: optional,
    WA_BUSINESS_ACCOUNT_ID: optional,
    WA_ACCESS_TOKEN: optional,
    /** Graph API version (docs/PROVIDER_NOTES.md); bump deliberately after checking Meta's changelog. */
    WA_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v23.0"),
    /** Language code the message templates were approved under. */
    WA_TEMPLATE_LANG: z.string().min(2).default("en"),
    WA_APP_SECRET: z.string().min(1),
    WA_VERIFY_TOKEN: z.string().min(1),
    /** Where tap redirects go when WA_MODE=sim (instead of wa.me). */
    WA_SIM_URL: z.string().url().default("http://localhost:4000"),

    PROVIDER: z.enum(["mock", "peach", "payfast"]).default("mock"),
    SPLIT_STRATEGY: z.enum(["ledger_only", "native", "collect_then_payout"]).default("ledger_only"),
    FUNDS_FLOW_LEGAL_SIGNOFF: bool,
    ALLOW_STATIC_TAGS: bool,
    MOCK_PROVIDER_SECRET: z.string().min(16).default("mock-provider-dev-secret"),

    /** Provider test environments (PayFast sandbox, Peach testsecure). Off for real money. */
    PROVIDER_SANDBOX: z
      .enum(["true", "false", "1", "0"])
      .default("true")
      .transform((v) => v === "true" || v === "1"),
    // Peach Payments hosted Checkout v2 (docs/PROVIDER_NOTES.md).
    PEACH_ENTITY_ID: optional,
    PEACH_CLIENT_ID: optional,
    PEACH_CLIENT_SECRET: optional,
    PEACH_MERCHANT_ID: optional,
    /** Dashboard secret token: signs webhooks and refunds. */
    PEACH_SECRET_TOKEN: optional,
    PAYFAST_MERCHANT_ID: optional,
    PAYFAST_MERCHANT_KEY: optional,
    /** Letters, digits, - and _ only, so every PayFast implementation signs alike. */
    PAYFAST_PASSPHRASE: optional.refine((v) => v === undefined || /^[A-Za-z0-9_-]{8,}$/.test(v), "at least 8 of A-Z a-z 0-9 - _"),

    VAPID_PUBLIC_KEY: optional,
    VAPID_PRIVATE_KEY: optional,
    VAPID_SUBJECT: optional,
    SENTRY_DSN: optional,
  })
  .superRefine((env, ctx) => {
    const need = (keys: (keyof typeof env)[], why: string) => {
      for (const k of keys) {
        if (!env[k]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: `required when ${why}` });
      }
    };
    if (env.WA_MODE === "cloud") {
      need(["WA_PHONE_NUMBER_ID", "WA_BUSINESS_ACCOUNT_ID", "WA_ACCESS_TOKEN"], "WA_MODE=cloud");
    }
    if (env.PROVIDER === "peach") {
      need(["PEACH_ENTITY_ID", "PEACH_CLIENT_ID", "PEACH_CLIENT_SECRET", "PEACH_MERCHANT_ID", "PEACH_SECRET_TOKEN"], "PROVIDER=peach");
    }
    if (env.PROVIDER === "payfast") {
      need(["PAYFAST_MERCHANT_ID", "PAYFAST_MERCHANT_KEY", "PAYFAST_PASSPHRASE"], "PROVIDER=payfast");
    }
    // Native split needs per-payment split instructions at checkout, not built yet (OPEN_QUESTIONS Q1).
    if (env.SPLIT_STRATEGY === "native") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SPLIT_STRATEGY"], message: "native split is not built yet (OPEN_QUESTIONS Q1); use ledger_only" });
    }
    if (env.NODE_ENV === "production") {
      for (const k of SECRET_KEYS) {
        if (isDevPlaceholder(env[k])) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [k], message: "is a development placeholder; generate a real secret" });
        }
      }
      if (env.PROVIDER === "mock") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["PROVIDER"], message: "mock provider is not allowed in production" });
      }
      if (env.WA_MODE === "sim") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["WA_MODE"], message: "WhatsApp simulator is not allowed in production" });
      }
      if (env.PROVIDER !== "mock" && env.PROVIDER_SANDBOX && !env.PUBLIC_API_URL.includes("staging")) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["PROVIDER_SANDBOX"], message: "sandbox payments in production: set PROVIDER_SANDBOX=false (or use a staging URL)" });
      }
      // OPEN_QUESTIONS L1: collecting and paying out means holding third-party funds.
      if (env.SPLIT_STRATEGY === "collect_then_payout" && !env.FUNDS_FLOW_LEGAL_SIGNOFF) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["SPLIT_STRATEGY"],
          message: "collect_then_payout requires FUNDS_FLOW_LEGAL_SIGNOFF=true in production (OPEN_QUESTIONS L1)",
        });
      }
    }
  });

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/** Parse and validate an environment. Throws ConfigError listing every problem (never values). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  return parsed.data;
}
