# tap-pay

Tap an NFC tag, continue in WhatsApp, pay with Apple Pay, Google Pay or Pay by Bank, get a slip.
A multi-tenant engine for South African merchants (coaches, cafes, car guards, restaurants) with
tips, revenue splits, a merchant PWA, notifications and unpaid-bill reminders. ZAR only.

The product name is configuration (`PRODUCT_NAME`); "KakEnBetaal" is the working name
(see `docs/OPEN_QUESTIONS.md` Q5). Built to plug into other products: consumers create bills over
HTTP and receive signed `bill.paid` events, and every external system sits behind an adapter.

## Status

**Milestone M0 (scaffolding) done.** No customer flow yet; M1 is the tap-to-slip slice.
See `docs/MILESTONES.md`.

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
pnpm db:rollback                           # revert the latest migration
```

## Layout

| Path | What |
| --- | --- |
| `apps/api` | Fastify API: `/healthz`, `/readyz` now; tap, webhooks, merchant API from M1 |
| `apps/worker` | pg-boss worker; installs all queues and SAST schedules |
| `apps/web` | React + Vite + Tailwind installable PWA shell |
| `packages/config` | Zod env validation; refuses unsafe production config |
| `packages/core` | `Cents` money type and maths, adapter ports, generated API types |
| `packages/db` | SQL migration runner, Kysely, PII crypto (AES-256-GCM + HMAC), seed, queue |
| `packages/providers` | `PaymentProvider` mock + shared contract test suite |
| `packages/whatsapp` | Simulator client, Meta signature check, message limits |
| `packages/tag` | Tag and wa.me URL builders, verifier interface (NTAG424 SDM in M9) |
| `packages/wa-sim` | Local WhatsApp simulator (signs requests like Meta) |
| `packages/testkit` | Fixed clock and test env |
| `db/migrations` | Source of truth for the schema (see `db/README.md` for fixes to the baseline) |

## Build pack

`CLAUDE.md` holds the rules for building with Claude Code. Product behaviour: `docs/SPEC.md`.
Architecture: `docs/ARCHITECTURE.md`. Messages: `docs/MESSAGES.md`. Tests: `docs/TEST_PLAN.md`.
Decisions and unverified assumptions: `docs/OPEN_QUESTIONS.md`. API contract: `api/openapi.yaml`.
