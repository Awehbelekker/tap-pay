# KakEnBetaal product specification

Version 1 scope. Currency: ZAR. Time zone for all schedules: Africa/Johannesburg. All amounts are integer cents.

## 1. Overview

A merchant (shop, coach, cafe, restaurant, car guard) wears or places an NFC tag. The tag identifies a person, till or table and never holds an amount. The customer taps the tag with their phone; WhatsApp opens with a pre-filled message; the bot shows the bill, takes a tip, and sends a link to the payment provider's hosted checkout where the customer approves with Apple Pay, Google Pay or Pay by Bank. A webhook confirms payment; the customer receives a branded slip in WhatsApp; the merchant is notified; the money is split and paid out.

Merchants create bills in a PWA. A merchant needs no card machine and no special hardware beyond the tag.

## 2. Actors

| Actor | Description |
| --- | --- |
| Customer | Anyone with a phone and WhatsApp. No account, no app. |
| Staff | Coach, cashier, waiter. Creates bills, sees own payments and tips. Role `staff`. |
| Manager | Configures the merchant: services, staff, tags, rules, reports, refunds. Role `manager`. |
| Owner | Manager plus bank details, KYC and billing. Role `owner`. |
| Operator | The platform team. Operator console only. |

## 3. Merchant modes

Each merchant (or location) sets a mode. New merchant types are new combinations of settings, not new code.

| Mode | Examples | Who creates the bill | Customer match | Tag bound to | Tip and split default |
| --- | --- | --- | --- | --- | --- |
| `appointment` | Surf coaches, salons, physios | Staff, with customer's WhatsApp number | Number on bill; bill code if another number taps | person | Revenue split shop/staff; tip direct to staff |
| `counter` | Cafes, retail | Till or PWA | First tap claims | till | Tip to pool, optional |
| `table` | Restaurants | Waiter or POS, one bill per table | Table tag; payers claim shares | table | Tip direct or pool |
| `quick_tip` | Car guards, petrol attendants | No bill; customer types amount | None | person | Presets R5/R10/R20, 100% to person |
| `field` | Delivery, trades, markets | PWA sends link to customer's number | Number on bill | person or vehicle | Per merchant |
| `remote_invoice` | Anyone billing without a tap | PWA or dashboard | Number on bill | none | Per merchant |

Bill types: `fixed` (priced service or amount), `open` (customer or staff types the amount), `quick_tip` (no bill record beyond the session; amount goes to the tagged person).

Per-merchant settings: mode, tip presets, tip rule, revenue split rule, bill expiry (default 24 h), session expiry (default 10 min), reminder settings, notification settings, receipt branding, VAT number.

## 4. Primary flow (fixed bill, appointment mode)

1. Staff creates a bill in the PWA: picks "Beginner lesson R 500.00", optionally enters the customer's WhatsApp number. Bill is `open`.
2. Customer taps the staff's tag. Tap endpoint verifies the tag, mints a one-time claim token, and redirects to `wa.me/<number>?text=PAY <token>`.
3. Customer taps Send. The WhatsApp webhook delivers `PAY <token>`; the bot resolves the tag and customer and applies matching (§5).
4. Bot shows merchant, staff, service and amount, and asks for a tip (list message).
5. Bot shows the confirmation with total and Pay now / Change tip.
6. Pay now returns a link to hosted checkout. Customer approves with their wallet.
7. Provider webhook confirms. System marks session and bill `paid`, writes the ledger, runs the split, sends the slip, notifies staff and manager.

Target: tap to slip under 30 seconds.

## 5. Bill matching rules

On a verified tap of tag T by customer number N (from the WhatsApp message):

1. If T's mode is `quick_tip`: go to the quick tip flow (§7). No bill.
2. Find open bills on T addressed to N. One match: use it. Several: send a list message to choose.
3. Otherwise find T's tag-claimable bill (no customer number, status `open`) and claim it atomically for N. Exactly one tag-claimable open bill per tag is allowed (DB partial unique index).
4. Otherwise, if T has a bill claimed by another number: send `bill_locked`.
5. Otherwise, if T has open bills addressed to other numbers: ask for the 4-digit bill code (`code_needed`); max 3 attempts, then lock the attempt for 15 minutes.
6. Otherwise: `no_open_bill`.
7. For `open`-type tags with no bill: ask the customer for the amount (`ask_amount`) and create the bill on the fly.

