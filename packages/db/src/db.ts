import { Kysely, PostgresDialect, sql, type Generated } from "kysely";
import pg from "pg";

// bigint columns come back as strings by default; money columns are bigint cents, and every
// amount we store is a safe integer, so parse to number and fail loudly if one ever is not.
pg.types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("bigint column value exceeds safe integer range");
  return n;
});

/**
 * Kysely table types. M0 covers the tables the seed and health checks touch; the remaining
 * tables are added with the milestone that first uses them (generate with kysely-codegen).
 */
export interface MerchantsTable {
  id: Generated<string>;
  name: string;
  trading_name: string | null;
  vat_number: string | null;
  vat_registered: Generated<boolean>;
  mode: Generated<"appointment" | "counter" | "table" | "quick_tip" | "field" | "remote_invoice">;
  provider: Generated<string>;
  split_strategy: Generated<string>;
  payout_threshold_cents: Generated<number>;
  tip_presets: Generated<number[]>;
  tips_enabled: Generated<boolean>;
  reminders_enabled: Generated<boolean>;
  status: Generated<string>;
  created_at: Generated<Date>;
}

export interface UsersTable {
  id: Generated<string>;
  merchant_id: string;
  display_name: string;
  role: Generated<"owner" | "manager" | "staff">;
  msisdn_enc: Buffer;
  msisdn_hash: Buffer;
  pin_hash: string | null;
  active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface TagsTable {
  id: Generated<string>;
  merchant_id: string | null;
  code: string;
  kind: "ntag424" | "static";
  uid: Buffer | null;
  last_counter: Generated<number>;
  assigned_user_id: string | null;
  label: string | null;
  status: Generated<"unassigned" | "active" | "lost" | "revoked">;
  created_at: Generated<Date>;
}

export interface ServicesTable {
  id: Generated<string>;
  merchant_id: string;
  name: string;
  price_cents: number;
  active: Generated<boolean>;
}

export interface Database {
  merchants: MerchantsTable;
  users: UsersTable;
  tags: TagsTable;
  services: ServicesTable;
}

export interface DbHandle {
  pool: pg.Pool;
  db: Kysely<Database>;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string, opts: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: opts.max ?? 10 });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return {
    pool,
    db,
    // Kysely.destroy() ends the pool it was given.
    close: () => db.destroy(),
  };
}

/** Readiness probe: database reachable and migrations applied. */
export async function dbReady(db: Kysely<Database>): Promise<{ ok: boolean; migrations?: number; error?: string }> {
  try {
    const r = await sql<{ n: number }>`select count(*)::int as n from schema_migrations`.execute(db);
    const n = r.rows[0]?.n ?? 0;
    return n > 0 ? { ok: true, migrations: n } : { ok: false, migrations: 0, error: "no migrations applied" };
  } catch {
    return { ok: false, error: "database unavailable" };
  }
}
