import { Kysely, PostgresDialect, sql, type ColumnType, type Generated } from "kysely";
import type { BillState, SessionState } from "@tappay/core";
import pg from "pg";

// bigint columns come back as strings by default; money columns are bigint cents, and every
// amount we store is a safe integer, so parse to number and fail loudly if one ever is not.
pg.types.setTypeParser(20, (v: string) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("bigint column value exceeds safe integer range");
  return n;
});

/**
 * Kysely table types for the tables in use so far; the remaining tables are added with the
 * milestone that first uses them. Keep in step with db/migrations.
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

export interface CustomersTable {
  id: Generated<string>;
  msisdn_hash: Buffer;
  msisdn_enc: Buffer;
  profile_name: string | null;
  opted_out_at: Date | null;
  created_at: Generated<Date>;
}

export interface BillLine {
  description: string;
  amountCents: number;
  quantity?: number;
}

export interface BillsTable {
  id: Generated<string>;
  merchant_id: string;
  created_by: string | null;
  assigned_user_id: string | null;
  tag_id: string | null;
  type: Generated<"fixed" | "open" | "quick_tip">;
  status: Generated<BillState>;
  reference: string | null;
  table_label: string | null;
  bill_code: string | null;
  bill_token: string;
  subtotal_cents: Generated<number>;
  lines: ColumnType<BillLine[], string, string>;
  intended_msisdn_hash: Buffer | null;
  intended_msisdn_enc: Buffer | null;
  customer_id: string | null;
  claimed_at: Date | null;
  paid_at: Date | null;
  expires_at: Date;
  shift_id: string | null;
  version: Generated<number>;
  created_at: Generated<Date>;
}

export interface ClaimTokensTable {
  token_hash: Buffer;
  bill_id: string | null;
  tag_id: string | null;
  merchant_id: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Generated<Date>;
}

export interface SessionsTable {
  id: Generated<string>;
  merchant_id: string;
  bill_id: string | null;
  bill_share_id: string | null;
  customer_id: string;
  status: Generated<SessionState>;
  base_cents: number | null;
  tip_cents: Generated<number>;
  total_cents: ColumnType<number, never, never>;
  wa_window_expires_at: Date | null;
  expires_at: Date;
  version: Generated<number>;
  created_at: Generated<Date>;
}

export interface PaymentsTable {
  id: Generated<string>;
  merchant_id: string;
  session_id: string;
  provider: string;
  provider_ref: string | null;
  idempotency_key: string;
  amount_cents: number;
  status: Generated<"pending" | "succeeded" | "failed" | "cancelled" | "refunded" | "partially_refunded">;
  method: string | null;
  provider_fee_cents: number | null;
  raw: ColumnType<unknown, string | null, string | null> | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LedgerEntriesTable {
  id: Generated<number>;
  merchant_id: string;
  payment_id: string | null;
  payout_id: string | null;
  kind: "sale" | "tip" | "fee" | "refund" | "payout" | "adjustment";
  party_kind: "merchant" | "staff" | "pool";
  party_user_id: string | null;
  amount_cents: number;
  note: string | null;
  created_at: Generated<Date>;
}

export interface ReceiptsTable {
  id: Generated<string>;
  merchant_id: string;
  payment_id: string;
  receipt_token: string;
  number: string;
  tax_invoice: Generated<boolean>;
  image_key: string | null;
  created_at: Generated<Date>;
}

export interface WebhookEventsTable {
  id: Generated<string>;
  source: string;
  external_id: string;
  signature_ok: boolean;
  payload: ColumnType<unknown, string, string>;
  status: Generated<"received" | "processed" | "failed" | "ignored">;
  error: string | null;
  received_at: Generated<Date>;
  processed_at: Date | null;
}

export interface MessageLogTable {
  id: Generated<number>;
  customer_id: string | null;
  merchant_id: string | null;
  direction: "in" | "out";
  wa_message_id: string | null;
  kind: string;
  template: string | null;
  status: string | null;
  created_at: Generated<Date>;
}

export interface AuditLogTable {
  id: Generated<number>;
  merchant_id: string | null;
  actor_kind: "user" | "operator" | "system" | "customer";
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  detail: ColumnType<Record<string, unknown>, string, never>;
  created_at: Generated<Date>;
}

export interface Database {
  merchants: MerchantsTable;
  users: UsersTable;
  tags: TagsTable;
  services: ServicesTable;
  customers: CustomersTable;
  bills: BillsTable;
  claim_tokens: ClaimTokensTable;
  sessions: SessionsTable;
  payments: PaymentsTable;
  ledger_entries: LedgerEntriesTable;
  receipts: ReceiptsTable;
  webhook_events: WebhookEventsTable;
  message_log: MessageLogTable;
  audit_log: AuditLogTable;
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
