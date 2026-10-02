drop table if exists receipts;
alter table if exists ledger_entries drop constraint if exists ledger_payout_fk;
drop table if exists payouts;
drop table if exists shift_members;
drop table if exists shifts;
drop table if exists ledger_entries;
drop table if exists payments;
drop function if exists forbid_mutation();
