# Provider notes (M8)

What the WhatsApp, PayFast and Peach Payments adapters rely on, where each fact came from, and
how sure we are. Researched 2026-10-02.

**How this was researched.** The build environment could not reach the official docs sites:
`developers.facebook.com`, `developers.payfast.co.za` and `developer.peachpayments.com` were
blocked by its network policy. Facts were taken from each provider's **own published code**
instead: SDKs, plugins and samples on GitHub and GitLab, read in full. Docs text was used only
where a search snippet quoted it.

Confidence labels:
- **Verified**: in the provider's own code. Where available, reproduced against its test
  vectors (see the tests named below).
- **Corroborated**: official docs quoted in search snippets, or several third parties agree.
- **Unverified**: one source, or none. These must be checked before going live (see the
  checklist at the end).

Detailed research with verbatim code excerpts was kept in the session scratchpad. The adapters
cite the parts they use.

---

## WhatsApp Cloud API (`packages/whatsapp/src/cloud.ts`)

**Sources** (all Meta-owned):
- `fbsamples/whatsapp-business-jaspers-market` (Sep 2026)
- `facebook/facebook-nodejs-business-sdk` (main: Graph `v26.0`)
- `WhatsApp/WhatsApp-Nodejs-SDK`
- `WhatsApp/WhatsApp-Flows-Tools`
- `fbsamples/whatsapp-api-examples`

