# Open questions and unverified assumptions

Claude Code: do not resolve these silently. Build behind config, record the choice at the bottom under "Decisions log".

## Business decisions (owner)

| # | Question | Default used until decided |
| --- | --- | --- |
| Q1 | Which provider handles split payments: Peach, PayFast Split Payments, or collect-then-payout? | `SPLIT_STRATEGY=ledger_only` (record splits, merchant settles externally) |
| Q2 | How does the platform earn: per-transaction fee, monthly fee, tag sales, share of tips? | No fee logic; `provider_fee_cents` recorded only |
| Q3 | Who owns the WhatsApp Business account and number, and is it one number for all merchants? | One platform number, merchant name in every message |
| Q4 | Pilot merchants and modes (suggest: one surf coach, one cafe, one car guard) | Seed data only |
| Q5 | Product name: "KakEnBetaal" contains Afrikaans vulgar slang ("kak"); fine for some audiences, risky for others and for Meta template review. Alternative e.g. "Tik en Betaal". | Name is `PRODUCT_NAME`; keep all copy name-agnostic |
| Q6 | Tip policy: who may keep tips, pooling rules, minimum payout | Tips go to the assigned staff; pool only when a shift has `tip_pool` |

| Q7 | Card tap on the merchant's phone (SoftPOS / "tap to pay on phone") as an extra payment method. Needs a certified provider SDK and a native app, not a PWA. Out of v1; the `PaymentProvider` interface must not block it (add a `softpos` capability later). | Not built |

## Compliance and legal (needs professional sign-off)

| # | Item |
| --- | --- |
| L1 | Funds flow: if the platform receives funds and pays out parties, a licensed partner is likely required (only banks may issue e-money in SA). `collect_then_payout` is gated by `FUNDS_FLOW_LEGAL_SIGNOFF=true`. |
| L2 | POPIA: lawful basis and notice for customer numbers, merchant sharing consent, retention periods (default proposal: raw numbers 24 months after last activity, receipts 5 years for tax), data-subject requests. |
| L3 | WhatsApp commercial messaging policy: opt-in capture for reminders, template approval, opt-out handling. |
| L4 | Tax: VAT treatment of tips, tax invoice format requirements, who is the supplier on a split sale. |
| L5 | Payment provider onboarding and terms for aggregators or sub-merchants. |
| L6 | Card scheme and PASA rules if the platform ever touches funds. |

## Technical assumptions to verify in M8 (fetch current official docs)

| # | Assumption |
| --- | --- |
| T1 | Peach Payments hosted checkout supports Apple Pay, Google Pay (requires Google Pay merchant ID), Pay by Bank, and signed webhooks; split or sub-merchant support and payouts product availability are NOT confirmed. |
| T2 | PayFast Split Payments allows an instant split to another PayFast account via custom integration; whether recipients must be PayFast accounts is unconfirmed; Apple Pay availability per channel to confirm. |
| T3 | WhatsApp Cloud API limits: button counts and title lengths, 24 hour window, template categories and pricing, rate limits, `wa.me` prefilled text behaviour. |
| T4 | NTAG424 DNA SDM configuration, key diversification (NXP AN12196), counter limits, and programming from Web NFC (likely not possible; programming via an operator tool or NFC-capable app). |
| T5 | Web NFC works only on Android Chrome and similar; iPhone staff use static tags plus QR and WhatsApp links. |
| T6 | Web Push on iOS requires an installed PWA. |
| T7 | Costs: tag prices and FX are estimates (NTAG213 wristband about R16 to R28, signed sticker about R16 to R17, PVC NTAG424 card about R41, plus landed-cost uplift). Re-quote before ordering. |

## Conflicts found between the PDF spec and this pack (M0 review)

The pack (`docs/*.md`) is used as the source of truth until the owner decides. Each is a copy decision, not a code risk; all copy lives in the message catalogue.

| # | Conflict | Pack says | PDF spec says | Used until decided |
| --- | --- | --- | --- | --- |
| O1 | Money format in messages | `R1 234,50` | `R 500.00` ("rands with two decimals") | Pack format (`formatRands`) |
| O2 | Tip step for fixed bills | 3 reply buttons: Tip 10% / Tip 15% / Other | List message: No tip, 10%, 15%, 20%, Custom (buttons cap at 3) | Decide in M3; the list keeps "No tip" one tap away |
| O3 | Quick-tip presets | R20 / R50 / Other (MESSAGES) and R5/R10/R20 (SPEC 3) | R5, R10, R20; Other | Per-merchant config, default R5/R10/R20 (I9) |
| O4 | Late webhook fallback | `reconcile.payments` every 15 min for sessions pending over 5 min | Poll the provider after 60 seconds | Add a targeted 60 s status poll per session in M1 |

| O6 | Session times out before payment | Bill `claimed → open` (release, or claim idle for SESSION_TTL) and also `claimed → abandoned` (customer left) | Same two rules | M1 releases to `open`. M7 decides when a timed-out claim becomes `abandoned` and starts reminders |

## Implementation choices made in M1 (revisit later)

