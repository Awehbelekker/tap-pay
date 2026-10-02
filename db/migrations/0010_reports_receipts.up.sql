-- 0010 reports, receipts and tax invoices (M6, SPEC 14 and 16).

-- When the payment was confirmed. updated_at moves again on refunds, so reports use this.
alter table payments add column paid_at timestamptz;
update payments set paid_at = updated_at where status in ('succeeded','partially_refunded','refunded');
create index payments_paid_idx on payments (merchant_id, paid_at) where paid_at is not null;

-- A receipt link can be revoked (and reissued under a new token).
alter table receipts add column revoked_at timestamptz;

-- Business details for slips and tax invoices.
alter table merchants
  add column address text,
  add column invoice_seq bigint not null default 0;

-- Tax invoices on request (SPEC 14): the customer asks on WhatsApp, sends their company name
-- and VAT number, and gets a PDF. One live request per customer at a time.
create table tax_invoices (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  payment_id uuid not null references payments(id),
  customer_id uuid not null references customers(id),
  status text not null default 'awaiting_details' check (status in ('awaiting_details','issued','expired')),
  number text,
  buyer_name text,
  buyer_vat text,
  buyer_address text,
  token text unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  issued_at timestamptz,
  check (status <> 'issued' or (number is not null and buyer_name is not null and token is not null and issued_at is not null))
);
create index tax_invoices_customer_idx on tax_invoices (customer_id, created_at desc);
create unique index tax_invoices_number_idx on tax_invoices (merchant_id, number) where number is not null;
