import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

/**
 * Minimal SQL migration runner: db/migrations/NNNN_name.{up,down}.sql, one transaction per
 * file, applied versions recorded in schema_migrations. Plain SQL keeps the schema reviewable
 * and identical to what an operator would run by hand.
 */

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

export interface Migration {
  version: string;
  name: string;
  up: string;
  down: string;
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = await readdir(dir);
  const ups = files.filter((f) => /^\d{4}_[a-z0-9_]+\.up\.sql$/.test(f)).sort();
  const out: Migration[] = [];
  for (const f of ups) {
    const base = f.replace(/\.up\.sql$/, "");
    const downFile = `${base}.down.sql`;
    if (!files.includes(downFile)) throw new Error(`migration ${base} has no down file`);
    out.push({
      version: base.slice(0, 4),
      name: base,
      up: await readFile(path.join(dir, f), "utf8"),
      down: await readFile(path.join(dir, downFile), "utf8"),
    });
  }
  const versions = new Set(out.map((m) => m.version));
  if (versions.size !== out.length) throw new Error("duplicate migration version numbers");
  return out;
}

async function ensureTable(client: pg.PoolClient): Promise<void> {
  await client.query(
    `create table if not exists schema_migrations (
       version text primary key,
       name text not null,
       applied_at timestamptz not null default now()
     )`,
  );
}

async function applied(client: pg.PoolClient): Promise<Set<string>> {
  const r = await client.query<{ version: string }>("select version from schema_migrations");
  return new Set(r.rows.map((x) => x.version));
}

/** Apply all pending migrations. Returns the names applied. Serialised with an advisory lock. */
export async function migrateUp(pool: pg.Pool, migrations?: Migration[]): Promise<string[]> {
  const all = migrations ?? (await loadMigrations());
  const client = await pool.connect();
  const done: string[] = [];
  try {
    await client.query("select pg_advisory_lock(727274)");
    await ensureTable(client);
    const have = await applied(client);
    for (const m of all) {
      if (have.has(m.version)) continue;
      await client.query("begin");
      try {
        await client.query(m.up);
        await client.query("insert into schema_migrations (version, name) values ($1, $2)", [m.version, m.name]);
        await client.query("commit");
        done.push(m.name);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`migration ${m.name} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => undefined);
    client.release();
  }
  return done;
}

/** Revert the latest `steps` applied migrations. Returns the names reverted. */
export async function migrateDown(pool: pg.Pool, steps = 1, migrations?: Migration[]): Promise<string[]> {
  const all = migrations ?? (await loadMigrations());
  const byVersion = new Map(all.map((m) => [m.version, m]));
  const client = await pool.connect();
  const done: string[] = [];
  try {
    await client.query("select pg_advisory_lock(727274)");
    await ensureTable(client);
    const r = await client.query<{ version: string }>(
      "select version from schema_migrations order by version desc limit $1",
      [steps],
    );
    for (const { version } of r.rows) {
      const m = byVersion.get(version);
      if (!m) throw new Error(`no migration file for applied version ${version}`);
      await client.query("begin");
      try {
        await client.query(m.down);
        await client.query("delete from schema_migrations where version = $1", [version]);
        await client.query("commit");
        done.push(m.name);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`rollback of ${m.name} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => undefined);
    client.release();
  }
  return done;
}
