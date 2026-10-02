import type { Kysely } from "@tappay/db";
import type { FastifyBaseLogger } from "fastify";
import {
  canBill,
  canSession,
  cents,
  hashToken,
  newClaimToken,
  newUrlToken,
  nextSession,
  parsePayCommand,
  parseRands,
  percentTip,
  postingsForPayment,
  type Cents,
  type Clock,
  type PaymentProvider,
  type SessionState,
  type VerifiedEvent,
  type WhatsAppClient,
} from "@tappay/core";
import type { Config } from "@tappay/config";
import {
  audit,
  consumeClaimToken,
  createReceipt,
  createSession,
  customerMsisdn,
  findTagForTap,
  getBill,
  insertClaimToken,
  insertPendingPayment,
  insertPostings,
  latestActiveSession,
  liveBillsOnTag,
  lockPaymentByProviderRef,
  logMessage,
  optOutGlobally,
  pendingPaymentForSession,
  receiptByPayment,
  settlePayment,
  transitionBill,
  transitionSession,
  upsertCustomer,
  type BillLine,
  type Crypto,
  type Database,
} from "@tappay/db";
import { isValidTagCode, waMeLink } from "@tappay/tag";
import { catalogue, IDS, parseTipId, type InboundMessage, type OutMessage } from "@tappay/whatsapp";

/**
 * The customer pay flow (SPEC 4): tap -> claim -> tip -> confirm -> hosted checkout -> provider
 * webhook -> paid -> slip. M1 scope: fixed bills on a tag, number-match and first-tap claim.
 * Bill codes, shares, open amounts and quick tips are M2/M3.
 *
 * Every handler is safe to run twice: state changes are compare-and-set through the state
 * machines, inbound events are de-duplicated by the caller, and checkout creation is keyed by
 * session id + version.
 */

export interface FlowDeps {
  config: Config;
  db: Kysely<Database>;
  crypto: Crypto;
  wa: WhatsAppClient;
  provider: PaymentProvider;
  clock: Clock;
  log: FastifyBaseLogger;
}

const HOUR = 3_600_000;
const MIN_CUSTOM_TIP = 100;

function describeLines(lines: BillLine[] | null | undefined): string {
  const names = (lines ?? []).map((l) => l.description).filter(Boolean);
  return names.length ? names.join(", ") : "Bill";
}

type ActiveSession = NonNullable<Awaited<ReturnType<typeof latestActiveSession>>>;

export class PayFlow {
  constructor(private readonly d: FlowDeps) {}

  private now(): Date {
    return this.d.clock.now();
  }

  // ── Tap ────────────────────────────────────────────────────────────────────

  /** Returns where to send the phone, or null for the generic "take payment another way" page. */
  async tapRedirect(code: string): Promise<string | null> {
    const { config, db } = this.d;
    if (!isValidTagCode(code)) return null;
    const tag = await findTagForTap(db, { code });
    if (!tag || tag.tagStatus !== "active" || tag.merchantStatus !== "active") return null;

    if (tag.kind === "static") {
      if (config.NODE_ENV === "production" && !config.ALLOW_STATIC_TAGS) return null;
    } else {
      // NTAG424 SDM verification lands in M9; refuse rather than accept an unverified tap.
      await audit(db, { merchantId: tag.merchantId, actorKind: "system", actorId: null, action: "tap.unverified", entity: "tag", entityId: tag.tagId });
      return null;
    }

    const expiresAt = new Date(this.now().getTime() + config.CLAIM_TOKEN_TTL_SECONDS * 1000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = newClaimToken();
      try {
        await insertClaimToken(db, { hash: hashToken(token, config.HASH_PEPPER), tagId: tag.tagId, merchantId: tag.merchantId, expiresAt });
      } catch {
        continue; // hash collision with a live token: draw again
      }
      return config.WA_MODE === "sim"
        ? `${config.WA_SIM_URL}/?text=${encodeURIComponent(`PAY ${token}`)}`
        : waMeLink(config.WA_PHONE_NUMBER, token);
    }
    return null;
  }

  // ── Inbound WhatsApp ───────────────────────────────────────────────────────

