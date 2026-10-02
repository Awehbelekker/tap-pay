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
