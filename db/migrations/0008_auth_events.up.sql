-- 0008 staff auth, devices, live events and notification settings (M4).

-- One-time WhatsApp sign-in codes (stored as HMAC only).
create table otp_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  code_hash bytea not null,
  attempts smallint not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index otp_codes_user_idx on otp_codes (user_id, created_at desc);

-- PIN lockout (SPEC: PIN locks after 5 wrong tries).
alter table users
  add column pin_failures smallint not null default 0,
  add column pin_locked_until timestamptz;

-- Rotating refresh tokens. Re-use of a rotated token revokes the whole family.
create table refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  device_id uuid not null references devices(id),
  family_id uuid not null,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index refresh_tokens_family_idx on refresh_tokens (family_id);

-- Live events for the merchant PWA (SSE with Last-Event-ID resume) and the notification log.
create table merchant_events (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id),
  name text not null,
  bill_id uuid references bills(id),
  -- Staff see only their own bills' events; null = everyone at the merchant.
  user_id uuid references users(id),
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index merchant_events_merchant_idx on merchant_events (merchant_id, id);

-- Who gets which alert (SPEC 12: managers choose; coaches can mute).
alter table merchants
  add column notify_managers text not null default 'each_payment' check (notify_managers in ('each_payment','daily_summary','off'));
alter table users
  add column notify_mute boolean not null default false;

alter table notifications add column attempted_at timestamptz;
alter table notifications add column error text;
