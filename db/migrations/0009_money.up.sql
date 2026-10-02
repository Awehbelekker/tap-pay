-- 0009 money: split policy, refunds, payouts (M5, SPEC 8 to 10).

alter type ledger_kind add value if not exists 'platform_fee';

alter table merchants
  add column tip_rule text not null default 'direct' check (tip_rule in ('direct','pool','house_cut')),
  add column tip_house_cut_bp integer not null default 0 check (tip_house_cut_bp between 0 and 10000),
  add column fee_policy text not null default 'proportional' check (fee_policy in ('proportional','merchant_absorbs')),
  add column platform_fee_bp integer not null default 0 check (platform_fee_bp between 0 and 1000),
  add column platform_fee_cents bigint not null default 0 check (platform_fee_cents >= 0);

-- Refunds (SPEC 10): full or partial, idempotent, reversing the payment's split lines.
create table refunds (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  payment_id uuid not null references payments(id),
  amount_cents bigint not null check (amount_cents > 0),
  reason text not null,
  kind text not null default 'refund' check (kind in ('refund','chargeback')),
  status text not null default 'pending' check (status in ('pending','succeeded','failed')),
  provider_ref text,
  idempotency_key text not null unique,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index refunds_payment_idx on refunds (payment_id);

alter table payments add column refunded_cents bigint not null default 0 check (refunded_cents >= 0);
alter table payments add constraint payments_refund_within_amount check (refunded_cents <= amount_cents);

alter table ledger_entries add column refund_id uuid references refunds(id);
-- For refund lines: which credit kind they reverse ('sale' or 'tip').
alter table ledger_entries add column reverses text check (reverses in ('sale','tip'));
create index ledger_payment_idx on ledger_entries (payment_id);

-- Payouts (SPEC 9): how each was settled and why one failed.
alter table payouts
  add column method text not null default 'manual' check (method in ('manual','provider','native_split')),
  add column failure_reason text,
  add column created_by uuid references users(id);
create index payouts_merchant_idx on payouts (merchant_id, created_at desc);

-- One live tip-pool shift per merchant at a time.
create unique index shifts_one_open_per_merchant on shifts (merchant_id) where ends_at is null;
