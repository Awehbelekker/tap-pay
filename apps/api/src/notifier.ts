import type { FastifyBaseLogger } from "fastify";
import { cents, formatRands, type PushClient, type PushSubscriptionJson, type WhatsAppClient } from "@tappay/core";
import { appendMerchantEvent, maskMsisdn, type Crypto, type Database, type Kysely } from "@tappay/db";
import { catalogue } from "@tappay/whatsapp";
import type { MoneyAlerts } from "./money.js";

/**
 * Merchant notifications (SPEC 12). Every bill change becomes a live event for the PWA (SSE).
 * Paid and failed payments also alert people: the staff member on the bill and, if the
 * merchant wants it, the managers. Each person is tried by Web Push first; if no push reaches
 * them, by WhatsApp. Every attempt is a `notifications` row with a unique (dedupe_key,
 * channel), so a duplicate or replayed webhook can never alert anyone twice.
 *
 * Only called after the payment is provider-confirmed, never on Pay now.
 */

export interface FlowEvents {
  billChanged(e: { merchantId: string; billId: string; name: string; staffUserId: string | null; createdBy: string | null; payload?: Record<string, unknown> }): Promise<void>;
  paymentSucceeded(e: PaymentAlert): Promise<void>;
  paymentFailed(e: PaymentAlert): Promise<void>;
}

export interface PaymentAlert {
  merchantId: string;
  billId: string | null;
  paymentId: string;
  staffUserId: string | null;
  /** Who created the bill: they see its events too (staff streams are filtered). */
  createdBy: string | null;
  customerId: string;
  description: string;
  base: number;
  tip: number;
  total: number;
  /** Each staff member's credit from the split, for "your share" (SPEC 12). */
  shares: Map<string, number>;
}

export interface NotifierDeps {
  db: Kysely<Database>;
  crypto: Crypto;
  wa: WhatsAppClient;
  push: PushClient;
  log: FastifyBaseLogger;
}

const R = (c: number) => formatRands(cents(c));

export class Notifier implements FlowEvents, MoneyAlerts {
  constructor(private readonly d: NotifierDeps) {}

  async billChanged(e: { merchantId: string; billId: string; name: string; staffUserId: string | null; createdBy: string | null; payload?: Record<string, unknown> }): Promise<void> {
    await appendMerchantEvent(this.d.db, { merchantId: e.merchantId, name: e.name, billId: e.billId, userId: e.staffUserId, payload: { ...e.payload, createdBy: e.createdBy } });
  }

  async paymentSucceeded(e: PaymentAlert): Promise<void> {
    const who = await this.customerLabel(e.customerId);
    await appendMerchantEvent(this.d.db, {
      merchantId: e.merchantId,
      name: "bill.paid",
      billId: e.billId,
      userId: e.staffUserId,
      payload: { paymentId: e.paymentId, baseCents: e.base, tipCents: e.tip, totalCents: e.total, customer: who, createdBy: e.createdBy },
    });
    const merchant = await this.merchantName(e.merchantId);
    const body = (userId: string) => {
      const share = e.shares.get(userId);
      return `Paid ${R(e.base)} (${e.description})${e.tip > 0 ? ` + ${R(e.tip)} tip` : ""}.${share ? ` Your share ${R(share)}.` : ""} Customer ${who}.`;
    };
    await this.alert(e, "paid", {
      push: (userId) => ({ title: `${merchant}: paid ${R(e.total)}`, body: body(userId), billId: e.billId, kind: "paid" }),
      // MESSAGES.md merchant_paid_alert: "{customer_mask} paid R{base} plus R{tip} tip at {merchant}. Total R{total}."
      template: { name: "merchant_paid_alert", params: [who, R(e.base), R(e.tip), merchant, R(e.total)] },
    });
  }

  async paymentFailed(e: PaymentAlert): Promise<void> {
    await appendMerchantEvent(this.d.db, {
      merchantId: e.merchantId,
      name: "bill.failed",
      billId: e.billId,
      userId: e.staffUserId,
      payload: { paymentId: e.paymentId, totalCents: e.total, createdBy: e.createdBy },
    });
    const merchant = await this.merchantName(e.merchantId);
    await this.alert(e, "failed", {
      push: () => ({ title: `${merchant}: payment did not go through`, body: `${R(e.total)} for ${e.description}. Open the app to follow up.`, billId: e.billId, kind: "failed" }),
      // MESSAGES.md merchant_failed_alert: "Payment of R{amount} failed or was abandoned at {merchant}. ..."
      template: { name: "merchant_failed_alert", params: [R(e.total), merchant] },
      // Failures go to the staff member only (SPEC 12); managers see them in the PWA.
      staffOnly: true,
    });
  }

