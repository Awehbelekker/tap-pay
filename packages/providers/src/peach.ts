import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  call,
  callJson,
  cents,
  HttpError,
  WebhookIgnoredError,
  WebhookSignatureError,
  type CheckoutResult,
  type Clock,
  type CreateCheckoutInput,
  type HttpFetch,
  type PaymentProvider,
  type PaymentStatus,
  type RefundResult,
  type VerifiedEvent,
} from "@tappay/core";

/**
 * Peach Payments adapter, hosted Checkout v2 (docs/PROVIDER_NOTES.md "Peach Payments"). Built
 * from Peach's official Magento module (with its live sandbox contract tests) and Checkout PHP
 * SDK on gitlab.com/p2886; developer.peachpayments.com was unreachable from the build
 * environment.
 *
 *   token:    POST {dashboard}/api/oauth/token {clientId, clientSecret, merchantId}, cached
 *   checkout: POST {secure}/v2/checkout, Bearer token + allowlisted Referer, flat dotted keys,
 *             amount "550.00", unique nonce; answer {checkoutId, redirectUrl}
 *   webhook:  form-encoded, `signature` = HMAC-SHA256(secret token) over the other fields
 *             sorted by key, concatenated key+value with no separators
 *   refund:   POST {api}/v1/checkout/refund, form-encoded and signed the same way, against
 *             the payment id from the webhook (not the checkoutId); HTTP 200 even when declined
 */

export interface PeachConfig {
  entityId: string;
  clientId: string;
  clientSecret: string;
  merchantId: string;
  /** The Dashboard "secret token": signs webhooks and v1 requests. */
  secretToken: string;
  sandbox: boolean;
  /** Our site, as allowlisted with Peach (sent as Referer). */
  allowlistedUrl: string;
  clock: Clock;
  checkoutTtlMinutes?: number;
  fetch?: HttpFetch;
}

/** Peach's signature (official SDK Signature::generate), keys used exactly as sent. */
export function peachSignature(fields: Record<string, string>, secret: string): string {
  const keys = Object.keys(fields)
    .filter((k) => k !== "signature")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHmac("sha256", secret)
    .update(keys.map((k) => `${k}${fields[k] ?? ""}`).join(""))
    .digest("hex");
}

/** Official success pattern (PROVIDER_NOTES Peach result codes). */
const SUCCESS = /^(000\.000\.|000\.100\.1|000\.[36])/;
const PENDING = /^000\.200/;
const CANCELLED = new Set(["100.396.101", "100.396.104"]);
const rand = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

export class PeachProvider implements PaymentProvider {
  readonly name = "peach";
  readonly capabilities = {
    nativeSplit: false,
    // Peach has a Payouts product; its API was not confirmed (PROVIDER_NOTES), so not used yet.
    payouts: false,
    tokenization: false,
    methods: ["card" as const, "apple_pay" as const, "google_pay" as const, "pay_by_bank" as const],
  };
  private readonly hosts: { secure: string; dashboard: string; api: string };
  private readonly fetchFn: HttpFetch;
  private token: { value: string; until: number } | null = null;
  private readonly byKey = new Map<string, CheckoutResult>();
  private readonly known = new Map<string, { status: PaymentStatus; paymentId: string | null }>();
  private readonly refunds = new Map<string, RefundResult>();

  constructor(private readonly c: PeachConfig) {
    this.hosts = c.sandbox
      ? { secure: "https://testsecure.peachpayments.com", dashboard: "https://sandbox-dashboard.peachpayments.com", api: "https://testapi.peachpayments.com" }
      : { secure: "https://secure.peachpayments.com", dashboard: "https://dashboard.peachpayments.com", api: "https://api.peachpayments.com" };
    this.fetchFn = c.fetch ?? (globalThis.fetch as unknown as HttpFetch);
  }