  async handleInbound(m: InboundMessage): Promise<void> {
    const { db, crypto } = this.d;
    const customerId = await upsertCustomer(db, crypto, m.from, m.profileName);
    await logMessage(db, { customerId, merchantId: null, direction: "in", waMessageId: m.messageId, kind: m.kind });
    const reply = (msg: OutMessage, merchantId: string | null = null) => this.send(m.from, customerId, merchantId, msg);

    if (m.kind === "text") {
      const token = parsePayCommand(m.text);
      if (token) return this.onPay(m.from, customerId, token);
      const word = m.text.trim().toUpperCase();
      if (word === "HELP") return reply(catalogue.help());
      if (word === "STOP" || word === "STOP ALL") {
        await optOutGlobally(db, customerId, this.now());
        await audit(db, { merchantId: null, actorKind: "customer", actorId: customerId, action: "customer.opt_out", entity: "customer", entityId: customerId });
        return reply(catalogue.stopOk());
      }
    }

    const s = await this.liveSession(m.from, customerId);
    if (s === "expired") return; // the expiry notice was the reply
    if (!s) return reply(catalogue.fallback());

    if (m.kind === "text" && s.status === "awaiting_tip") return this.onCustomTip(m.from, customerId, s, m.text);
    if (m.kind === "reply") return this.onReply(m.from, customerId, s, m.replyId);
    return this.resendPrompt(m.from, customerId, s);
  }

  /**
   * The customer's in-progress session. If its time ran out, expire it, release the bill, tell
   * the customer, and return "expired".
   */
  private async liveSession(to: string, customerId: string): Promise<ActiveSession | "expired" | null> {
    const { db } = this.d;
    const s = await latestActiveSession(db, customerId);
    if (!s) return null;
    if (s.expiresAt.getTime() > this.now().getTime()) return s;
    if (canSession(s.status, "expire")) await transitionSession(db, s.id, s.status, "expire");
    await this.releaseBillIfMine(s.merchantId, s.billId, customerId);
    await this.send(to, customerId, s.merchantId, catalogue.sessionExpired());
    return "expired";
  }

  private async releaseBillIfMine(merchantId: string, billId: string | null, customerId: string): Promise<void> {
    if (!billId) return;
    const bill = await getBill(this.d.db, merchantId, billId);
    if (bill?.status === "claimed" && bill.customer_id === customerId) {
      await transitionBill(this.d.db, billId, "claimed", "release", { customer_id: null, claimed_at: null });
    }
  }

  private async onPay(to: string, customerId: string, token: string): Promise<void> {
    const { db, config, crypto } = this.d;
    const now = this.now();
    const claim = await consumeClaimToken(db, hashToken(token, config.HASH_PEPPER), now);
    if (!claim?.tagId) return this.send(to, customerId, null, catalogue.tokenInvalid());
    const tag = await findTagForTap(db, { id: claim.tagId });
    if (!tag || tag.tagStatus !== "active" || tag.merchantStatus !== "active") {
      return this.send(to, customerId, null, catalogue.tagNotVerified());
    }
    const merchant = tag.merchantName;
    const myHash = crypto.lookupHash(to);
    const bills = await liveBillsOnTag(db, tag.merchantId, tag.tagId, now);

    // Customer taps twice: carry on with the bill they already hold.
    const mine = bills.find((b) => b.status === "claimed" && b.customer_id === customerId);
    if (mine) {
      const s = await latestActiveSession(db, customerId);
      if (s && s.billId === mine.id && s.status !== "failed") {
        if (s.expiresAt.getTime() > now.getTime()) return this.resendPrompt(to, customerId, s);
        // A fresh tap restarts the step quietly; the customer keeps the bill they hold.
        if (canSession(s.status, "expire")) await transitionSession(db, s.id, s.status, "expire");
      }
      return this.startSession(to, customerId, tag, mine);
    }

    // SPEC 5: a bill addressed to this number first, then the tag's one claimable bill.
    const target =
      bills.find((b) => b.status === "open" && b.intended_msisdn_hash?.equals(myHash)) ??
      bills.find((b) => b.status === "open" && b.intended_msisdn_hash === null);
    if (target) {
      const won = await transitionBill(db, target.id, "open", "claim", { customer_id: customerId, claimed_at: now });
      if (!won) return this.send(to, customerId, tag.merchantId, catalogue.billClaimedOther({ merchant }));
      await audit(db, { merchantId: tag.merchantId, actorKind: "customer", actorId: customerId, action: "bill.claimed", entity: "bill", entityId: target.id });
      return this.startSession(to, customerId, tag, target);
    }

    if (bills.some((b) => b.status === "claimed")) {
      return this.send(to, customerId, tag.merchantId, catalogue.billClaimedOther({ merchant }));
    }
    // Bills addressed to other numbers need the 4-digit bill code: M2.
    return this.send(to, customerId, tag.merchantId, catalogue.billNone({ merchant }));
  }

