drop table if exists bill_code_prompts;
drop index if exists bills_tag_status_idx;
drop index if exists bill_shares_bill_idx;
alter table bill_shares drop column if exists version, drop column if exists claimed_at;
alter table bill_shares drop constraint if exists bill_shares_status_check;
update bill_shares set status = 'open' where status = 'claimed';
alter table bill_shares add constraint bill_shares_status_check check (status in ('open','paid','cancelled'));
alter table merchants
  drop constraint if exists merchants_quick_tip_range,
  drop column if exists open_amount_max_cents,
  drop column if exists quick_tip_max_cents,
  drop column if exists quick_tip_min_cents,
  drop column if exists quick_tip_presets_cents,
  drop column if exists no_bill_action;