  private async accessToken(): Promise<string> {
    const now = this.c.clock.now().getTime();
    if (this.token && this.token.until > now) return this.token.value;
    const r = await callJson<{ access_token: string; expires_in: number }>(this.fetchFn, `${this.hosts.dashboard}/api/oauth/token`, {
      method: "POST",
      json: { clientId: this.c.clientId, clientSecret: this.c.clientSecret, merchantId: this.c.merchantId },
      timeoutMs: 10_000,
      retries: 2,
    });
    this.token = { value: r.access_token, until: now + Math.max(0, r.expires_in - 60) * 1000 };
    return r.access_token;
  }

  /**
   * merchantTransactionId carries our session reference (hex, no dashes) plus the attempt, so
   * the webhook maps back to exactly one session.
   */
  private static txId(reference: string, idempotencyKey: string): string {
    const attempt = /:v(\d+)$/.exec(idempotencyKey)?.[1] ?? "0";
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(reference);
    return uuid ? `${reference.replace(/-/g, "")}v${attempt}` : `${reference}_v${attempt}`;
  }

  private static referenceOf(txId: string): string {
    const m = /^([0-9a-f]{32})v\d+$/.exec(txId);
    if (!m) return txId.replace(/_v\d+$/, "");
    const h = m[1]!;
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  async createCheckout(i: CreateCheckoutInput): Promise<CheckoutResult> {
    // Peach has no idempotency key on /v2/checkout (each needs a fresh nonce): remember ours.
    const prior = this.byKey.get(i.idempotencyKey);
    if (prior) return prior;
    if (i.splits?.length) throw new Error("Peach Checkout does not split payments");
    const send = async (token: string) =>
      call(this.fetchFn, `${this.hosts.secure}/v2/checkout`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", referer: this.c.allowlistedUrl },
        body: JSON.stringify({
          "authentication.entityId": this.c.entityId,
          amount: rand(i.amount),
          currency: "ZAR",
          paymentType: "DB",
          merchantTransactionId: PeachProvider.txId(i.reference, i.idempotencyKey),
          nonce: randomUUID().replace(/-/g, ""),
          shopperResultUrl: i.returnUrl,
          notificationUrl: i.webhookUrl,
          ...(i.cancelUrl ? { cancelUrl: i.cancelUrl } : {}),
        }),
        timeoutMs: 15_000,
      });
    let r = await send(await this.accessToken());
    if (r.status === 401) {
      this.token = null; // expired early: one fresh token
      r = await send(await this.accessToken());
    }
    let body: { checkoutId?: string; redirectUrl?: string; message?: string } = {};
    try {
      body = JSON.parse(r.text || "{}");
    } catch {
      /* fall through */
    }
    if (r.status < 200 || r.status >= 300 || !body.checkoutId || !body.redirectUrl) throw new HttpError(r.status, "", `Peach checkout failed: ${body.message ?? r.status}`);
    const ttl = (this.c.checkoutTtlMinutes ?? 10) * 60_000;
    const out: CheckoutResult = { providerRef: body.checkoutId, url: body.redirectUrl, expiresAt: new Date(this.c.clock.now().getTime() + ttl) };
    this.byKey.set(i.idempotencyKey, out);
    return out;
  }

