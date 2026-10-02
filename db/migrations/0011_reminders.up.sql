-- 0011 unpaid bills and reminders (M7, SPEC 11).

-- Merchant reminder settings: how many (0 to 3), how soon the first, and the hours (never
-- wider than 08:00 to 20:00 SAST).
alter table merchants
  add column reminder_count smallint not null default 3 check (reminder_count between 0 and 3),
  add column reminder_first_delay_minutes integer not null default 10 check (reminder_first_delay_minutes between 1 and 1440),
  add column reminder_window_start smallint not null default 8,
  add column reminder_window_end smallint not null default 20,
  add constraint merchants_reminder_window check (reminder_window_start >= 8 and reminder_window_end <= 20 and reminder_window_start < reminder_window_end);
update merchants set reminder_count = 0 where reminders_enabled = false;

-- A merchant can switch reminders off per service (SPEC 11.3).
alter table services add column reminders_enabled boolean not null default true;

-- Sessions are closed once by the expiry sweep (or the customer's next message).
alter table sessions add column closed_at timestamptz;
create index sessions_open_expiry_idx on sessions (expires_at) where closed_at is null;

-- Unpaid bills: when abandoned, why closed, and whether the customer agreed to share their
-- number with the merchant (null = not asked).
alter table bills
  add column abandoned_at timestamptz,
  add column closed_reason text,
  add column share_number_consent boolean;

-- Reminders: one row per planned send, created one at a time; never more than 3 per bill.
alter table reminders
  add column merchant_id uuid references merchants(id),
  add column template text,
  add column error text,
  add column created_at timestamptz not null default now(),
  drop constraint reminders_status_check,
  add constraint reminders_status_check check (status in ('scheduled','sent','failed','skipped','cancelled'));
create index reminders_due_idx on reminders (due_at) where status = 'scheduled';
create index reminders_customer_idx on reminders (customer_id) where status = 'scheduled';
