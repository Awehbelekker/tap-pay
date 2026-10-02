import { Kysely, PostgresDialect, sql, type ColumnType, type Generated } from "kysely";
import type { BillState, SessionState, ShareState } from "@tappay/core";
import pg from "pg";

// bigint columns come back as strings by default; money columns are bigint cents, and every
// amount we store is a safe integer, so parse to number and fail loudly if one ever is not.
function safeBigint(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error("bigint column value exceeds safe integer range");
  return n;
}
pg.types.setTypeParser(20, safeBigint);
// bigint[] (e.g. quick_tip_presets_cents) arrives as strings too: same rule, element by element.
// OID 1016 = int8[]; @types/pg's TypeId enum does not list array OIDs.
const INT8_ARRAY = 1016 as unknown as Parameters<typeof pg.types.setTypeParser>[0];
const parseTextArray = pg.types.getTypeParser(INT8_ARRAY) as (v: string) => (string | null)[];
pg.types.setTypeParser(INT8_ARRAY, (v: string) => parseTextArray(v).map((x) => (x === null ? null : safeBigint(x))));

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
  no_bill_action: "none" | "ask_amount" | null;
  quick_tip_presets_cents: Generated<number[]>;
  quick_tip_min_cents: Generated<number>;
  quick_tip_max_cents: Generated<number>;
  open_amount_max_cents: Generated<number>;
  tip_min_cents: Generated<number>;
  tip_max_bp: Generated<number>;
  tip_max_cents: number | null;
  notify_managers: Generated<"each_payment" | "daily_summary" | "off">;
  tip_rule: Generated<"direct" | "pool" | "house_cut">;
  tip_house_cut_bp: Generated<number>;
  fee_policy: Generated<"proportional" | "merchant_absorbs">;
  platform_fee_bp: Generated<number>;
  platform_fee_cents: Generated<number>;
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
  /** Encrypted provider payout destination (collect_then_payout); never returned by the API. */
  payout_dest_enc: Buffer | null;
  pin_failures: Generated<number>;
  pin_locked_until: Date | null;
  notify_mute: Generated<boolean>;
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
  quantity?: number | undefined;
  /** Set when the line came from a priced service (per-service split rules). */
  serviceId?: string | undefined;
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

export interface BillSharesTable {
  id: Generated<string>;
  bill_id: string;
  merchant_id: string;
  label: string | null;
  amount_cents: number;
  status: Generated<ShareState>;
  customer_id: string | null;
  claimed_at: Date | null;
  version: Generated<number>;
}

export interface BillCodePromptsTable {
  customer_id: string;
  tag_id: string;
  merchant_id: string;
  failures: Generated<number>;
  awaiting_until: Date | null;
  locked_until: Date | null;
  updated_at: Generated<Date>;
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
  refunded_cents: Generated<number>;
  raw: ColumnType<unknown, string | null, string | null> | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface LedgerEntriesTable {
  id: Generated<number>;
  merchant_id: string;
  payment_id: string | null;
  payout_id: string | null;
  kind: "sale" | "tip" | "fee" | "platform_fee" | "refund" | "payout" | "adjustment";
  party_kind: "merchant" | "staff" | "pool";
  party_user_id: string | null;
  amount_cents: number;
  note: string | null;
  refund_id: string | null;
  reverses: "sale" | "tip" | null;
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

export interface DevicesTable {
  id: Generated<string>;
  user_id: string;
  merchant_id: string;
  label: string | null;
  push_subscription: ColumnType<unknown, string | null, string | null> | null;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  created_at: Generated<Date>;
}

export interface OtpCodesTable {
  id: Generated<string>;
  user_id: string;
  code_hash: Buffer;
  attempts: Generated<number>;
  expires_at: Date;
  used_at: Date | null;
  created_at: Generated<Date>;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  device_id: string;
  family_id: string;
  token_hash: Buffer;
  expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  created_at: Generated<Date>;
}

export interface MerchantEventsTable {
  id: Generated<number>;
  merchant_id: string;
  name: string;
  bill_id: string | null;
  user_id: string | null;
  payload: ColumnType<Record<string, unknown>, string, never>;
  created_at: Generated<Date>;
}

export interface NotificationsTable {
  id: Generated<string>;
  merchant_id: string;
  user_id: string | null;
  event: string;
  payload: ColumnType<Record<string, unknown>, string, string>;
  channel: "sse" | "push" | "whatsapp" | "sms";
  status: Generated<"pending" | "sent" | "failed" | "skipped">;
  attempts: Generated<number>;
  dedupe_key: string;
  attempted_at: Date | null;
  error: string | null;
  created_at: Generated<Date>;
}

export interface IdempotencyKeysTable {
  key: string;
  scope: string;
  response: ColumnType<unknown, string | null, string | null> | null;
  created_at: Generated<Date>;
}

export interface SplitRulesTable {
  id: Generated<string>;
  merchant_id: string;
  applies_to: "sale" | "tip";
  service_id: string | null;
  user_id: string | null;
  party_kind: "merchant" | "staff" | "pool";
  party_user_id: string | null;
  basis_points: number;
  active: Generated<boolean>;
}

export interface ShiftsTable {
  id: Generated<string>;
  merchant_id: string;
  starts_at: Date;
  ends_at: Date | null;
  tip_pool: Generated<boolean>;
}

export interface ShiftMembersTable {
  shift_id: string;
  user_id: string;
  weight: Generated<number>;
}

export interface PayoutsTable {
  id: Generated<string>;
  merchant_id: string;
  party_user_id: string | null;
  amount_cents: number;
  status: Generated<"pending" | "sent" | "failed" | "cancelled">;
  provider_ref: string | null;
  idempotency_key: string;
  method: Generated<"manual" | "provider" | "native_split">;
  failure_reason: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  settled_at: Date | null;
}

export interface RefundsTable {
  id: Generated<string>;
  merchant_id: string;
  payment_id: string;
  amount_cents: number;
  reason: string;
  kind: Generated<"refund" | "chargeback">;
  status: Generated<"pending" | "succeeded" | "failed">;
  provider_ref: string | null;
  idempotency_key: string;
  created_by: string | null;
  created_at: Generated<Date>;
  settled_at: Date | null;
}

export interface Database {
  split_rules: SplitRulesTable;
  shifts: ShiftsTable;
  shift_members: ShiftMembersTable;
  payouts: PayoutsTable;
  refunds: RefundsTable;
  devices: DevicesTable;
  otp_codes: OtpCodesTable;
  refresh_tokens: RefreshTokensTable;
  merchant_events: MerchantEventsTable;
  notifications: NotificationsTable;
  idempotency_keys: IdempotencyKeysTable;
  merchants: MerchantsTable;
  users: UsersTable;
  tags: TagsTable;
  services: ServicesTable;
  customers: CustomersTable;
  bills: BillsTable;
  bill_shares: BillSharesTable;
  bill_code_prompts: BillCodePromptsTable;
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
