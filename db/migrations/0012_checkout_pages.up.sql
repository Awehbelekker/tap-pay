-- 0012 hosted checkout pages (M8). Providers that take a form POST (PayFast) get a short link
-- to our page that posts the signed form; the token is unguessable and the page expires with
-- the checkout.
alter table payments
  add column checkout_token text unique,
  add column checkout_form jsonb;

-- The provider's own payment id (PayFast pf_payment_id, Peach payment id): refunds need it.
alter table payments add column provider_payment_id text;