  private async merchantName(id: string): Promise<string> {
    return (await this.d.db.selectFrom("merchants").select("name").where("id", "=", id).executeTakeFirst())?.name ?? "";
  }

  /** "Ann, ending 482": first name only and a masked number (SPEC 13, POPIA). */
  private async customerLabel(customerId: string): Promise<string> {
    const c = await this.d.db.selectFrom("customers").select(["msisdn_enc", "profile_name"]).where("id", "=", customerId).executeTakeFirst();
    if (!c) return "unknown";
    const masked = `ending ${maskMsisdn(this.d.crypto.decrypt(c.msisdn_enc)).slice(3)}`;
    const first = c.profile_name?.trim().split(/\s+/)[0];
    return first ? `${first}, ${masked}` : masked;
  }

  /** Refund: the customer is told; staff whose share reverses and managers are alerted (SPEC 12). */
  async refunded(e: { merchantId: string; refundId: string; paymentId: string; amount: number; staffReversed: Map<string, number>; customerId: string }): Promise<void> {
    const merchant = await this.merchantName(e.merchantId);
    await appendMerchantEvent(this.d.db, { merchantId: e.merchantId, name: "payment.refunded", billId: null, userId: null, payload: { paymentId: e.paymentId, amountCents: e.amount } });
    const c = await this.d.db.selectFrom("customers").select("msisdn_enc").where("id", "=", e.customerId).executeTakeFirst();
    if (c) {
      const msg = catalogue.refundNotice({ merchant, amount: cents(e.amount) });
      try {
        await this.d.wa.sendText(this.d.crypto.decrypt(c.msisdn_enc), msg.kind === "text" ? msg.body : "");
      } catch (err) {
        this.d.log.error({ err: (err as Error).message }, "refund notice failed");
      }
    }
    const users = await this.d.db.selectFrom("users").select(["id", "role", "msisdn_enc", "notify_mute"]).where("merchant_id", "=", e.merchantId).where("active", "=", true).execute();
    for (const u of users) {
      const reversed = e.staffReversed.get(u.id);
      const isManager = u.role === "manager" || u.role === "owner";
      if (!reversed && !isManager) continue;
      if (u.notify_mute && !isManager) continue;
      const dedupe = `refund:${e.refundId}:${u.id}`;
      const body = `${R(e.amount)} refunded.${reversed ? ` Your share reverses by ${R(reversed)}.` : ""}`;
      try {
        const pushed = await this.tryPush(e.merchantId, u.id, dedupe, "refund", { title: `${merchant}: refund`, body, billId: null, kind: "refund" });
        if (pushed === "not_delivered") {
          await this.tryWhatsApp(e.merchantId, u.id, dedupe, "refund", { name: "merchant_refund_alert", params: [R(e.amount), merchant, reversed ? R(reversed) : R(0)] }, this.d.crypto.decrypt(u.msisdn_enc));
        }
      } catch (err) {
        this.d.log.error({ err: (err as Error).message }, "refund alert failed");
      }
    }
  }

  /** Payout: "R{amount} in tips is on its way to you from {merchant}" (MESSAGES staff_tip_payout). */
  async payoutSent(e: { merchantId: string; payoutId: string; userId: string; amount: number }): Promise<void> {
    const merchant = await this.merchantName(e.merchantId);
    const u = await this.d.db.selectFrom("users").select("msisdn_enc").where("id", "=", e.userId).executeTakeFirst();
    if (!u) return;
    const dedupe = `payout:${e.payoutId}:${e.userId}`;
    const pushed = await this.tryPush(e.merchantId, e.userId, dedupe, "payout", { title: `${merchant}: paid out ${R(e.amount)}`, body: `${R(e.amount)} is on its way to you.`, billId: null, kind: "payout" });
    if (pushed === "not_delivered") {
      await this.tryWhatsApp(e.merchantId, e.userId, dedupe, "payout", { name: "staff_tip_payout", params: [R(e.amount), merchant] }, this.d.crypto.decrypt(u.msisdn_enc));
    }
  }

