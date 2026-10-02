# Milestones

Work in order. A milestone is done only when every acceptance item passes, `pnpm typecheck && pnpm lint && pnpm test` is green, and docs and OpenAPI are updated.

## M0 Scaffolding (done 2026-10-02)
Monorepo, tsconfig strict, lint, Vitest, docker-compose (Postgres), migrations from `db/schema.sql`, seed (demo merchant, 2 staff, 3 tags, services), `packages/config` env validation, CI workflow, `.env.example`, health endpoints, pino with redaction, ports and mock adapters skeleton, `wa-sim` shell.
Accept: fresh clone to running `pnpm dev` in under 10 minutes; `/readyz` green; migration up/down works; env validation fails loudly.

## M1 Thin vertical slice (tap to slip) (done 2026-10-02)
`/t/:code` (static tag mode) -> wa.me redirect -> inbound webhook (sim) -> session -> mock checkout -> webhook -> paid -> slip PNG sent in sim.
Accept: scripted e2e passes; duplicate webhook has no double effect; webhook with bad signature rejected.

## M2 Merchant modes and bill matching (done 2026-10-02)
All six modes, bill types, matching algorithm (SPEC §5): number match, first-tap claim, bill code with 3 attempts and 15 min lock, release, shares. Pure state machines with exhaustive tests.
Accept: concurrency test (50 parallel taps on one bill yields exactly one claim); every mode has an e2e scenario.

## M3 Tips
Presets, custom tip, no tip, quick-tip bills, limits (max tip percent or amount), tip shown on slip.
Accept: property tests on tip maths; all tip paths e2e.

## M4 Merchant PWA and notifications
Auth (OTP + PIN), create/edit/cancel bills, live bill list over SSE, installable PWA, Web NFC read/write for tag assignment (Android) with manual code fallback, Web Push, WhatsApp merchant alerts, notification chain with dedupe.
Accept: Playwright flows; notification delivered once per event per channel; offline shell loads.

## M5 Money
Split rules UI and API, ledger postings, rounding rules, split strategies (`ledger_only` default, `native` and `collect_then_payout` behind adapters and flags), balances, refunds (full and partial) with reverse postings, payout run with threshold, staff payout notice.
Accept: ledger sums to payment amount for every scenario (property test); ledger is append-only (DB trigger test); refund reverses splits; payout idempotent.

## M6 Dashboard, receipts, tax invoice
Manager dashboard, CSV export, receipt page with print animation and sound toggle, tax invoice PDF for VAT-registered merchants, end-of-day summary.
Accept: totals reconcile with ledger; receipt token unguessable and revocable.

## M7 Unpaid bills and reminders
Open tab with intended-customer capture, abandoned detection, reminder schedule, STOP handling, merchant follow-up list, write-off, mark paid other.
Accept: time-travel tests via `Clock`: never more than 3, never more than 1 per day, never outside 08:00 to 20:00 SAST, none after paid or STOP.

## M8 Real adapters
Fetch current official docs for Meta WhatsApp Cloud API, Peach Payments, PayFast; write findings to `docs/PROVIDER_NOTES.md` (endpoints used, signature scheme, split and payout support, fees, limits, sandbox steps). Build adapters behind the ports and pass the shared contract test suite against sandbox credentials. Decide and record split provider (OPEN_QUESTIONS Q1).
Accept: contract tests pass for mock and each real adapter; sandbox e2e with a real phone documented.

## M9 Security and compliance
Threat model pass, rate limits, tenant-isolation test across all endpoints, secrets scan, dependency audit, PII retention job, POPIA data-subject export/delete, NTAG424 SDM verification live, tag revocation, audit log review screens.
Accept: security test suite green; no PII in logs (log scan test); DR restore rehearsed.

## M10 Pilot readiness
Operator console, tag batch import and printing sheet, onboarding checklist, runbook, alerting, load test, device matrix pass (see TEST_PLAN), pilot with 1 to 3 merchants.
Accept: runbook reviewed; k6 targets met; pilot go/no-go checklist signed.
