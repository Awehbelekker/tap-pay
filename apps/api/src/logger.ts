import type { LoggerOptions } from "pino";

/**
 * Never log full numbers, tokens, keys or card data (CLAUDE.md). Redaction is by key path; code
 * must also avoid putting PII into free-text messages. TEST_PLAN adds a log-scan test in M9.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-mock-signature"]',
  'res.headers["set-cookie"]',
  "*.msisdn",
  "*.phone",
  "*.from",
  "*.to",
  "*.token",
  "*.claimToken",
  "*.accessToken",
  "*.refreshToken",
  "*.pin",
  "*.otp",
  "*.code",
  "*.password",
  "*.secret",
  "*.cardNumber",
  "msisdn",
  "token",
  "pin",
  "otp",
];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    serializers: {
      // Only id, method and path: headers are dropped entirely, and query strings are cut
      // because tap URLs carry SDM data and bill tokens.
      req: (req: { method?: string; url?: string; id?: string }) => ({
        id: req.id,
        method: req.method,
        url: typeof req.url === "string" ? req.url.split("?")[0] : undefined,
      }),
    },
  };
}