  private async startSession(
    to: string,
    customerId: string,
    tag: { merchantId: string; tipsEnabled: boolean },
    bill: { id: string; subtotal_cents: number },
  ): Promise<void> {
    const now = this.now();
    const status = nextSession("claimed", tag.tipsEnabled ? "ask_tip" : "skip_tip");
    await createSession(this.d.db, {
      merchantId: tag.merchantId,
      billId: bill.id,
      customerId,
      status,
      base: bill.subtotal_cents,
      tip: 0,
      expiresAt: new Date(now.getTime() + this.d.config.SESSION_TTL_MINUTES * 60_000),
      waWindowExpiresAt: new Date(now.getTime() + 24 * HOUR),
    });
    const s = await latestActiveSession(this.d.db, customerId);
    if (s) await this.resendPrompt(to, customerId, s);
  }

  /** Send whatever the session is currently waiting for. */
  private async resendPrompt(to: string, customerId: string, s: ActiveSession): Promise<void> {
    const base = cents(s.base ?? 0);
    const description = describeLines(s.lines);
    const merchant = s.merchantName;
    switch (s.status) {
      case "awaiting_tip":
        return this.send(to, customerId, s.merchantId, catalogue.claimFixed({ merchant, description, base, staff: s.staffName, tipPercents: s.tipPresets }));
      case "awaiting_confirm":
        return this.send(to, customerId, s.merchantId, catalogue.confirm({ merchant, description, base, tip: cents(s.tip) }));
      case "awaiting_payment": {
        const p = await pendingPaymentForSession(this.d.db, s.id);
        const url = (p?.raw as { checkoutUrl?: string } | null)?.checkoutUrl;
        return this.send(to, customerId, s.merchantId, url ? catalogue.paymentPending({ merchant, url }) : catalogue.fallback());
      }
      case "failed":
        return this.send(to, customerId, s.merchantId, catalogue.payFailed({ merchant }));
      default:
        return this.send(to, customerId, s.merchantId, catalogue.fallback());
    }
  }

  private async onCustomTip(to: string, customerId: string, s: ActiveSession, text: string): Promise<void> {
    const base = cents(s.base ?? 0);
    const tip = parseRands(text);
    if (tip === null || tip < MIN_CUSTOM_TIP || tip > base) {
      return this.send(to, customerId, s.merchantId, catalogue.tipCustomInvalid({ max: base }));
    }
    return this.chooseTip(to, customerId, s, tip);
  }

  private async chooseTip(to: string, customerId: string, s: ActiveSession, tip: Cents): Promise<void> {
    const ok = await transitionSession(this.d.db, s.id, "awaiting_tip", "choose_tip", { tip_cents: tip });
    if (!ok) return; // a concurrent reply already moved this session on
    const merchant = s.merchantName;
    return this.send(to, customerId, s.merchantId, catalogue.confirm({ merchant, description: describeLines(s.lines), base: cents(s.base ?? 0), tip }));
  }

  private async onReply(to: string, customerId: string, s: ActiveSession, id: string): Promise<void> {
    const { db } = this.d;
    const merchant = s.merchantName;

    const tipChoice = parseTipId(id);
    if (tipChoice && s.status === "awaiting_tip") {
      if (tipChoice.kind === "custom") return this.send(to, customerId, s.merchantId, catalogue.tipCustomAsk());
      // Only offer what the merchant configured: a forged id cannot set an arbitrary percent.
      if (tipChoice.kind === "percent" && !s.tipPresets.includes(tipChoice.bp / 100)) return this.resendPrompt(to, customerId, s);
      const tip = tipChoice.kind === "none" ? cents(0) : percentTip(cents(s.base ?? 0), tipChoice.bp);
      return this.chooseTip(to, customerId, s, tip);
    }

    if (id === IDS.changeTip && s.status === "awaiting_confirm") {
      if (await transitionSession(db, s.id, "awaiting_confirm", "change_tip", { tip_cents: 0 })) {
        return this.resendPrompt(to, customerId, { ...s, status: "awaiting_tip", tip: 0 });
      }
      return;
    }

    if (id === IDS.payNow && s.status === "awaiting_confirm") return this.onPayNow(to, customerId, s);

    if (id === IDS.cancel && canSession(s.status, "cancel")) {
      if (await transitionSession(db, s.id, s.status, "cancel")) {
        await this.releaseBillIfMine(s.merchantId, s.billId, customerId);
        return this.send(to, customerId, s.merchantId, catalogue.cancelled({ merchant }));
      }
      return;
    }
    if (id === IDS.cancel && s.status === "failed") {
      await this.releaseBillIfMine(s.merchantId, s.billId, customerId);
      return this.send(to, customerId, s.merchantId, catalogue.cancelled({ merchant }));
    }

    if (id === IDS.tryAgain && s.status === "failed" && s.billId) {
      // SPEC 6.2: a retry is a new session on the same bill with a new reference.
      const now = this.now();
      const status: SessionState = nextSession(nextSession("claimed", "ask_tip"), "choose_tip");
      await createSession(db, {
        merchantId: s.merchantId,
        billId: s.billId,
        customerId,
        status,
        base: s.base ?? 0,
        tip: s.tip,
        expiresAt: new Date(now.getTime() + this.d.config.SESSION_TTL_MINUTES * 60_000),
        waWindowExpiresAt: new Date(now.getTime() + 24 * HOUR),
      });
      const fresh = await latestActiveSession(db, customerId);
      if (fresh) return this.resendPrompt(to, customerId, fresh);
      return;
    }

    // A stale or unexpected button: repeat the current step instead of guessing.
    return this.resendPrompt(to, customerId, s);
  }

