import { Writable } from "node:stream";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@tappay/config";
import { createDb, migrateUp, type DbHandle } from "@tappay/db";
import { testEnv } from "@tappay/testkit";
import { buildApp } from "../src/app.js";
import { loggerOptions } from "../src/logger.js";

const config = loadConfig(testEnv());

describe("health endpoints without a database", () => {
  // Points at a closed port: readiness must report 503, liveness must still be 200.
  const db = createDb("postgres://x:y@127.0.0.1:1/none", { max: 1 });
  const app = buildApp({ config, db, queue: { ready: async () => false } });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it("/healthz is always 200", async () => {
    const r = await app.inject("/healthz");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("/readyz is 503 with an error body when dependencies are down", async () => {
    const r = await app.inject("/readyz");
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ code: "not_ready", details: { db: "database unavailable", queue: "unavailable" } });
  });
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("/readyz with a migrated database (integration)", () => {
  let db: DbHandle;
  beforeAll(async () => {
    db = createDb(url!, { max: 2 });
    await migrateUp(db.pool);
  });
  afterAll(async () => db?.close());

  it("is 200 when db is migrated and queue is ready", async () => {
    const app = buildApp({ config, db, queue: { ready: async () => true } });
    const r = await app.inject("/readyz");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, db: "ok", queue: "ok" });
    await app.close();
  });
});

describe("log redaction", () => {
  it("never writes numbers, tokens, PINs or signature headers", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino(loggerOptions("info"), sink);
    log.info({ msisdn: "27821234567", token: "AB12CD", pin: "1234", customer: { phone: "27821234567", otp: "999111" } }, "x");
    log.info({ req: { headers: { authorization: "Bearer secret.jwt", "x-hub-signature-256": "sha256=abc" } } }, "y");
    const out = lines.join("");
    for (const s of ["27821234567", "AB12CD", "1234", "999111", "secret.jwt", "sha256=abc"]) expect(out).not.toContain(s);
  });
});

describe("CORS", () => {
  const db = createDb("postgres://x:y@127.0.0.1:1/none", { max: 1 });
  const app = buildApp({ config, db, queue: { ready: async () => false } });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it("allows only the configured web origin", async () => {
    const ok = await app.inject({ url: "/healthz", headers: { origin: config.PUBLIC_WEB_URL } });
    expect(ok.headers["access-control-allow-origin"]).toBe(config.PUBLIC_WEB_URL);
    const bad = await app.inject({ url: "/healthz", headers: { origin: "https://evil.example" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
