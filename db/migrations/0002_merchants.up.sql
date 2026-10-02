-- 0002 merchants, staff, devices, tags, services, split rules. Generated from db/schema.sql in M0; see db/README.md for deviations.

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