  private async recipients(e: PaymentAlert, staffOnly: boolean) {
    const { db } = this.d;
    const m = await db.selectFrom("merchants").select("notify_managers").where("id", "=", e.merchantId).executeTakeFirstOrThrow();
    const users = await db
      .selectFrom("users")
      .select(["id", "role", "msisdn_enc", "notify_mute"])
      .where("merchant_id", "=", e.merchantId)
      .where("active", "=", true)
      .execute();
    return users.filter((u) => {
      if (u.id === e.staffUserId) return !u.notify_mute;
      if (staffOnly) return false;
      return (u.role === "manager" || u.role === "owner") && m.notify_managers === "each_payment";
    });
  }

  private async alert(
    e: PaymentAlert,
    kind: "paid" | "failed",
    msg: { push: (userId: string) => Record<string, unknown>; template: { name: string; params: string[] }; staffOnly?: boolean },
  ): Promise<void> {
    for (const u of await this.recipients(e, msg.staffOnly ?? false)) {
      const dedupe = `${kind}:${e.paymentId}:${u.id}`;
      try {
        const pushed = await this.tryPush(e.merchantId, u.id, dedupe, kind, msg.push(u.id));
        if (pushed !== "not_delivered") continue; // delivered now, or handled before
        await this.tryWhatsApp(e.merchantId, u.id, dedupe, kind, msg.template, this.d.crypto.decrypt(u.msisdn_enc));
      } catch (err) {
        this.d.log.error({ err: (err as Error).message, kind }, "notification failed");
      }
    }
  }

  /** Claim the (dedupe_key, channel) slot; false if someone already did. */
  private async claim(merchantId: string, userId: string, dedupe: string, event: string, channel: "push" | "whatsapp", payload: Record<string, unknown>) {
    const r = await this.d.db
      .insertInto("notifications")
      .values({ merchant_id: merchantId, user_id: userId, event, channel, dedupe_key: dedupe, payload: JSON.stringify(payload), attempted_at: new Date(), error: null })
      .onConflict((oc) => oc.columns(["dedupe_key", "channel"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    return r?.id ?? null;
  }

  private async finish(id: string, status: "sent" | "failed" | "skipped", error: string | null = null) {
    await this.d.db.updateTable("notifications").set({ status, error, attempts: 1 }).where("id", "=", id).execute();
  }

  private async tryPush(merchantId: string, userId: string, dedupe: string, event: string, payload: Record<string, unknown>): Promise<"sent" | "duplicate" | "not_delivered"> {
    const { db, push } = this.d;
    const id = await this.claim(merchantId, userId, dedupe, event, "push", payload);
    if (!id) return "duplicate";
    const devices = await db
      .selectFrom("devices")
      .select(["id", "push_subscription"])
      .where("user_id", "=", userId)
      .where("revoked_at", "is", null)
      .where("push_subscription", "is not", null)
      .execute();
    if (devices.length === 0) {
      await this.finish(id, "skipped", "no_subscription");
      return "not_delivered";
    }
    let delivered = false;
    for (const dev of devices) {
      const r = await push.send(dev.push_subscription as PushSubscriptionJson, payload);
      if (r.ok) delivered = true;
      if (r.gone) await db.updateTable("devices").set({ push_subscription: null }).where("id", "=", dev.id).execute();
    }
    await this.finish(id, delivered ? "sent" : "failed", delivered ? null : "push_failed");
    return delivered ? "sent" : "not_delivered";
  }

  private async tryWhatsApp(merchantId: string, userId: string, dedupe: string, event: string, t: { name: string; params: string[] }, msisdn: string) {
    const id = await this.claim(merchantId, userId, dedupe, event, "whatsapp", { template: t.name });
    if (!id) return;
    try {
      // Staff are outside the 24-hour window, so this is always an approved template (SPEC 12).
      await this.d.wa.sendTemplate(msisdn.replace(/\D/g, "").replace(/^0/, "27"), t.name, "en", t.params);
      await this.finish(id, "sent");
    } catch (e) {
      // Last channel that exists today (SMS is optional and not built); the PWA shows the miss.
      await this.finish(id, "failed", (e as Error).name);
    }
  }
}
