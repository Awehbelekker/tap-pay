-- 0005 notifications, reminders, opt-outs, webhook events, logs, audit, operators. Generated from db/schema.sql in M0; see db/README.md for deviations.

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

-- Deviation from schema.sql: a primary key cannot contain a null merchant_id, which made the
-- documented "null = global" opt-out impossible. Use a surrogate key plus NULLS NOT DISTINCT.
create table opt_outs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  merchant_id uuid references merchants(id),   -- null = global
  created_at timestamptz not null default now(),
  unique nulls not distinct (customer_id, merchant_id)
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

create trigger audit_no_update before update or delete on audit_log
  for each row execute function forbid_mutation();
create trigger audit_no_truncate before truncate on audit_log
  for each statement execute function forbid_mutation();