  private async onPayNow(to: string, customerId: string, s: ActiveSession): Promise<void> {
    const { db, provider, config } = this.d;
    const bill = s.billId ? await getBill(db, s.merchantId, s.billId) : undefined;
    // The bill must still be held by this customer at the amount they confirmed (SPEC 5).
    if (!bill || bill.status !== "claimed" || bill.customer_id !== customerId || bill.subtotal_cents !== s.base) {
      await transitionSession(db, s.id, "awaiting_confirm", "cancel");
      return this.send(to, customerId, s.merchantId, catalogue.sessionExpired());
    }
    const total = cents((s.base ?? 0) + s.tip);
    if (total <= 0) return this.send(to, customerId, s.merchantId, catalogue.fallback());

    const checkout = await provider.createCheckout({
      reference: s.id,
      amount: total,
      description: `${s.merchantName}: ${describeLines(s.lines)}`.slice(0, 120),
      returnUrl: `${config.PUBLIC_API_URL}/pay/return`,
      webhookUrl: `${config.PUBLIC_API_URL}/webhooks/provider/${provider.name}`,
      idempotencyKey: `${s.id}:v${s.version}`,
    });

    const moved = await db.transaction().execute(async (trx) => {
      const expiresAt = new Date(Math.max(s.expiresAt.getTime(), checkout.expiresAt.getTime()));
      if (!(await transitionSession(trx, s.id, "awaiting_confirm", "pay_now", { expires_at: expiresAt }))) return false;
      await insertPendingPayment(trx, {
        merchantId: s.merchantId,
        sessionId: s.id,
        provider: provider.name,
        providerRef: checkout.providerRef,
        idempotencyKey: `${s.id}:v${s.version}`,
        amount: total,
        checkoutUrl: checkout.url,
        checkoutExpiresAt: checkout.expiresAt,
      });
      return true;
    });
    if (!moved) return; // a duplicate Pay now: the first one sends the link

    const minutes = Math.max(1, Math.round((checkout.expiresAt.getTime() - this.now().getTime()) / 60_000));
    return this.send(to, customerId, s.merchantId, catalogue.payLink({ merchant: s.merchantName, total, url: checkout.url, minutes }));
  }

  // ── Provider events ────────────────────────────────────────────────────────