Additional rules:

- The merchant can release a claimed bill from the PWA; the old session is cancelled.
- If the merchant edits the amount after a claim, cancel the old session and start a new one; tell the customer.
- A bill link or QR (`/b/<token>`) carries the bill id, so no ambiguity when several customers wait.
- Someone else may pay a bill. The payer gets the slip; the merchant sees the payer's masked number.
- Groups: a bill can have shares (`bill_shares`). Each payer claims one share (equal or custom amount). Bill is `paid` when shares sum to the total.
- The confirmation message always shows merchant name, staff name, service and amount before Pay now.

## 6. State machines

### 6.1 Bill

`open → claimed` (claim) · `claimed → open` (release, or claim idle for SESSION_TTL) · `open|claimed → paid` (payment confirmed) · `open|claimed → cancelled` (merchant) · `open → expired` (BILL_EXPIRY) · `claimed → abandoned` (customer left: session expired unpaid) · `abandoned → needs_follow_up` (reminders exhausted) · `abandoned|needs_follow_up → paid | paid_other | written_off | cancelled`.

`paid_other` requires a reason (cash, EFT, other) and is audit-logged.

### 6.2 Session

`claimed → awaiting_amount` (open amount or quick tip) · `claimed|awaiting_amount → awaiting_tip` · `awaiting_tip → awaiting_confirm` · `awaiting_confirm → awaiting_tip` (Change tip) · `awaiting_confirm → awaiting_payment` (Pay now, checkout created) · `awaiting_payment → paid | failed | expired | cancelled` · `paid → refunded | partially_refunded`.

Terminal: `paid` (until refund), `failed`, `expired`, `cancelled`, `refunded`. A `failed` session lets the customer retry, which creates a new session on the same bill with a new reference.

All transitions are pure functions in `packages/core/state`. Illegal transitions throw and are tested exhaustively.

## 7. Tips

- Presets: No tip, 10%, 15%, 20%, Custom (configurable per merchant, max 4 presets plus custom).
- Percent tip = round half up to the cent on the bill amount (not on any prior tip).
- Custom tip: numeric rands (up to 2 decimals), min R1.00 when non-zero, max 100% of the bill (configurable cap). Invalid input re-asks.
- Quick tip mode: presets R5, R10, R20 and Other; min R2.00, max R1,000.00 (configurable).
- Tip and bill are separate ledger lines on one payment.

## 8. Revenue split, tip split and ledger

### 8.1 Rules

- `revenue_split`: shares between merchant and the serving staff member, as percentages or fixed amounts per service. Example: Beginner lesson R500: shop 30%, coach 70%.
- `tip_rule`: `direct` (100% to the staff tied to the bill/tag), `pool` (shared across the shift), or `house_cut` (X% to merchant, rest direct or pool). No staff tied: pool.
- Pool distribution: equal share among shift members, or by hours if hours are recorded.
- Provider fee: allocated proportionally across parties by gross share unless the merchant sets "merchant absorbs".
- Platform fee: configurable per merchant (percentage and fixed). Default 0 until decided (OPEN_QUESTIONS).

### 8.2 Rounding

Compute each non-merchant party's share by flooring `amount × percent`. The merchant receives the remainder, so lines always sum exactly to the payment. Property tests must prove: for any amounts and rules, `sum(credit lines) + provider_fee + platform_fee == gross`.

### 8.3 Ledger

`ledger_entries` are append-only. Each payment writes: `bill` credits per party, `tip` credits per party, `provider_fee` debit, `platform_fee` debit. Refunds append reversing entries; nothing is updated or deleted. Balances are derived by summing entries by party and status (`pending`, `available`, `paid_out`).

### 8.4 Split strategies (`SPLIT_STRATEGY`)

| Value | Behaviour | Use |
| --- | --- | --- |
| `ledger_only` | All funds settle to the merchant; ledger records who is owed what; payouts to staff are simulated/manual | Dev, tests, early pilot with the merchant paying staff |
| `native` | The provider splits at settlement (e.g. PayFast Split Payments to a second account) | Preferred when supported |
| `collect_then_payout` | Collect to one account, pay out via payouts API | Needs legal sign-off (platform holds funds). Refuses to start in production without `FUNDS_FLOW_LEGAL_SIGNOFF=true` |

