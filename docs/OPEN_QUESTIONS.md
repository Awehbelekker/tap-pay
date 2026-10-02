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
| O3 | Quick-tip presets | R20 / R50 / Other (MESSAGES) and R5/R10/R20 (SPEC 3) | R5, R10, R20; Other | Per-merchant config; seed R5/R10/R20 |
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

## Schema fixes made in M0

See `db/README.md`: `audit_log` trigger ordering, global `opt_outs` with null merchant, truncate guards.

## Decisions log

Append entries as `YYYY-MM-DD, question id, decision, reason, who`.

2026-10-02, Q5, Repo and package scope use the neutral name `tap-pay` / `@tappay`; `PRODUCT_NAME` stays KakEnBetaal in dev, pending owner decision, Claude Code
2026-10-02, -, Migrations are plain SQL files run by a small runner in packages/db (up/down, one transaction each, advisory lock), not Kysely's TS migrator, so the schema stays reviewable SQL, Claude Code
2026-10-02, -, Apps run TypeScript through tsx in dev and production (no build step) for M0; revisit before pilot if cold start or memory matters, Claude Code
2026-10-02, O2, Tip step implemented as a list message (see I3), Claude Code