| Fact | Confidence |
| --- | --- |
| `POST https://graph.facebook.com/{version}/{phone-number-id}/messages`, `Authorization: Bearer` | Verified |
| `WA_GRAPH_VERSION` default `v23.0` (the newest official sample's SDK); SDK main is at `v26.0`; deprecation dates unknown | Verified / inference |
| Message bodies: text, interactive `button` (1–3 replies, title ≤ 20, id ≤ 256), interactive `list` (≤ 10 rows, row title ≤ 24, description ≤ 72, button ≤ 20, body ≤ 1024), template with body parameters, image/document by `link` with caption and filename | Verified |
| Mark as read: `{messaging_product, status: "read", message_id}` | Verified |
| Webhook: GET verify (`hub.mode=subscribe`, `hub.verify_token`, echo `hub.challenge`); `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(raw body, app secret)>` | Verified |
| Webhook payload `entry[].changes[].value.{metadata, contacts, messages, statuses}`. Note: some SDK typings get `metadata` wrong; it is an object with `phone_number_id` | Verified |
| `statuses[].status = failed` with `errors[].code` | Corroborated |
| Error 131047 = outside the 24-hour window (send a template); 130429 = throughput limit; 131056 = too many to one user | Corroborated |
| Text ≤ 4096, caption ≤ 1024 | Corroborated |
| Throughput 80 msg/s by default, auto-upgrades to 1,000 | Corroborated |
| Webhook retries with backoff for up to 7 days: answer 200 fast, dedupe by message id (we do) | Corroborated |
| Per-message pricing since 1 July 2025: utility templates and replies within the 24-hour window are free; marketing and authentication templates are charged | Corroborated |
| `wa.me/<digits>?text=<urlencoded>` | Corroborated |

**Design choices:**
- **Sends are never retried.** Meta has no idempotency key, so a retry after a lost response
  could double-message a customer. Failures are logged in `message_log`.
- **Delivery receipts** update `message_log.status`. A failure is stored as `failed:<code>`.
- **Template language** is `WA_TEMPLATE_LANG`, the language the templates were approved
  under.

**Templates to register with Meta** (MESSAGES.md):
- `merchant_paid_alert`, `merchant_failed_alert`, `merchant_refund_alert`
- `merchant_daily_summary`, `staff_tip_payout`
- `reminder_1`, `reminder_2`, `reminder_3`
- `otp`: authentication category.

All except `otp` should be utility category.

---

## PayFast (`packages/providers/src/payfast.ts`)

**Sources:**
- `PayFast/payfast-php-sdk` (official, v1.1.6) and `PayFast/payfast-common` (official), both
  read in full.
- `woocommerce/woocommerce-gateway-payfast` (third party, widely deployed).
- PayFast publishes no Node SDK.

| Fact | Confidence |
| --- | --- |
| Checkout is a form POST to `https://www.payfast.co.za/eng/process` (sandbox `https://sandbox.payfast.co.za/eng/process`). We send a short link to our page `/pay/c/:token`, which posts the form | Verified |
| Fields, in documented order: `merchant_id, merchant_key, return_url, cancel_url, notify_url, m_payment_id, amount ("550.00"), item_name, custom_str1` | Verified |
| **Form signature**: md5 of PHP-urlencoded `k=v&…` in that order, empty values skipped, values trimmed, `&passphrase=` last. `setup` (split) is not signed | Verified (SDK code) |
| **ITN** (notify_url) is form-encoded. Signature over the fields in the order received, up to `signature`, empty values kept, `&passphrase=` appended. **Our code reproduces the SDK's own test vector** (`4078bca2…`, `packages/providers/test/payfast.test.ts`) | Verified |
| ITN checks: source address resolves from `www`, `sandbox`, `w1w` or `w2w.payfast.co.za` (skipped in sandbox, as the official plugins do); `merchant_id` matches; server confirmation `POST /eng/query/validate` returns `VALID`; amount | Verified |
| `payment_status`: `COMPLETE`, `FAILED`, `PENDING` (we ignore it and wait for the next ITN), `CANCELLED`. `amount_fee` is **negative** | Verified |
| REST API `https://api.payfast.co.za` (test: `?testing=true`, not signed). Headers `merchant-id`, `version: v1`, `timestamp`, `signature` = md5 of headers + query + body + passphrase **sorted by key**, empty values skipped | Verified |
| Refund: `POST /refunds/{pf_payment_id}` with `amount` in **cents**, `reason`, `notify_buyer`. Not available in sandbox (the official SDK refuses) | Verified (path) / Corroborated (cents) |
| Split payments: unsigned form field `setup={"split_payment":{"merchant_id":…,"amount"|"percentage",…}}`, cents, **one** receiver, enabled on both accounts | Corroborated |
| Payouts / disbursement API | **Not found**: PayFast pays third parties only via split at checkout |
| Fees: card 3.2% + R2.00; Instant EFT 2.0% (min R2.00) | Corroborated (payfast.io/fees snippet) |
| Sandbox: virtual wallet, no test cards; ITNs are sent | Corroborated |

**Design choices:**
- `m_payment_id` is derived from our idempotency key, so a retried Pay now is the same payment.
- `PAYFAST_PASSPHRASE` is limited to `[A-Za-z0-9_-]`, so every PayFast implementation signs
  alike. The SDK double-encodes the passphrase.
- `getPaymentStatus` reads verified ITNs. PayFast's `/process/query/{id}` was not confirmed.

---

## Peach Payments (`packages/providers/src/peach.ts`)

**Sources** (Peach's official code is on GitLab group `p2886`):
- `plugin-magento-v2.0`, committed 2026-10-02, with a **live sandbox contract-test suite**. The
  strongest source.
- `checkout-php-sdk` and `payment-links-php-sdk`.
- Third party: a Medusa (TypeScript) plugin.

| Fact | Confidence |
| --- | --- |
| Hosted **Checkout v2**: `POST https://testsecure.peachpayments.com/v2/checkout` (live `secure.`), Bearer token + allowlisted `Referer`, JSON with flat dotted keys (`authentication.entityId`, `amount "550.00"`, `currency`, `paymentType: DB`, `merchantTransactionId`, unique `nonce`, `shopperResultUrl`). Answer `{checkoutId (32 hex), redirectUrl}` | Verified (contract tests) |
| OAuth: `POST https://sandbox-dashboard.peachpayments.com/api/oauth/token` (live `dashboard.`) `{clientId, clientSecret, merchantId}` → `{access_token, token_type: Bearer, expires_in}`; cached | Verified |
| `notificationUrl` overrides the configured webhook URL per checkout | Corroborated (SDK docs) |
| `merchantTransactionId` length: up to about 128 since mid-2026, 8–16 alphanumeric before. We send 32 hex + `v<attempt>` | Corroborated |
| **Webhook** (Checkout): form-encoded, `signature` = HMAC-SHA256(secret token) over the other fields sorted by key, `key+value` concatenated with no separators. **Our code reproduces the SDK's two example webhooks** (`55acdf4c…`, `96bd51b2…`, `packages/providers/test/peach.test.ts`). The first configuration webhook is JSON (ignored) | Verified |
| Result codes: success `/^(000\.000\.\|000\.100\.1\|000\.[36])/`, pending `000.200.*` (ignored), cancelled `100.396.101/104` | Verified |
| Webhook retries for 7 days | Corroborated |
| **Refund**: `POST https://testapi.peachpayments.com/v1/checkout/refund` (live `api.`), form-encoded and signed, `{authentication.entityId, amount, currency, id (payment id from the webhook, not checkoutId), paymentType: RF}`. A decline still returns HTTP 200: we check `result.code` | Verified |
| Status: signed v1 `GET {secure}/status?authentication.entityId&checkoutId&signature`; response shape not confirmed | Unverified |
| Header-signed webhooks (opt-in, July 2026) | Unverified (format); not used |
| Split payments / marketplace | **Not found** |
| Payouts product (EFT from a pre-funded float, `sandbox-payouts.` / `payouts.peachpayments.com`, OAuth) | Exists (Corroborated); endpoints unverified; **not used** |
| Fees about 2.95% + R1.50 (local 3DS cards) | Unverified (third party) |
| Test cards `4200000000000091` (frictionless 3DS) | Corroborated |

---

## Decision: split provider (OPEN_QUESTIONS Q1)

**Recommendation:**
- **Pilot:** Peach Checkout v2 as the card provider (Apple Pay, Google Pay and cards on a hosted
  page; the cleanest API; refunds by API).
- **Split strategy:** stays **`ledger_only`**. The merchant pays staff from their own account;
  the app records who is owed and lets managers mark payouts paid (M5).

Why not a native split:
- PayFast's split pays **one** other PayFast merchant per payment. Our splits are many (serving
  staff, tip pool, house cut), and most staff will not have PayFast merchant accounts.
- Peach has no split.
- `collect_then_payout` through Peach Payouts would mean the platform holds third-party funds,
  which needs legal sign-off (L1), and its API is not yet confirmed.

PayFast stays fully supported as the alternative provider: it has more local methods (Instant
EFT, Capitec Pay, SnapScan and others) and a lower barrier to sign-up. `SPLIT_STRATEGY=native`
is refused at start-up until per-payment split instructions are built.

**Owner and legal to confirm.** This is recorded as provisional in OPEN_QUESTIONS.

---

## Sandbox run with a real phone (M8 acceptance, manual)

You need:
- a Meta developer app with a WhatsApp test number;
- a public HTTPS URL for the API (e.g. a tunnel);
- Peach sandbox credentials (or PayFast sandbox).

1. Set:
   - `WA_MODE=cloud`, `WA_PHONE_NUMBER_ID`, `WA_BUSINESS_ACCOUNT_ID`, `WA_ACCESS_TOKEN`,
     `WA_APP_SECRET`, `WA_VERIFY_TOKEN`, `WA_PHONE_NUMBER`
   - `PROVIDER=peach`, `PROVIDER_SANDBOX=true`, the `PEACH_*` values
   - `PUBLIC_API_URL=https://<tunnel>`
2. In Meta's app dashboard, set the webhook URL to `https://<tunnel>/webhooks/whatsapp` with
   the verify token, and subscribe to `messages`.
3. In the Peach dashboard:
   - allowlist `https://<tunnel>`;
   - set the Checkout webhook to `https://<tunnel>/webhooks/provider/peach`.
4. Register the templates above (utility) and wait for approval. Until then, test inside the
   24-hour window by messaging the test number first.
5. Run the API and worker. Then with the phone:
   - create a bill in the PWA and tap the tag (or open its `/t/` link on the phone);
   - send the prefilled message, pick a tip and press Pay now;
   - pay with card `4200000000000091`.

   Expect the slip on WhatsApp and Paid in the PWA within 5 seconds.
6. Refund part of it from the PWA (Money → Refund). Expect the refund notice on the phone and
   the refund in the Peach dashboard.
7. Record the date, phone model, provider and results in this file (below).

For automated live checks, set the `PEACH_SANDBOX_*` or `PAYFAST_SANDBOX_*` variables and run
`pnpm --filter @tappay/providers test` (`test/sandbox.test.ts`).

**Runs:** none yet. This is waiting for sandbox credentials and a test number.

---

## Before going live: check these against the official docs

1. WhatsApp:
   - the Graph version to pin and its retirement date;
   - error codes 131047, 130429 and 131056;
   - template categories for each of our templates;
   - current pricing.
2. PayFast:
   - refund amount units (cents) and the response envelope;
   - the static ITN IP ranges, if PayFast publishes them (we use DNS of its hosts, as its code does);
   - split-payment JSON;
   - current fees.
3. Peach:
   - v1 `status` response shape;
   - whether `notificationUrl` and `cancelUrl` are honoured on v2;
   - the `merchantTransactionId` limit;
   - Payouts API (if `collect_then_payout` is ever wanted);
   - fees.
4. Open the blocked hosts for the build environment, re-run this research against the official
   pages, and update the confidence labels.
