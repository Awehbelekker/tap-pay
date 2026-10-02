alter table notifications drop column if exists error, drop column if exists attempted_at;
alter table users drop column if exists notify_mute;
alter table merchants drop column if exists notify_managers;
drop table if exists merchant_events;
drop table if exists refresh_tokens;
alter table users drop column if exists pin_locked_until, drop column if exists pin_failures;
drop table if exists otp_codes;
