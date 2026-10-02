# KakEnBetaal — project instructions for Claude Code

KakEnBetaal ("tap and pay") lets a South African customer tap an NFC tag worn or placed by a merchant (coach, till, table), continue in WhatsApp, choose a tip, pay with Apple Pay / Google Pay / Pay by Bank through a payment provider's hosted checkout, and receive a branded slip. Merchants create bills in a PWA. No card machine. Currency is ZAR only.

Product name is configuration (`PRODUCT_NAME`), never hard-code it in logic. Copy lives in `docs/MESSAGES.md` / the message catalogue package.

## Read these first, in order

1. `docs/SPEC.md` — what to build (behaviour, rules, state machines). Source of truth.
2. `docs/ARCHITECTURE.md` — stack, repo layout, adapters, jobs, security.
3. `db/schema.sql` — baseline Postgres schema. Turn it into numbered migrations in M0.
4. `api/openapi.yaml` — HTTP contract. Keep it in sync with the code (generate types from it).
5. `docs/MESSAGES.md` — every WhatsApp message, button and template.
6. `docs/MILESTONES.md` — the ordered backlog with acceptance criteria. Work one milestone at a time.
7. `docs/TEST_PLAN.md` — what must be tested and how.
8. `docs/OPEN_QUESTIONS.md` — decisions and unverified assumptions. Do not silently resolve them; build behind config/flags and record what you chose.

## Stack (decided)

TypeScript (strict), Node 22, pnpm workspaces monorepo, Fastify, Zod, Kysely + SQL migrations, PostgreSQL 16, pg-boss for jobs, Vitest, fast-check, Playwright, React + Vite + vite-plugin-pwa + Tailwind for the web app. Hosting default: Railway (API, worker, Postgres) and Vercel (web). Everything must also run locally with `docker compose up` and no external accounts.

## Non-negotiable rules

- **Money is integer cents** (`bigint` in Postgres, `number` safe-integer or `bigint` in TS via a `Cents` branded type). No floats anywhere near money. Percentages are applied with the rounding rules in SPEC §8.
- **Every external system sits behind an adapter interface** (`PaymentProvider`, `WhatsAppClient`, `PushClient`, `Clock`, `Notifier`). Each has a mock/sim implementation that is the default in dev and tests. Real adapters are built in M8 from the providers' *current official docs* — fetch them at build time, record findings in `docs/PROVIDER_NOTES.md`, and never invent endpoints or fields. If docs are unavailable, build to the interface plus the mock and flag it.
- **Idempotency everywhere**: webhook handlers, payment confirmation, notifications, payouts. Unique constraints and `webhook_events` enforce it. Never trust a browser redirect to mark a payment paid.
- **Verify every webhook signature** (WhatsApp `X-Hub-Signature-256`, provider signatures). Reject and log failures.
- **State machines are pure functions** in `packages/core` with exhaustive transition tests. Handlers call them; they do not mutate status directly.
- **Multi-tenant isolation**: every query is scoped by `merchant_id`. Add a test that proves one merchant cannot read another's data through every merchant endpoint.
- **PII**: customer phone numbers are stored encrypted (AES-256-GCM) plus an HMAC hash for lookup. Merchants see masked numbers unless the customer consented (SPEC §13). Never log full numbers, tokens, keys or card data.
- **Secrets only via env**. Never commit secrets. `.env.example` lists every variable.
- **Audit log** every state change and every merchant/manager/operator action.
- **No emoji in code or in customer messages** unless `docs/MESSAGES.md` says so.
- Timezone for schedules and quiet hours: `Africa/Johannesburg`.

## Working method

- One milestone at a time (`docs/MILESTONES.md`). Inside a milestone, one task per commit, with tests in the same commit.
- Write the test first for state machines, money maths and matching rules.
- Definition of done for a task: acceptance criteria met, `pnpm typecheck && pnpm lint && pnpm test` green, OpenAPI and docs updated, no TODOs without an issue note in `docs/OPEN_QUESTIONS.md`.
- Keep `docs/SPEC.md` in sync. If the code needs to differ from the spec, change the spec in the same commit and say why.
- When something is ambiguous, pick the safest option, put it behind config, and add a line to `docs/OPEN_QUESTIONS.md`.
- Use the local WhatsApp simulator (`packages/wa-sim`) and mock provider for all end-to-end work. Real Meta/provider calls only in M8 and only with test credentials.

## Commands (create in M0)

```
pnpm install
docker compose up -d        # postgres, mailpit-style stubs if needed
pnpm db:migrate && pnpm db:seed
pnpm dev                    # api + worker + web + wa-sim
pnpm typecheck && pnpm lint && pnpm test
pnpm e2e                    # Playwright against the dev stack
pnpm gen:api                # types from api/openapi.yaml
```

## Environment variables (all in `.env.example`)

`NODE_ENV, TZ, PRODUCT_NAME, DATABASE_URL, PUBLIC_API_URL, PUBLIC_WEB_URL, PUBLIC_TAP_DOMAIN, JWT_SECRET, ENCRYPTION_KEY, HASH_PEPPER, TAG_MASTER_KEY, CLAIM_TOKEN_TTL_SECONDS (120), SESSION_TTL_MINUTES (10), BILL_EXPIRY_HOURS (24), WA_MODE (sim|cloud), WA_PHONE_NUMBER (for wa.me), WA_PHONE_NUMBER_ID, WA_BUSINESS_ACCOUNT_ID, WA_ACCESS_TOKEN, WA_APP_SECRET, WA_VERIFY_TOKEN, PROVIDER (mock|peach|payfast), SPLIT_STRATEGY (ledger_only|native|collect_then_payout), PEACH_*, PAYFAST_*, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, SENTRY_DSN (optional)`.

`SPLIT_STRATEGY=collect_then_payout` must refuse to start in production unless `FUNDS_FLOW_LEGAL_SIGNOFF=true` is set (see OPEN_QUESTIONS).
