import pg from "pg";
import { Crypto } from "./crypto.js";
import { createDb, type DbHandle } from "./db.js";
import { migrateUp } from "./migrate.js";
import { seed } from "./seed.js";

/**
 * Test helper: wipe the disposable test database, migrate and seed. Refuses any database whose
 * name does not end in "_test" so it can never be pointed at real data by mistake.
 */
export async function freshTestDb(url: string, crypto: Crypto): Promise<DbHandle> {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) throw new Error(`refusing to wipe non-test database "${name}"`);
  const h = createDb(url, { max: 5 });
  await h.pool.query("drop schema public cascade; create schema public;");
  await h.pool.query("drop schema if exists pgboss cascade;");
  await migrateUp(h.pool);
  await seed(h.db, crypto);
  return h;
}

/** Create the database in `url` if it does not exist (connects to the server's "postgres" db). */
export async function ensureTestDatabase(url: string): Promise<void> {
  const u = new URL(url);
  const name = u.pathname.replace(/^\//, "");
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`refusing to create non-test database "${name}"`);
  u.pathname = "/postgres";
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    const r = await c.query("select 1 from pg_database where datname = $1", [name]);
    if (r.rowCount === 0) await c.query(`create database "${name}"`);
  } finally {
    await c.end();
  }
}