| # | Choice | Why | Revisit |
| --- | --- | --- | --- |
| I1 | Inbound WhatsApp and provider webhooks are processed in the request, not via a queue | Simple and fast at pilot volume; every handler is idempotent and de-duplicated by `webhook_events` | M10 load test; move to pg-boss if p95 webhook time exceeds 300 ms |
| I2 | `webhook_events.payload` keeps only non-PII fields (kind, provider ref, amount), not the raw body | Raw WhatsApp bodies contain numbers and names in plain text (POPIA) | `webhook.replay` (M9) needs raw bodies: store them encrypted with `crypto.ts` |
| I3 | Tip step uses a list (No tip, presets, Other amount), resolving O2 provisionally | Keeps "No tip" one tap away and fits more than 3 options | Owner to confirm |
| I4 | Custom tip limits: R1,00 minimum, 100% of the bill maximum | SPEC 7 defaults | Per-merchant cap in M3 |
| I5 | NTAG424 tags are refused at `/t/` until SDM verification ships (M9); only static tags work, and only outside production unless `ALLOW_STATIC_TAGS=true` | Never accept an unverified tap | M9 |
| I6 | Fee absorbed by the merchant; tip goes 100% to the staff member tied to the bill, else the merchant | `ledger_only` with no split rules yet | M5 split rules and pools |

## Implementation choices made in M2 (revisit later)

| # | Choice | Why | Revisit |
| --- | --- | --- | --- |
| I7 | A bill link `/b/<token>` lets anyone holding it pay, with no bill code | The 192-bit token is the authorisation; SPEC 5 says someone else may pay. The bill code guards tag taps, where anyone nearby can tap | If merchants want links locked to the number on the bill |
| I8 | Open-amount and quick-tip bills are created by the tap, addressed to and claimed by that customer, and hidden from everyone else's matching | Two people at the same till or car guard must not lock each other out | - |
| I9 | Quick tip uses a list (R5, R10, R20, Other amount), resolving O3 with per-merchant presets (`quick_tip_presets_cents`, default R5/R10/R20) and limits R2 to R1 000 | Four options do not fit Meta's 3 reply buttons | Owner to confirm presets |
| I10 | Shares are set by the merchant (n equal shares, remainder cents on the first shares, or explicit amounts). A customer cannot type a custom share amount yet | Keeps every share summing to the bill to the cent | PDF step 2d "Custom amount" for groups: add when table service is piloted |
| I11 | A payment for a stale amount (checkout opened before a merchant edit) is recorded and flagged `payment.needs_refund`; the bill is not settled | Never settle a bill at an amount it no longer has | M5 refunds |
| I12 | Bill code lockout is per customer and tag: 3 wrong codes lock for 15 minutes, then the count restarts. A code prompt waits 10 minutes for the answer | SPEC 5 and 19 | M9 adds per-tag and per-IP rate limits |
| I13 | "Here is your slip again" applies to a bill on the tag the customer paid in the last 2 hours | Long enough for a customer still at the counter | - |
| I14 | Merchant create, release, edit and cancel are `PayFlow` methods without HTTP routes | They need staff auth, which arrives with the PWA in M4 | M4 |

## Implementation choices made in M3 (revisit later)

| # | Choice | Why | Revisit |
| --- | --- | --- | --- |
| I15 | Default tip cap is 100% of the bill with no rand cap; merchants can lower both | SPEC 7 default; a cap protects customers from typos such as 500 instead of 50 | Owner may want a lower platform-wide default |
| I16 | Presets that would exceed the cap are hidden rather than clamped | A clamped "20%" that is really 15% would mislead the customer | - |
| I17 | Tip settings are changed in the database for now | The settings screen is part of the manager dashboard (M4/M6) | M4 |

## Implementation choices made in M4 (revisit later)

| # | Choice | Why | Revisit |
| --- | --- | --- | --- |
| I18 | Refresh tokens and device id live in the PWA's localStorage, the access token in memory; no httpOnly cookie yet | The PWA and API are on different origins (Vercel and Railway); a cookie needs a shared parent domain and SameSite set-up | M9: move the refresh token to an httpOnly cookie once domains are fixed |
| I19 | Re-presenting a refresh token within 30 s of its rotation is treated as a retry, not theft | Weak signals lose responses; without this, staff were signed out at random (found by the Playwright tests). Reuse after 30 s still revokes the family | M9 threat model |
| I20 | SSE takes the access token as `?access_token=` | EventSource cannot set headers. Query strings are stripped from logs; tokens live 15 minutes | - |
| I21 | Live events fan out with Postgres LISTEN/NOTIFY | Works across several API instances without a new service | M10 load test |
| I22 | Push without VAPID keys is off, and alerts go by WhatsApp template (`merchant_paid_alert`, `merchant_failed_alert`); SMS is not built | SPEC 12 channel chain; SMS is optional | Meta template approval in M8; SMS if pilots need it |
| I23 | "Manager daily summary" is a setting (`notify_managers = daily_summary`) but the summary job is not built; daily-summary managers get no per-payment alert | Belongs with reports (M6) | M6 |
| I24 | Web NFC is used only to read a tag's code for assignment; writing tags is not built | Tags are programmed by the operator (OPEN_QUESTIONS T4) | M10 operator tools |

## Schema fixes made in M0

See `db/README.md`: `audit_log` trigger ordering, global `opt_outs` with null merchant, truncate guards.

## Decisions log

Append entries as `YYYY-MM-DD, question id, decision, reason, who`.

2026-10-02, Q5, Repo and package scope use the neutral name `tap-pay` / `@tappay`; `PRODUCT_NAME` stays KakEnBetaal in dev, pending owner decision, Claude Code
2026-10-02, -, Migrations are plain SQL files run by a small runner in packages/db (up/down, one transaction each, advisory lock), not Kysely's TS migrator, so the schema stays reviewable SQL, Claude Code
2026-10-02, -, Apps run TypeScript through tsx in dev and production (no build step) for M0; revisit before pilot if cold start or memory matters, Claude Code
2026-10-02, O2, Tip step implemented as a list message (see I3), Claude Code
2026-10-02, O3, Quick-tip presets are per merchant, default R5/R10/R20, shown as a list (see I9), Claude Code
