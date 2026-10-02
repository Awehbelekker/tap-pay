-- KakEnBetaal baseline schema (PostgreSQL 16). Turn into numbered migrations in M0.
-- Money: bigint cents. Timestamps: timestamptz (UTC). IDs: uuid.

create extension if not exists pgcrypto;
create extension if not exists citext;

create type merchant_mode as enum ('appointment','counter','table','quick_tip','field','remote_invoice');
create type user_role as enum ('owner','manager','staff');
create type bill_type as enum ('fixed','open','quick_tip');
create type bill_status as enum ('open','claimed','paid','cancelled','expired','abandoned','needs_follow_up','written_off','paid_other');
create type session_status as enum ('claimed','awaiting_amount','awaiting_tip','awaiting_confirm','awaiting_payment','paid','failed','expired','cancelled','refunded','partially_refunded');
create type split_party_kind as enum ('merchant','staff','pool');
create type ledger_kind as enum ('sale','tip','fee','refund','payout','adjustment');

create table merchants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  trading_name text,
  vat_number text,
  vat_registered boolean not null default false,
  mode merchant_mode not null default 'counter',
  provider text not null default 'mock',
  provider_account_ref text,
  split_strategy text not null default 'ledger_only',
  payout_threshold_cents bigint not null default 10000,
  payout_bank_enc bytea,
  brand jsonb not null default '{}',
  tips_enabled boolean not null default true,
  tip_presets integer[] not null default '{10,15,20}',
  reminders_enabled boolean not null default true,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  display_name text not null,
  role user_role not null default 'staff',
  msisdn_enc bytea not null,
  msisdn_hash bytea not null,
  pin_hash text,
  payout_dest_enc bytea,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (merchant_id, msisdn_hash)
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  merchant_id uuid not null references merchants(id),
  label text,
  push_subscription jsonb,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table tags (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid references merchants(id),
  code text not null unique,
  kind text not null check (kind in ('ntag424','static')),
  uid bytea,
  last_counter integer not null default 0,
  assigned_user_id uuid references users(id),
  label text,
  status text not null default 'active' check (status in ('unassigned','active','lost','revoked')),
  created_at timestamptz not null default now()
);

create table services (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  name text not null,
  price_cents bigint not null check (price_cents >= 0),
  active boolean not null default true
);

create table split_rules (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  applies_to text not null check (applies_to in ('sale','tip')),
  service_id uuid references services(id),
  user_id uuid references users(id),
  party_kind split_party_kind not null,
  party_user_id uuid references users(id),
  basis_points integer not null check (basis_points between 0 and 10000),
  active boolean not null default true
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  msisdn_hash bytea not null unique,
  msisdn_enc bytea not null,
  profile_name text,
  opted_out_at timestamptz,
  created_at timestamptz not null default now()
);

create table customer_merchant_consent (
  customer_id uuid not null references customers(id),
  merchant_id uuid not null references merchants(id),
  share_number boolean not null default false,
  granted_at timestamptz,
  primary key (customer_id, merchant_id)
);

create table bills (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  created_by uuid references users(id),
  assigned_user_id uuid references users(id),
  tag_id uuid references tags(id),
  type bill_type not null default 'fixed',
  status bill_status not null default 'open',
  reference text,
  table_label text,
  bill_code text,
  bill_token text not null unique,
  subtotal_cents bigint not null default 0 check (subtotal_cents >= 0),
  lines jsonb not null default '[]',
  intended_msisdn_hash bytea,
  intended_msisdn_enc bytea,
  customer_id uuid references customers(id),
  claimed_at timestamptz,
  paid_at timestamptz,
  expires_at timestamptz not null,
  shift_id uuid,
  version integer not null default 1,
  created_at timestamptz not null default now()
);
create index bills_merchant_status_idx on bills (merchant_id, status, created_at desc);
-- At most one tag-claimable open bill per tag (no intended customer).
create unique index bills_one_claimable_per_tag on bills (tag_id)
  where intended_msisdn_hash is null and status in ('open','claimed') and tag_id is not null;

create table bill_shares (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills(id),
  merchant_id uuid not null references merchants(id),
  label text,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'open' check (status in ('open','paid','cancelled')),
  customer_id uuid references customers(id)
);

