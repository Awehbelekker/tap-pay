import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Crypto } from "../src/crypto.js";
import { createDb, dbReady, type DbHandle } from "../src/db.js";
import { loadMigrations, migrateDown, migrateUp } from "../src/migrate.js";
import { seed, SEED } from "../src/seed.js";

/**
 * Runs against a real, disposable Postgres (TEST_DATABASE_URL). Skipped when unset so unit
 * tests stay runnable anywhere; CI always sets it. The database is wiped at the start.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("migrations (integration)", () => {
  let h: DbHandle;

  beforeAll(async () => {
    h = createDb(url!, { max: 2 });
    await h.pool.query("drop schema public cascade; create schema public;");
  });

  afterAll(async () => {
    await h?.close();
  });

  it("every migration has a down file and versions are unique", async () => {
    const m = await loadMigrations();
    expect(m.length).toBeGreaterThanOrEqual(5);
  });

  it("applies all migrations, then is a no-op", async () => {
    const all = await loadMigrations();
    expect(await migrateUp(h.pool)).toHaveLength(all.length);
    expect(await migrateUp(h.pool)).toHaveLength(0);
    expect((await dbReady(h.db)).ok).toBe(true);
  });

  it("rolls everything back and re-applies cleanly", async () => {
    const all = await loadMigrations();
    expect(await migrateDown(h.pool, all.length)).toHaveLength(all.length);
    const t = await h.pool.query("select count(*)::int as n from information_schema.tables where table_schema='public' and table_name <> 'schema_migrations'");
    expect(t.rows[0].n).toBe(0);
    expect(await migrateUp(h.pool)).toHaveLength(all.length);
  });

  it("seeds idempotently with encrypted staff numbers", async () => {
    const crypto = new Crypto([{ id: 1, keyBase64: Buffer.alloc(32, 9).toString("base64") }], 1, "x".repeat(32));
    await seed(h.db, crypto);
    await seed(h.db, crypto);
    const users = await h.db.selectFrom("users").selectAll().where("merchant_id", "=", SEED.merchantId).execute();
    expect(users).toHaveLength(2);
    for (const u of users) expect(u.msisdn_enc.includes(Buffer.from("0600000002"))).toBe(false);
    expect(crypto.decrypt(users.find((u) => u.id === SEED.coachId)!.msisdn_enc)).toBe("0600000002");
    const tags = await h.db.selectFrom("tags").select("code").execute();
    expect(tags.map((t) => t.code).sort()).toEqual(Object.values(SEED.tags).sort());
  });

  it("ledger_entries is append-only (update, delete and truncate rejected)", async () => {
    await h.pool.query(
      "insert into ledger_entries (merchant_id, kind, party_kind, amount_cents) values ($1, 'sale', 'merchant', 100)",
      [SEED.merchantId],
    );
    await expect(h.pool.query("update ledger_entries set amount_cents = 1")).rejects.toThrow(/append-only/);
    await expect(h.pool.query("delete from ledger_entries")).rejects.toThrow(/append-only/);
    await expect(h.pool.query("truncate ledger_entries")).rejects.toThrow(/append-only/);
  });

  it("audit_log is append-only", async () => {
    await h.pool.query("insert into audit_log (actor_kind, action, entity) values ('system', 'test', 'x')");
    await expect(h.pool.query("update audit_log set action = 'y'")).rejects.toThrow(/append-only/);
    await expect(h.pool.query("delete from audit_log")).rejects.toThrow(/append-only/);
  });

  it("allows one global opt-out per customer (null merchant) and rejects a duplicate", async () => {
    const c = await h.pool.query<{ id: string }>(
      "insert into customers (msisdn_hash, msisdn_enc) values ('\\x01', '\\x02') returning id",
    );
    const id = c.rows[0]!.id;
    await h.pool.query("insert into opt_outs (customer_id, merchant_id) values ($1, null)", [id]);
    await expect(h.pool.query("insert into opt_outs (customer_id, merchant_id) values ($1, null)", [id])).rejects.toThrow(
      /duplicate key/,
    );
    await h.pool.query("insert into opt_outs (customer_id, merchant_id) values ($1, $2)", [id, SEED.merchantId]);
  });

  it("allows at most one tag-claimable open bill per tag", async () => {
    const tag = await h.db.selectFrom("tags").select("id").where("code", "=", SEED.tags.till).executeTakeFirstOrThrow();
    const insert = (token: string) =>
      sql`insert into bills (merchant_id, tag_id, bill_token, subtotal_cents, expires_at)
          values (${SEED.merchantId}, ${tag.id}, ${token}, 1000, now() + interval '1 day')`.execute(h.db);
    await insert("tok-a");
    await expect(insert("tok-b")).rejects.toThrow(/bills_one_claimable_per_tag/);
  });
});
