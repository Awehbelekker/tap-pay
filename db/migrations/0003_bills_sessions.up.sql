-- 0003 customers, bills, shares, claim tokens, sessions. Generated from db/schema.sql in M0; see db/README.md for deviations.

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
