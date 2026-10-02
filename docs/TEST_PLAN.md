# Test plan

## Layers

| Layer | Tooling | Scope |
| --- | --- | --- |
| Unit and property | Vitest, fast-check | `packages/core`: money, splits, state machines, matching, reminder schedule |
| Integration | Vitest + real Postgres (docker) | Repositories, API handlers, jobs, webhook idempotency |
| Contract | Shared suite | Every `PaymentProvider` and `WhatsAppClient` adapter passes the same tests (mock always; real against sandbox in M8) |
| End to end | Playwright + wa-sim | Full customer and merchant journeys |
| Security | Vitest + scripts | Auth, tenancy, signatures, PII |
| Load | k6 | Tap and webhook throughput |

## Property tests (must exist)

- Sum of all split postings for a payment equals the payment amount, for random amounts, rules and party counts.
- Rounding never creates or loses a cent; remainder always lands on the merchant.
- Tip percent maths never produces a negative or fractional-cent amount.
- Reminder scheduler: for random claim times, never more than 3, never more than 1 per day, always within 08:00 to 20:00 SAST.
- State machines: from every state, every event either transitions legally or is rejected; terminal states stay terminal.

## Concurrency tests

- 50 simultaneous taps on one tag with one open bill: exactly one claim.
- Duplicate provider webhook x10 in parallel: one payment success, one ledger posting set, one receipt.
- Two staff cancel and pay the same bill at once: one wins, consistent state.
- Refund requested twice with the same idempotency key: one refund.

## Required end-to-end scenarios

1. Appointment: coach creates bill, customer taps, tips 15%, pays, slip arrives, merchant alerted.
2. Counter: one open bill per till, tap, pay, no tip.
3. Table: several bills, bill code needed, wrong code x3 locks for 15 minutes.
4. Quick tip: car guard tag, R20, no bill created by merchant.
5. Field: coach with phone, bill by customer number, tap-less WhatsApp link.
6. Remote invoice: link sent, customer pays from link.
7. Split bill: three shares paid by three customers, bill closes when all paid.
8. Tap and leave: customer claims then walks off, reminders 1 to 3 fire on schedule, STOP stops them, merchant sees needs_follow_up.
9. Payment fails then retry succeeds.
10. Provider webhook arrives before the redirect and after (both orders).
11. Customer taps a paid bill: gets slip again.
12. Refund full and partial: ledger reversed, customer notified.
13. Staff leaves shift: tip pool recalculated per rules.
14. Revoked tag: tap rejected and logged.
15. Cloned static tag detection: NTAG424 replayed counter rejected.
16. WhatsApp 24 hour window closed: template used instead of session message.

## Security tests

- Every merchant endpoint with another merchant's ids returns 404 (generated from OpenAPI).
- Webhooks with missing, wrong or replayed signatures are rejected and logged.
- Claim tokens are single use and expire.
- JWT tampering, expired refresh reuse (revokes family).
- Rate limits on `/t/*`, OTP request, login.
- Log scan: no msisdn, token or key patterns in captured logs during the e2e run.
- Encrypted columns are not readable in plain form in DB dumps.

## Device and browser matrix (M10)

Android: Pixel (Chrome), Samsung (Samsung Internet), one low-end device. iPhone: Safari with static tag and QR, installed PWA for push. WhatsApp: current and one older version. Wallets: Apple Pay on iPhone, Google Pay on Android, Pay by Bank. Record results in `docs/DEVICE_MATRIX.md`.

## Load targets (initial, adjust after pilot)

200 taps per second burst, 50 webhooks per second sustained, p95 tap redirect under 150 ms, p95 webhook handling under 300 ms, zero lost events.

## CI gates

typecheck, lint, unit, integration, contract (mock), Playwright smoke, secret scan, `npm audit` high severity fails.