  async verifyWebhook(i: { headers: Record<string, string | undefined>; rawBody: Buffer }): Promise<VerifiedEvent> {
    const text = i.rawBody.toString("utf8");
    // The first, configuration webhook is JSON; payment webhooks are form-encoded.
    if (text.trimStart().startsWith("{")) throw new WebhookIgnoredError("configuration webhook");
    const f = Object.fromEntries(new URLSearchParams(text).entries());
    const got = f.signature;
    if (!got || !/^[a-f0-9]{64}$/.test(got)) throw new WebhookSignatureError("missing signature");
    const want = peachSignature(f, this.c.secretToken);
    if (!timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new WebhookSignatureError();
    if (f.paymentType && f.paymentType !== "DB") throw new WebhookIgnoredError(`payment type ${f.paymentType}`);
    const code = f["result.code"] ?? "";
    if (PENDING.test(code)) throw new WebhookIgnoredError("pending");
    const type = SUCCESS.test(code) ? "payment.succeeded" : CANCELLED.has(code) ? "payment.cancelled" : "payment.failed";
    const providerRef = f.checkoutId ?? "";
    const amount = f.amount ?? "";
    if (!/^\d+\.\d{2}$/.test(amount) || !providerRef) throw new WebhookSignatureError("incomplete notification");
    if (f.currency && f.currency !== "ZAR") throw new WebhookSignatureError("currency");
    this.known.set(providerRef, { status: type === "payment.succeeded" ? "succeeded" : type === "payment.cancelled" ? "cancelled" : "failed", paymentId: f.id ?? null });
    const brand = (f.paymentBrand ?? "").toUpperCase();
    return {
      eventId: `${f.id ?? providerRef}:${code}`,
      type,
      reference: PeachProvider.referenceOf(f.merchantTransactionId ?? ""),
      providerRef,
      amount: cents(Math.round(Number(amount) * 100)),
      currency: "ZAR",
      method: brand === "APPLEPAY" ? "apple_pay" : brand === "GOOGLEPAY" ? "google_pay" : brand ? "card" : "unknown",
      ...(f.id ? { providerPaymentId: f.id } : {}),
      raw: { code, paymentBrand: brand || null },
    };
  }

  /** From verified webhooks; otherwise the signed v1 status query. */
  async getPaymentStatus(providerRef: string): Promise<PaymentStatus> {
    const k = this.known.get(providerRef);
    if (k) return k.status;
    const q: Record<string, string> = { "authentication.entityId": this.c.entityId, checkoutId: providerRef };
    q.signature = peachSignature(q, this.c.secretToken);
    try {
      const r = await callJson<Record<string, unknown>>(this.fetchFn, `${this.hosts.secure}/status?${new URLSearchParams(q).toString()}`, { headers: { referer: this.c.allowlistedUrl }, timeoutMs: 10_000, retries: 1 });
      const code = String((r.result as { code?: string } | undefined)?.code ?? r["result.code"] ?? "");
      return SUCCESS.test(code) ? "succeeded" : PENDING.test(code) || !code ? "pending" : CANCELLED.has(code) ? "cancelled" : "failed";
    } catch {
      return "pending";
    }
  }

  async refund(i: { providerRef: string; providerPaymentId?: string | null; amount: number; reason: string; idempotencyKey: string }): Promise<RefundResult> {
    const prior = this.refunds.get(i.idempotencyKey);
    if (prior) return prior;
    const id = i.providerPaymentId ?? this.known.get(i.providerRef)?.paymentId;
    if (!id) return { providerRefundRef: "", status: "failed" };
    const p: Record<string, string> = { "authentication.entityId": this.c.entityId, amount: rand(i.amount), currency: "ZAR", id, paymentType: "RF" };
    p.signature = peachSignature(p, this.c.secretToken);
    const r = await call(this.fetchFn, `${this.hosts.api}/v1/checkout/refund`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", referer: this.c.allowlistedUrl },
      body: new URLSearchParams(p).toString(),
      timeoutMs: 20_000,
    });
    let body: { id?: string; result?: { code?: string } } & Record<string, unknown> = {};
    try {
      body = JSON.parse(r.text || "{}");
    } catch {
      /* treated as failed below */
    }
    const code = String(body.result?.code ?? body["result.code"] ?? "");
    const result: RefundResult = SUCCESS.test(code)
      ? { providerRefundRef: body.id ?? "", status: "succeeded" }
      : PENDING.test(code)
        ? { providerRefundRef: body.id ?? "", status: "pending" }
        : { providerRefundRef: "", status: "failed" };
    this.refunds.set(i.idempotencyKey, result);
    return result;
  }
}
