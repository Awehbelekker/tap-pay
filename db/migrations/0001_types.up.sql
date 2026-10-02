-- 0001 extensions and enum types. Generated from db/schema.sql in M0; see db/README.md for deviations.

create extension if not exists pgcrypto;
create extension if not exists citext;

create type merchant_mode as enum ('appointment','counter','table','quick_tip','field','remote_invoice');
create type user_role as enum ('owner','manager','staff');
create type bill_type as enum ('fixed','open','quick_tip');
create type bill_status as enum ('open','claimed','paid','cancelled','expired','abandoned','needs_follow_up','written_off','paid_other');
create type session_status as enum ('claimed','awaiting_amount','awaiting_tip','awaiting_confirm','awaiting_payment','paid','failed','expired','cancelled','refunded','partially_refunded');
create type split_party_kind as enum ('merchant','staff','pool');
create type ledger_kind as enum ('sale','tip','fee','refund','payout','adjustment');