  /**
   * Apply a verified provider event (SPEC backend step 8). The caller has already verified the
   * signature and de-duplicated by event id; this is additionally idempotent on the payment row.
   * Returns a short outcome code for the webhook_events row (never PII).
   */
  async handleProviderEvent(ev: VerifiedEvent): Promise<{ status: "processed" | "ignored" | "failed"; error?: string }> {
    const { db, provider, config } = this.d;
    const now = this.now();

    const result = await db.transaction().execute(async (trx) => {
      const p = await lockPaymentByProviderRef(trx, provider.name, ev.providerRef);
      if (!p) return { kind: "error" as const, error: "unknown_payment" };
      if (ev.reference !== p.sessionId || ev.currency !== "ZAR") {
        await audit(trx, { merchantId: p.merchantId, actorKind: "system", actorId: null, action: "payment.reference_mismatch", entity: "payment", entityId: p.id });
        return { kind: "error" as const, error: "reference_mismatch" };
      }

      if (ev.type === "payment.succeeded") {
        if (p.status === "succeeded") return { kind: "duplicate" as const };
        // Never mark paid on a different amount (SPEC edge case "amount mismatch").
        if (ev.amount !== p.amount) {
          await audit(trx, {
            merchantId: p.merchantId,
            actorKind: "system",
            actorId: null,
            action: "payment.amount_mismatch",
            entity: "payment",
            entityId: p.id,
            detail: { expected: p.amount, received: ev.amount },
          });
          return { kind: "error" as const, error: "amount_mismatch" };
        }
        if (!(await settlePayment(trx, p.id, { status: "succeeded", method: ev.method ?? null, fee: ev.feeCents ?? null }))) {
          return { kind: "duplicate" as const };
        }
        if (canSession(p.sessionStatus, "payment_succeeded")) {
          await transitionSession(trx, p.sessionId, p.sessionStatus, "payment_succeeded");
        }
        const bill = p.billId ? await getBill(trx, p.merchantId, p.billId) : undefined;
        if (bill && canBill(bill.status, "pay")) {
          await transitionBill(trx, bill.id, bill.status, "pay", { paid_at: now, customer_id: p.customerId });
        } else {
          // Money was taken but the bill was already settled or closed: customer paid twice.
          // Refund handling is M5; flag it loudly now.
          await audit(trx, { merchantId: p.merchantId, actorKind: "system", actorId: null, action: "payment.needs_refund", entity: "payment", entityId: p.id, detail: { billStatus: bill?.status ?? null } });
        }
        const base = cents(p.base ?? 0);
        const tip = cents(p.tip);
        await insertPostings(trx, p.merchantId, p.id, postingsForPayment({ base, tip, fee: cents(ev.feeCents ?? 0), tipStaffUserId: bill?.assigned_user_id ?? null }));
        const token = newUrlToken();
        const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(now).replaceAll("-", "");
        await createReceipt(trx, { merchantId: p.merchantId, paymentId: p.id, token, number: `R-${day}-${p.id.slice(0, 6).toUpperCase()}` });
        await audit(trx, { merchantId: p.merchantId, actorKind: "system", actorId: null, action: "payment.succeeded", entity: "payment", entityId: p.id });
        return { kind: "paid" as const, paymentId: p.id, merchantId: p.merchantId, customerId: p.customerId, total: cents(p.amount), receiptToken: token };
      }

      // Failure or cancellation of the checkout.
      if (!(await settlePayment(trx, p.id, { status: ev.type === "payment.cancelled" ? "cancelled" : "failed", method: null, fee: null }))) {
        return { kind: "duplicate" as const };
      }
      if (p.sessionStatus === "awaiting_payment") await transitionSession(trx, p.sessionId, "awaiting_payment", "payment_failed");
      await audit(trx, { merchantId: p.merchantId, actorKind: "system", actorId: null, action: "payment.failed", entity: "payment", entityId: p.id });
      return { kind: "failed" as const, merchantId: p.merchantId, customerId: p.customerId };
    });

    if (result.kind === "error") {
      this.d.log.warn({ provider: provider.name, error: result.error }, "provider event not applied");
      return { status: "failed", error: result.error };
    }
    if (result.kind === "duplicate") return { status: "ignored" };

    // After commit: tell the customer. A send failure never undoes the payment.
    const to = await customerMsisdn(db, this.d.crypto, result.customerId);
    const merchant = (await db.selectFrom("merchants").select("name").where("id", "=", result.merchantId).executeTakeFirst())?.name ?? "";
    if (to) {
      if (result.kind === "paid") {
        const receiptUrl = `${config.PUBLIC_API_URL}/r/${result.receiptToken}`;
        await this.send(to, result.customerId, result.merchantId, catalogue.paySuccess({ merchant, total: result.total, receiptUrl, slipUrl: `${receiptUrl}/slip.png` }));
      } else {
        await this.send(to, result.customerId, result.merchantId, catalogue.payFailed({ merchant }));
      }
    }
    return { status: "processed" };
  }

  /** Look up the receipt for a payment (used to resend a slip). */
  async receiptFor(paymentId: string) {
    return receiptByPayment(this.d.db, paymentId);
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  private async send(to: string, customerId: string | null, merchantId: string | null, msg: OutMessage): Promise<void> {
    const { wa, db, log } = this.d;
    try {
      const r =
        msg.kind === "text"
          ? await wa.sendText(to, msg.body)
          : msg.kind === "buttons"
            ? await wa.sendButtons(to, msg.body, msg.buttons)
            : msg.kind === "list"
              ? await wa.sendList(to, msg.body, msg.buttonLabel, msg.rows)
              : await wa.sendImage(to, msg.imageUrl, msg.caption);
      await logMessage(db, { customerId, merchantId, direction: "out", waMessageId: r.messageId, kind: msg.kind });
    } catch (e) {
      // notify.retry picks these up once notifications land (M4). Never log the number.
      log.error({ err: (e as Error).message, kind: msg.kind }, "whatsapp send failed");
      await logMessage(db, { customerId, merchantId, direction: "out", waMessageId: null, kind: `${msg.kind}:failed` });
    }
  }
}
