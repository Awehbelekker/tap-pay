drop index if exists shifts_one_open_per_merchant;
drop index if exists payouts_merchant_idx;
alter table payouts drop column if exists created_by, drop column if exists failure_reason, drop column if exists method;
drop index if exists ledger_payment_idx;
alter table ledger_entries drop column if exists reverses, drop column if exists refund_id;
alter table payments drop constraint if exists payments_refund_within_amount, drop column if exists refunded_cents;
drop table if exists refunds;
alter table merchants
  drop column if exists platform_fee_cents,
  drop column if exists platform_fee_bp,
  drop column if exists fee_policy,
  drop column if exists tip_house_cut_bp,
  drop column if exists tip_rule;
-- The 'platform_fee' ledger_kind value stays: Postgres cannot drop enum values.