create table claim_tokens (
  token_hash bytea primary key,
  bill_id uuid references bills(id),
  tag_id uuid references tags(id),
  merchant_id uuid not null references merchants(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  bill_id uuid references bills(id),
  bill_share_id uuid references bill_shares(id),
  customer_id uuid not null references customers(id),
  status session_status not null default 'claimed',
  base_cents bigint check (base_cents >= 0),
  tip_cents bigint not null default 0 check (tip_cents >= 0),
  total_cents bigint generated always as (coalesce(base_cents,0) + tip_cents) stored,
  wa_window_expires_at timestamptz,
  expires_at timestamptz not null,
  version integer not null default 1,
  created_at timestamptz not null default now()
);
create index sessions_customer_idx on sessions (customer_id, status);

create table payments (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  session_id uuid not null references sessions(id),
  provider text not null,
  provider_ref text,
  idempotency_key text not null unique,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'pending' check (status in ('pending','succeeded','failed','cancelled','refunded','partially_refunded')),
  method text,
  provider_fee_cents bigint,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_ref)
);

create table ledger_entries (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id),
  payment_id uuid references payments(id),
  payout_id uuid,
  kind ledger_kind not null,
  party_kind split_party_kind not null,
  party_user_id uuid references users(id),
  amount_cents bigint not null,             -- signed: credits positive, debits negative
  note text,
  created_at timestamptz not null default now()
);
create index ledger_party_idx on ledger_entries (merchant_id, party_user_id, created_at);

-- Append-only enforcement.
create function forbid_mutation() returns trigger language plpgsql as
$$ begin raise exception 'table % is append-only', tg_table_name; end $$;
create trigger ledger_no_update before update or delete on ledger_entries
  for each row execute function forbid_mutation();
create trigger audit_no_update before update or delete on audit_log
  for each row execute function forbid_mutation();

create table shifts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  starts_at timestamptz not null,
  ends_at timestamptz,
  tip_pool boolean not null default false
);
create table shift_members (
  shift_id uuid not null references shifts(id),
  user_id uuid not null references users(id),
  weight integer not null default 1 check (weight > 0),
  primary key (shift_id, user_id)
);

create table payouts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  party_user_id uuid references users(id),
  amount_cents bigint not null check (amount_cents > 0),
  status text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  provider_ref text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
alter table ledger_entries add constraint ledger_payout_fk foreign key (payout_id) references payouts(id);

create table receipts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  payment_id uuid not null unique references payments(id),
  receipt_token text not null unique,
  number text not null,
  tax_invoice boolean not null default false,
  image_key text,
  created_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  user_id uuid references users(id),
  event text not null,
  payload jsonb not null,
  channel text not null check (channel in ('sse','push','whatsapp','sms')),
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  attempts integer not null default 0,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (dedupe_key, channel)
);

create table reminders (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills(id),
  customer_id uuid not null references customers(id),
  seq smallint not null check (seq between 1 and 3),
  due_at timestamptz not null,
  sent_at timestamptz,
  status text not null default 'scheduled' check (status in ('scheduled','sent','skipped','cancelled')),
  unique (bill_id, seq)
);

create table opt_outs (
  customer_id uuid not null references customers(id),
  merchant_id uuid references merchants(id),   -- null = global
  created_at timestamptz not null default now(),
  primary key (customer_id, merchant_id)
);

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  source text not null,                        -- whatsapp | peach | payfast | mock
  external_id text not null,
  signature_ok boolean not null,
  payload jsonb not null,
  status text not null default 'received' check (status in ('received','processed','failed','ignored')),
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (source, external_id)
);

create table message_log (
  id bigint generated always as identity primary key,
  customer_id uuid references customers(id),
  merchant_id uuid references merchants(id),
  direction text not null check (direction in ('in','out')),
  wa_message_id text,
  kind text not null,
  template text,
  status text,
  created_at timestamptz not null default now()
);

create table audit_log (
  id bigint generated always as identity primary key,
  merchant_id uuid,
  actor_kind text not null check (actor_kind in ('user','operator','system','customer')),
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table operators (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  password_hash text not null,
  totp_secret_enc bytea not null,
  active boolean not null default true
);

create table idempotency_keys (
  key text primary key,
  scope text not null,
  response jsonb,
  created_at timestamptz not null default now()
);
