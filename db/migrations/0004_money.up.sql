-- 0004 payments, append-only ledger, shifts, payouts, receipts. Generated from db/schema.sql in M0; see db/README.md for deviations.

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
create trigger ledger_no_truncate before truncate on ledger_entries
  for each statement execute function forbid_mutation();

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
