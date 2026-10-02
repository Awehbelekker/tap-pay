# Architecture

## Components

| Component | Responsibility |
| --- | --- |
| `apps/api` | Fastify HTTP API: public tap/bill/receipt endpoints, WhatsApp and provider webhooks, merchant and operator APIs, SSE stream |
| `apps/worker` | pg-boss workers: reminders, expiry, payout run, reconciliation, notification retries, webhook replay |
| `apps/web` | React PWA: merchant POS, manager dashboard, operator console (route-gated) |
| `packages/core` | Pure domain logic: Cents, split maths, bill and session state machines, matching, reminder schedule, message selection |
| `packages/db` | Kysely types, migrations, repositories, tenant-scoped query helpers |
| `packages/providers` | `PaymentProvider` adapters: mock, peach, payfast |
| `packages/whatsapp` | `WhatsAppClient` adapters (cloud, sim), webhook parser, message catalogue renderer |
| `packages/tag` | NDEF URL build, NTAG424 SDM verification (AES-CMAC, key diversification), static-tag mode |
| `packages/wa-sim` | Local WhatsApp simulator: web UI that behaves like a phone chat against the API |
| `packages/slip` | Slip PNG renderer (satori + resvg) and tax-invoice PDF |

## Repo layout

```
apps/{api,worker,web}
packages/{core,db,providers,whatsapp,tag,wa-sim,slip,config,testkit}
db/schema.sql  api/openapi.yaml  docs/  docker-compose.yml  .env.example
```

`packages/config` loads and validates env with Zod; the app refuses to start on invalid config.

## Request flows

1. Tap: phone reads tag URL `https://<PUBLIC_TAP_DOMAIN>/t/{tagCode}?...` (SDM params if NTAG424). API verifies tag, resolves open bill by matching rules (SPEC §5), mints a one-time claim token (TTL `CLAIM_TOKEN_TTL_SECONDS`), 302 to `https://wa.me/<WA_PHONE_NUMBER>?text=PAY <token>`.
2. WhatsApp inbound: webhook verified, stored in `webhook_events` (unique on message id), enqueued, handled by session engine which calls pure core functions, writes state, sends replies via `WhatsAppClient`.
3. Payment: session creates a checkout via `PaymentProvider.createCheckout`, sends link. Provider webhook (verified, idempotent) moves session to paid, writes ledger entries, enqueues receipt and notifications. Redirect pages are informational only.
4. Notifications: merchant event -> `Notifier` chain SSE, Web Push, WhatsApp template, SMS (SPEC §12).

## Adapter interfaces (in `packages/core/ports`)

```ts
interface PaymentProvider {
  readonly name: string;
  readonly capabilities: { nativeSplit: boolean; payouts: boolean; tokenization: boolean; methods: string[] };
  createCheckout(i: { reference: string; amount: Cents; description: string; customerRef?: string;
                      splits?: SplitInstruction[]; returnUrl: string; webhookUrl: string; idempotencyKey: string }): Promise<{ providerRef: string; url: string; expiresAt: Date }>;
  verifyWebhook(i: { headers: Record<string,string>; rawBody: Buffer }): Promise<VerifiedEvent>; // throws on bad signature
  getPaymentStatus(providerRef: string): Promise<PaymentStatus>;
  refund(i: { providerRef: string; amount: Cents; reason: string; idempotencyKey: string }): Promise<RefundResult>;
  createPayout?(i: { to: PayoutDestination; amount: Cents; reference: string; idempotencyKey: string }): Promise<PayoutResult>;
}
interface WhatsAppClient { sendText; sendButtons; sendList; sendTemplate; sendImage; markRead }
interface PushClient { send(sub, payload) }
interface Clock { now(): Date }           // tests control time
interface Notifier { notify(merchantId, event): Promise<void> }
```

Mock provider serves `/mock-checkout/:ref` with buttons Succeed / Fail / Cancel / Delay and posts signed webhooks to the API. It must be able to simulate duplicate and out-of-order webhooks.

## Jobs (pg-boss)

| Job | Schedule | Purpose |
| --- | --- | --- |
| `reminder.send` | per reminder row | Send reminders 1..3 within quiet-hours rules |
| `session.expire` | every minute | Expire sessions and claim tokens |
| `bill.expire` | every 15 min | Expire/abandon bills past `BILL_EXPIRY_HOURS` |
| `payout.run` | daily 06:00 SAST | Build payouts above threshold |
| `reconcile.payments` | every 15 min | Poll provider for pending sessions older than 5 min |
| `notify.retry` | every minute | Retry failed notifications with backoff |
| `webhook.replay` | on demand | Reprocess stored events |
| `retention.sweep` | daily | Apply retention (SPEC §13) |

## Realtime

SSE at `GET /v1/merchant/events` with `Last-Event-ID` resume; events: `bill.claimed`, `bill.paid`, `bill.failed`, `tip.received`, `bill.abandoned`. Heartbeat every 25 s.

## Auth

- Merchant staff: WhatsApp OTP to enrol, then PIN; short JWT access (15 min) + rotating refresh token (httpOnly cookie for web). Device binding recorded in `devices`.
- Operators: email + password + TOTP.
- Roles: `owner`, `manager`, `staff`. Staff see only their own bills and tips.

## Tenancy and data protection

All repositories take a `TenantContext` and add `merchant_id` predicates; raw queries are lint-banned outside `packages/db`. Optional Postgres RLS as defence in depth (policy by `app.merchant_id` setting). PII fields via `crypto.ts` (AES-256-GCM, key from `ENCRYPTION_KEY`, versioned key id prefix for rotation); lookups by `HMAC-SHA256(msisdn, HASH_PEPPER)`.

## Deployment

Railway services: `api`, `worker`, Postgres. Vercel: `web`. Tap domain points to `api`. One Docker image for api and worker with different start commands. Migrations run as a release step. Backups: daily Postgres snapshot, tested restore. Staging and production are separate projects with separate WhatsApp numbers and provider credentials.

## Observability

pino JSON logs with redaction (msisdn, tokens, authorization), request ids, `prom-client` metrics at `/metrics` (internal), `/healthz` (liveness), `/readyz` (db + queue). Alerts: webhook failure rate, payment pending > 15 min, job queue depth, payout failures, WhatsApp send failures.

## Error handling

Typed errors with stable codes; customers never see raw errors, they get a catalogue message plus a "Talk to the merchant" button. Every WhatsApp handler is safe to run twice.
