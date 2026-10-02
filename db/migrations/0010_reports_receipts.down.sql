drop table if exists tax_invoices;
alter table merchants drop column if exists invoice_seq, drop column if exists address;
alter table receipts drop column if exists revoked_at;
drop index if exists payments_paid_idx;
alter table payments drop column if exists paid_at;
