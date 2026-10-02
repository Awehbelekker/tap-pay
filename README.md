# tap-pay

Tap an NFC tag, continue in WhatsApp, pay with Apple Pay, Google Pay or Pay by Bank, get a slip.
A multi-tenant engine for South African merchants (coaches, cafes, car guards, restaurants) with
tips, revenue splits, a merchant PWA, notifications and unpaid-bill reminders. ZAR only.

The product name is configuration (`PRODUCT_NAME`); "KakEnBetaal" is the working name
(see `docs/OPEN_QUESTIONS.md` Q5). Built to plug into other products: consumers create bills over
HTTP and receive signed `bill.paid` events, and every external system sits behind an adapter.

## Status

**M0 to M7 done.** A customer can tap a static tag or open a bill link, claim the bill in
WhatsApp (simulator), choose a tip, pay through the mock hosted checkout and get a branded
slip. All six merchant modes work: appointment (number match, 4-digit code), counter (first
tap, or the customer types the amount), table (split into shares), quick tip, field and remote
invoice (bill links). Tips: percentage presets, custom rand or percentage tips, per-merchant
caps, tips off, and the tip on the slip and the ledger. Merchant PWA: sign in with a WhatsApp
code and PIN, create bills (QR, WhatsApp link, bill code), see them go to Paid live, assign
tags (NFC on Android or typed), alerts by push or WhatsApp, opens offline. Money: split rules
(per merchant or service), tip direct, pooled by shift or with a house cut, card fees shared or
absorbed, full and partial refunds that reverse the split, chargebacks, staff balances, and a
daily payout run (manual "mark paid" or through the provider). Dashboard: reports that
reconcile with the ledger, CSV export, business and VAT details, services and staff; a web
receipt that prints out (with PDF), revocable links, VAT on slips, tax invoices on request over
WhatsApp, and a morning summary for managers. Unpaid bills: a customer who leaves without
paying gets up to 3 reminders (one a day, 08:00 to 20:00 SAST, STOP to opt out) and the bill
lands in the merchant's Unpaid list (send reminder, resend link, paid another way, write off).
Next: M8 real adapters (WhatsApp Cloud API, payment providers). See `docs/MILESTONES.md`.

Try it by hand after the quick start: `pnpm demo:bill`, open http://localhost:4000, press
**Tap tag**, then **Send**.

## Quick start

Needs Node 22, pnpm 10 and Docker (or any local Postgres 16).

```bash
pnpm install
cp .env.example .env              # dev-only values; production refuses them
docker compose up -d              # postgres with tappay and tappay_test databases
pnpm db:migrate && pnpm db:seed   # demo merchant, 2 staff, 3 tags, 3 services
pnpm dev                          # api :3000, worker, web :5173, wa-sim :4000
curl localhost:3000/readyz        # {"ok":true,"db":"ok","queue":"ok"}
```

Checks (the CI gate):

```bash
pnpm typecheck && pnpm lint && pnpm test   # integration tests run when TEST_DATABASE_URL is set
pnpm gen:api                               # regenerate types from api/openapi.yaml
pnpm e2e                                   # end-to-end journeys for every mode (needs TEST_DATABASE_URL)
pnpm e2e:web                               # Playwright: the PWA against the real API (needs TEST_DATABASE_URL)
pnpm db:rollback                           # revert the latest migration
```

## Layout

| Path | What |
| --- | --- |
| `apps/api` | Fastify API: tap `/t/:code`, WhatsApp and provider webhooks, mock checkout, receipts `/r/:token`, health. Pay flow in `src/flow.ts` |
| `apps/worker` | pg-boss worker; installs all queues and SAST schedules |
| `apps/web` | Merchant PWA (React, Vite, Tailwind): sign-in, Today, New bill, Bill detail, Tags, Settings; service worker with offline shell and Web Push; Playwright tests in `e2e/` |
| `packages/config` | Zod env validation; refuses unsafe production config |
| `packages/core` | `Cents` money maths, bill and session state machines, claim tokens, ledger postings, adapter ports |
| `packages/db` | SQL migration runner, Kysely, PII crypto (AES-256-GCM + HMAC), seed, queue |
| `packages/providers` | `PaymentProvider` mock + shared contract test suite |
| `packages/whatsapp` | Message catalogue, webhook parser, Meta signature check, simulator client, limits |
| `packages/tag` | Tag and wa.me URL builders, verifier interface (NTAG424 SDM in M9) |
| `packages/wa-sim` | Local WhatsApp simulator: tap a tag, chat, tap buttons, see the slip |
| `packages/slip` | Slip PNG renderer (satori + resvg) |
| `packages/testkit` | Fixed clock and test env |
| `db/migrations` | Source of truth for the schema (see `db/README.md` for fixes to the baseline) |

## Build pack

`CLAUDE.md` holds the rules for building with Claude Code. Product behaviour: `docs/SPEC.md`.
Architecture: `docs/ARCHITECTURE.md`. Messages: `docs/MESSAGES.md`. Tests: `docs/TEST_PLAN.md`.
Decisions and unverified assumptions: `docs/OPEN_QUESTIONS.md`. API contract: `api/openapi.yaml`.
