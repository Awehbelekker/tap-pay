drop index if exists reminders_customer_idx;
drop index if exists reminders_due_idx;
alter table reminders
  drop constraint if exists reminders_status_check,
  drop column if exists created_at,
  drop column if exists error,
  drop column if exists template,
  drop column if exists merchant_id;
alter table reminders add constraint reminders_status_check check (status in ('scheduled','sent','skipped','cancelled'));
alter table bills drop column if exists share_number_consent, drop column if exists closed_reason, drop column if exists abandoned_at;
drop index if exists sessions_open_expiry_idx;
alter table sessions drop column if exists closed_at;
alter table services drop column if exists reminders_enabled;
alter table merchants
  drop constraint if exists merchants_reminder_window,
  drop column if exists reminder_window_end,
  drop column if exists reminder_window_start,
  drop column if exists reminder_first_delay_minutes,
  drop column if exists reminder_count;