The provider adapter exposes `capabilities.nativeSplit` and `capabilities.payouts`. The ledger is the single source of truth regardless of strategy.

## 9. Payouts

- Daily run at 06:00 SAST; pay each party whose `available` balance is at least the merchant's threshold (default R100, configurable; 0 = always).
- Staff and merchants get a WhatsApp/PWA message when paid out.
- A refund after payout is netted off the next payout (never negative payout).
- Reconciliation job compares ledger to provider settlement reports nightly and flags differences.

## 10. Refunds and disputes

- Manager or owner triggers a full or partial refund from the dashboard with a reason.
- Provider refund is called; on success, append reversing ledger entries (bill and tip lines proportionally) and notify everyone involved.
- Provider chargeback notice: reverse split lines, flag merchant, notify manager and operator.
- Customers can message HELP for a menu: Pay a bill, Get my slip, Talk to the merchant.

## 11. Unpaid bills and reminders

### 11.1 Abandonment and failure

- Customer left before paying: session expires → bill `abandoned`.
- Payment failed: the bot immediately offers Try again / another method, then reminders apply.

### 11.2 Reminder schedule (per merchant, defaults)

| # | When | Template |
| --- | --- | --- |
| 1 | 10 minutes after abandonment/failure | `reminder_1` |
| 2 | Next day 09:00 | `reminder_2` |
| 3 | 3 days after abandonment, 09:00, says it is the last | `reminder_3` |

After reminder 3 the bill becomes `needs_follow_up` in the merchant's Unpaid tab.

### 11.3 Rules

- Max 3 reminders per bill, max 1 per day, only 08:00–20:00 SAST (queue and send in window).
- Each reminder names the merchant and amount, includes a fresh Pay now link, and offers opt-out.
- Stop immediately when: paid (any route), customer replies STOP, merchant cancels/writes off, someone else pays, merchant disabled reminders for the service.
- STOP creates an `opt_outs` row (scope: merchant, or global on "STOP ALL"). Never message an opted-out number about that scope again.
- Outside the free 24 h window, use approved templates (see MESSAGES.md).
- Log every reminder in `reminders` with sequence number, template, status.
- The first message of a flow tells the customer they will be reminded if the bill stays unpaid and how to stop.

### 11.4 Merchant controls

Settings: reminders 0–3, timing, quiet hours. Unpaid tab: status (abandoned, failed, needs_follow_up), age, reminders sent, buttons Send reminder, Resend link, Mark paid another way (reason required), Write off. Opted-out customers are flagged so the merchant follows up in person.

## 12. Notifications

Notify only after provider-confirmed payment, never on Pay now.

| Who | Event | Content |
| --- | --- | --- |
| Staff | Paid | Amount, service, tip, their share, masked customer |
| Staff | Failed/expired/abandoned | Bill, reason, Retry button |
| Manager | Each payment or daily summary (setting) | Total, shop share, staff, tip |
| Staff on pool | Paid and at payout | Tip earned; payout amount |
| All involved | Refund | Amount, share reversed |
| Customer | Paid, failed, reminders | See MESSAGES.md |

Channel order: PWA live stream (SSE) → Web Push → WhatsApp (template if outside window) → SMS (optional, last resort). One notification per payment per recipient, keyed on provider reference. Fall back down the chain on failure; record every attempt in `notifications`.

## 13. Privacy and customer details

- System receives: WhatsApp number, WhatsApp profile name, timestamps, bill, progress. Never card data, never surname.
- Store number encrypted + HMAC hash. Display masked (`***482`) and profile name's first token.
- Merchant sees full number only when: it was entered by the merchant on the bill (appointment/field/remote), or the customer pressed Yes on the share-number prompt for unpaid bills (`share_number_consent`).
- Retention: slips and ledger per tax law (default 5 years, confirm), message logs 90 days, abandoned-bill customer data 12 months. Deletion on request erases contact data and keeps anonymised ledger rows. All configurable; legal to confirm (POPIA).

## 14. Receipts and tax invoices

