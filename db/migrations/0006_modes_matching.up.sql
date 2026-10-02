-- 0006 merchant modes, bill matching and shares (M2).

-- Per-merchant settings that turn a mode into behaviour (SPEC 3: new merchant types are new
-- combinations of settings, not new code).
alter table merchants
  add column no_bill_action text check (no_bill_action in ('none','ask_amount')),
  add column quick_tip_presets_cents bigint[] not null default '{500,1000,2000}',
  add column quick_tip_min_cents bigint not null default 200 check (quick_tip_min_cents > 0),
  add column quick_tip_max_cents bigint not null default 100000,
  add column open_amount_max_cents bigint not null default 5000000,
  add constraint merchants_quick_tip_range check (quick_tip_max_cents >= quick_tip_min_cents);

-- Shares can be held by one payer while they pay (SPEC 5: each payer claims a share).
alter table bill_shares drop constraint bill_shares_status_check;
alter table bill_shares
  add constraint bill_shares_status_check check (status in ('open','claimed','paid','cancelled')),
  add column claimed_at timestamptz,
  add column version integer not null default 1;
create index bill_shares_bill_idx on bill_shares (bill_id, status);

create index bills_tag_status_idx on bills (tag_id, status) where tag_id is not null;

-- 4-digit bill code prompts and lockout per customer and tag (SPEC 5 rule 5, SPEC 19).
create table bill_code_prompts (
  customer_id uuid not null references customers(id),
  tag_id uuid not null references tags(id),
  merchant_id uuid not null references merchants(id),
  failures smallint not null default 0 check (failures >= 0),
  awaiting_until timestamptz,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (customer_id, tag_id)
);
