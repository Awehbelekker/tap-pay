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
| I23 | Managers on `daily_summary` get yesterday's totals at 06:30 SAST (push, else `merchant_daily_summary` template), not per-payment alerts. Built in M6 | A full day is only known after midnight; 06:30 is before most businesses open | Pilot feedback on the time |
| I24 | Web NFC is used only to read a tag's code for assignment; writing tags is not built | Tags are programmed by the operator (OPEN_QUESTIONS T4) | M10 operator tools |
| I25 | Provider fees are not reversed on a refund; each party keeps its share of the fee debit | Providers generally keep the fee on refunds; to be confirmed per provider | M8 PROVIDER_NOTES |
| I26 | Payouts are written to the ledger when created; a refund after payout makes the balance negative, which the next payout nets off (never a negative payout) | SPEC 9; a created payout is money committed to that person | - |
| I27 | Tips with no serving staff and no shift running go to a `pool` ledger party; distributing an old pool balance is not built | SPEC 8.1 says "no staff tied: pool"; who should get a pool with no shift needs a merchant decision | M6 dashboard |
| I28 | Split rules are sale shares only (basis points); fixed-amount shares per service and pool-by-hours are not built (shift weights stand in for hours) | Covers the SPEC example and pilots; fixed amounts can be added to `SaleShare` without schema change | Pilot feedback |
| I29 | The `payout.run` job handler lives in the API process (it needs the API's Money service); apps/worker owns the schedule | Avoids a second copy of the money code; pg-boss hands each job to one instance | M10, if the API should stay request-only |
| I30 | `SPLIT_STRATEGY` is one setting for the deployment; the per-merchant `merchants.split_strategy` column is not read yet | One provider per deployment until M8 | M8 |
| I31 | Tips carry no VAT and are shown as "Gratuity (no VAT)" on tax invoices; the VAT is 15/115 of the bill, rounded half up | Common treatment of voluntary gratuities passed to staff; needs an accountant's confirmation (L4) | Before the first VAT-registered pilot |
| I32 | Slips and invoices read the merchant's VAT details when rendered, so a slip made before registration shows VAT if opened after it | Simple, and merchants rarely change registration; a snapshot per receipt can be added if needed | L4 |
| I33 | One tax invoice per payment, gapless number per merchant (`INV-000001`), for the customer's latest payment in 30 days only; no credit notes for refunds yet (the invoice shows "Refunded since") | Covers the common ask; credit notes need the accountant's format | L4, before pilot |
| I34 | Reports put a payment on the SAST day it was confirmed (`paid_at`, new in M6) and a refund on the day it settled; "net" is paid less refunds less card fees | Matches how a merchant reads a day; `updated_at` moves on refunds | - |
| I35 | Receipt links are revoked or reissued by a manager; there is no automatic expiry | Customers need slips for years (tax, L2); revocation covers a misdirected link | L2 retention |
| I36 | A walk-up customer who only looked at a bill (never pressed Pay now) releases it; only a bill addressed to them, or one they started paying, is "abandoned" and reminded | Reminding someone who merely tapped would be unwelcome, and the tag must stay free for the next customer | Pilot feedback |
| I37 | STOP opts out of the business that last messaged the customer; STOP ALL (or STOP with no business known) of all. There is no START yet | SPEC 11.3 scopes; undoing an opt-out needs a deliberate customer action we have not designed | M9 POPIA review |
| I38 | A reminder is marked sent before the WhatsApp call: a crash loses at most one reminder, never sends two; a failed send counts toward the cap | The cap is a promise to the customer | - |
| I39 | Bills addressed to a number can be reminded although the customer may never have seen the "we may remind you" line (it is on the pay link message); every reminder carries STOP | The merchant addressed the bill to them; the notice in the first message would change every claim message | L2 legal |
| I40 | Table shares are released, not abandoned, and get no reminders | A share is not tied to one person until paid | Pilot feedback |
| I41 | Official provider docs were unreachable from the build environment; adapters follow each provider's own SDK/plugin code (signatures reproduced against their test vectors) and fakes built from the same notes. See PROVIDER_NOTES "Before going live" | The code is the strongest public source; docs check pending | Before pilot |
| I42 | WhatsApp sends are never retried (no idempotency key at Meta); failures and delivery receipts land in message_log | A retried send could double-message a customer | M10 notify.retry design |
| I43 | PayFast and Peach checkouts are de-duplicated per idempotency key in memory (neither has an idempotency key); the payments table's unique key is the durable guard | A second checkout is harmless: only the first is stored and sent | - |
| I44 | Refunds call the provider once per refund row (DB idempotency); the adapters' memo only covers a retry in the same process | Neither provider takes an idempotency key on refunds | M10, if refunds move to a job |

## Schema fixes made in M0

See `db/README.md`: `audit_log` trigger ordering, global `opt_outs` with null merchant, truncate guards.

## Decisions log

Append entries as `YYYY-MM-DD, question id, decision, reason, who`.

2026-10-02, Q5, Repo and package scope use the neutral name `tap-pay` / `@tappay`; `PRODUCT_NAME` stays KakEnBetaal in dev, pending owner decision, Claude Code
2026-10-02, -, Migrations are plain SQL files run by a small runner in packages/db (up/down, one transaction each, advisory lock), not Kysely's TS migrator, so the schema stays reviewable SQL, Claude Code
2026-10-02, -, Apps run TypeScript through tsx in dev and production (no build step) for M0; revisit before pilot if cold start or memory matters, Claude Code
2026-10-02, O2, Tip step implemented as a list message (see I3), Claude Code
2026-10-02, -, M5: ledger_only stays the default; collect_then_payout is built and tested against the mock but still refuses to start without FUNDS_FLOW_LEGAL_SIGNOFF, Claude Code
2026-10-02, Q1, Provisional: Peach Checkout v2 as the pilot card provider, PayFast supported as the alternative; SPLIT_STRATEGY stays ledger_only (PayFast splits to one PayFast merchant only, Peach has none, collect_then_payout needs L1). Owner and legal to confirm. See PROVIDER_NOTES, Claude Code
2026-10-02, -, M6: tax invoices are issued over WhatsApp on request (reply INVOICE) as PDFs; format to be confirmed by an accountant before the first VAT-registered pilot (L4), Claude Code
2026-10-02, O3, Quick-tip presets are per merchant, default R5/R10/R20, shown as a list (see I9), Claude Code
