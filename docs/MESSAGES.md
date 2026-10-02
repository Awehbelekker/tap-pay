# WhatsApp message catalogue

Conventions: plain text, no emoji, amounts as `R1 234,50` (space thousands, comma decimals). Variables in `{braces}`. Product name from `PRODUCT_NAME`. Keep every message in a typed catalogue (`packages/whatsapp/catalogue.ts`) keyed by the IDs below, with English first and a structure ready for Afrikaans (`af`) and isiXhosa (`xh`).

Meta limits to verify in M8 against current docs (design to these conservative values): reply buttons max 3, button title max 20 chars, list rows max 10, row title 24 chars, body 1024 chars. Free-form messages only inside the 24-hour customer-service window; outside it use approved templates.

## Customer session messages

| ID | Trigger | Text | Buttons |
| --- | --- | --- | --- |
| `claim.ok.fixed` | Tap, fixed bill | "{merchant}\n{lines}\nTotal R{base}\n\nAdd a tip for {staff}?" | Tip 10% / Tip 15% / Other |
| `claim.ok.open` | Tap, open amount | "{merchant}. How much would you like to pay?" | (free text number) |
| `claim.ok.quicktip` | Tap, quick tip | "Tip {staff} at {merchant}. How much?" | List: merchant presets (default R5, R10, R20) and Other amount |
| `tip.custom.ask` | Other tapped | "Type the tip in rand, for example 25, or as a percentage, for example 12%." | none |
| `tip.custom.invalid` | Bad input | "Please send an amount between R1,00 and {max}, or a percentage up to 100%, or tap No tip." | No tip |
| `confirm` | After tip | "Pay R{total}?\nBill R{base}\nTip R{tip}\nTo {merchant}" | Pay now / Change tip / Cancel |
| `pay.link` | Pay now | "Tap to pay securely with Apple Pay, Google Pay or your bank: {url}\nThe link works for {minutes} minutes." | (link) |
| `pay.success` | Webhook ok | "Paid. Thank you. Your slip is below." + slip image + receipt link | none |
| `pay.failed` | Webhook failed | "That payment did not go through. No money was taken." | Try again / Cancel |
| `pay.pending.long` | Pending > 5 min | "We are still waiting for your bank. If money left your account it will show here shortly." | Check status |
| `session.expired` | TTL | "This payment link expired. Tap the tag again to start over." | none |
| `bill.claimed.other` | Bill already claimed by another | "This bill is already being paid. Ask {merchant} for help." | none |
| `bill.none` | No open bill | "{merchant} has no bill ready yet. Ask them to create one, then tap again." | Try again |
| `bill.code.ask` | Many open bills | "Enter the code shown on your bill." | none |
| `bill.code.bad` | Wrong code | "That code does not match. {left} tries left." | none |
| `bill.code.locked` | 3 failures | "Too many tries. Please ask {merchant} for help." | none |
| `bill.paid.already` | Duplicate tap | "This bill is already paid. Here is your slip again." | none |
| `share.choose` | Split bill | "Which share are you paying?" | list of shares |
| `privacy.consent` | After first payment | "Share your number with {merchant} so they can contact you about this bill?" | Share / No thanks |
| `help` | HELP | "To pay, tap the merchant's tag and send the message that opens. Reply INVOICE for a tax invoice for your last payment. Reply STOP to stop reminders." | none |
| `invoice.ask` | INVOICE, VAT-registered merchant | "Tax invoice for your payment of R{total} to {merchant} on {date}. Reply with your company name and VAT number, for example: Acme (Pty) Ltd, 4123456789. Add your address after another comma if you want it on the invoice." | none |
| `invoice.ask_again` | Details not understood | "I need a company name and a 10-digit VAT number starting with 4, for example: Acme (Pty) Ltd, 4123456789" | none |
| `invoice.need_address` | Over R5 000, no address | "Over R5 000 the invoice must show your address too. Reply with name, VAT number and address, ..." | none |
| `invoice.ready` | Issued (or asked again) | Document "Tax invoice {number}.pdf", caption "Tax invoice {number} from {merchant}." + link | none |
| `invoice.none` | No payment in 30 days | "I can make a tax invoice for a payment from this number in the last 30 days, and I could not find one." | none |
| `invoice.not_vat` | Merchant not registered | "{merchant} is not registered for VAT, so they cannot issue a tax invoice. Your slip is your receipt." | none |
| `invoice.tip_only` | Last payment was a quick tip | "That payment was a tip, which has no VAT, so there is no tax invoice for it." | none |
| `invoice.unavailable` | Registered but no address on file | "{merchant} has not finished setting up tax invoices. Please ask them directly." | none |
| `stop.ok` | STOP | "Done. You will not get reminders from us." | none |
| `fallback` | Unknown | "I did not understand. Tap the tag again or choose an option." | Menu |
| `refund.notice` | Refund | "R{amount} was refunded by {merchant}. It can take a few days to show." | none |

## Reminder templates (outside the 24 hour window)

| Template | Body | Sent |
| --- | --- | --- |
| `reminder_1` | "Hi, your bill of R{amount} at {merchant} is still open. Pay in seconds: {url}" | 10 minutes after claim or tap |
| `reminder_2` | "Reminder: R{amount} is waiting at {merchant}. Pay here: {url}. Reply STOP to opt out." | Next day 09:00 SAST |
| `reminder_3` | "Last reminder for R{amount} at {merchant}: {url}. Reply STOP to opt out." | +3 days 09:00 SAST |

Rules: max 3, max 1 per day, 08:00 to 20:00 SAST only, cancelled the moment the bill is paid, cancelled, expired or the customer opts out. Inside the 24 hour window reminders may be plain session messages with buttons.

## Merchant templates

Money parameters are sent already formatted ("R1 234,50"), so the template bodies carry no "R".

| Template | Body |
| --- | --- |
| `merchant_paid_alert` | "{customer_mask} paid {base} plus {tip} tip at {merchant}. Total {total}." |
| `merchant_failed_alert` | "Payment of {amount} failed or was abandoned at {merchant}. Open the app to follow up." |
| `merchant_refund_alert` | "{amount} was refunded at {merchant}. Your share goes down by {share}." |
| `merchant_daily_summary` | "{merchant}, {day}: {count} payments, {total} (tips {tips}). Refunds {refunds}. Staff owed {owed}." |
| `staff_tip_payout` | "{amount} in tips is on its way to you from {merchant}." |
| `otp` | "{code} is your {product} sign-in code. It expires in 10 minutes." |

## Slip (PNG) fields

Merchant logo and name, date and time (SAST), reference, line items, base, tip, total, payment method, receipt number, VAT lines if registered (see SPEC §14), staff name if tipped, footer "Powered by {product}". Animation of the printing effect is a web receipt page feature (`/r/:token`), not part of the PNG.