- Branded slip (PNG, ≤ 1 MB) generated server-side (satori + resvg) and sent as WhatsApp image; also available at a signed URL `/r/<token>` as PNG and PDF.
- Slip shows: merchant name and logo, service, bill, tip, total, method, date, reference, split not shown to customer.
- Tax invoice on request: customer sends company name and VAT number; system generates a PDF with the merchant's VAT number and required fields. Format needs legal/accounting confirmation.
- Slip print animation is a UI nicety in the PWA preview only.

## 15. Merchant PWA (staff)

Installable PWA, mobile-first. Screens:

1. Sign in: WhatsApp OTP first time on a device, then PIN. Short-lived access token, refresh token.
2. Today: totals, tips, recent payments, live status stream.
3. New bill: service picker or amount, optional customer number, tag selection (default: own tag). Shows QR, "Send via WhatsApp" and status.
4. Bill detail: live status (waiting, customer viewing, paid, failed, expired), actions (cancel, release, resend, remind).
5. Unpaid tab (§11).
6. Settings: sound, vibration, notifications, device list.

Behaviours: SSE live updates; sound and vibration on Paid; cached service/price list (offline read); creating a bill requires a connection; installable; push subscription management. Optional on Android Chrome only: write a per-sale URL to a blank tag with Web NFC (feature-detected, hidden elsewhere).

## 16. Manager dashboard

Services and prices; staff (invite by WhatsApp number, roles, deactivate); tags (assign to person/till/table, disable, rotate, status); tip and revenue rules; reminder and notification settings; reports (day, staff, service, tips, unpaid); payments with refund action; payouts; shifts for pools; receipt branding and VAT number; audit log view.

## 17. Operator console

Merchants (create, KYC status, suspend); tag inventory and batches (generate keys, URL templates, mark provisioned); webhook failures and replay; unreconciled payments; pending payouts; provider and WhatsApp health; feature flags; support tools to resend slips or notifications.

## 18. Tags

- Production tags: NTAG424 DNA with Secure Dynamic Messaging (SDM). Each tag has a diversified key derived from `TAG_MASTER_KEY` and the tag UID. The tag URL is `https://<PUBLIC_TAP_DOMAIN>/t/<tag_code>?e=<PICC data>&c=<CMAC>`.
- Server verification (`packages/tag`): load tag by `tag_code`; decrypt PICC data with the tag key; check UID matches; check counter is strictly greater than `last_counter`; verify CMAC; on success store new counter. Follow NXP AN12196; unit tests must include the application note's test vectors.
- Pilot-lite: `tag_security = 'static'` for NTAG213; no replay protection; the UI shows a warning; refuse in production unless `ALLOW_STATIC_TAGS=true`.
- Tap endpoint failures show a generic "ask staff to take payment another way" page, never details.
- Tag lifecycle: `provisioned → active → disabled | lost`; rotating issues a new tag and disables the old.
- Tap endpoint response: 302 to `https://wa.me/<WA_PHONE_NUMBER>?text=PAY%20<token>`. If the device cannot open WhatsApp, render a web fallback page offering the same flow via hosted checkout (v1: a simple pay page).

## 19. Security

- Signed webhooks; constant-time comparisons; replay window on timestamps where the provider supplies them.
- Rate limits: taps per tag and per IP; OTP per number; bill code attempts (3, then 15-minute lock); API per user.
- Claim tokens: 6 characters base32, single use, 120 s TTL, stored hashed.
- Roles enforced in middleware; manager-only actions: refunds, tags, rules, staff, services.
- Encrypted secrets; PII encryption; HMAC pepper in env; audit log immutable (insert-only).
- Dependency scanning and lockfile checks in CI.

## 20. Non-functional targets (assumptions to confirm in pilot)

| Requirement | Target |
| --- | --- |
| Tap to bill message | < 3 s |
| Payment confirmed to merchant notification | < 5 s |
| Availability in pilot | 99.5% monthly |
| Pilot scale (with headroom) | 10 merchants, 1,000 payments/day; design for 100 merchants |
| Phones | iPhone XS+ (background tag reading), Android with NFC on |

## 21. Out of scope for v1

Own stored-balance wallet; smart pod hardware with display; table-service group payments beyond equal/custom shares; venue-wide tip pools across merchants; multi-currency; native apps; Tap to Pay on iPhone / SoftPOS.
