import { createHash, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  call,
  cents,
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
 * PayFast adapter (docs/PROVIDER_NOTES.md "PayFast"). Built from PayFast's official PHP SDK and
 * payfast-common source (developers.payfast.co.za was unreachable from the build environment).
 *
 * Three signature schemes, all md5 lowercase hex over PHP-urlencoded `key=value&...`:
 *   form: the posted fields in the documented order, empty values skipped, values trimmed,
 *         `&passphrase=` appended last. `setup` (split payments) is not signed.
 *   ITN:  the fields in the order received up to `signature`, empty values kept, no trim,
 *         `&passphrase=` appended.
 *   API:  headers (merchant-id, timestamp, version) + query + body + passphrase, sorted by key,
 *         empty values skipped; `testing=true` (sandbox) is not signed.
 *
 * Checkout is a form POST: the API's /pay/c/:token page posts it (CheckoutResult.form).
 * Units: form and ITN amounts are rand strings ("550.00"); refunds and splits are cents.
 */

export interface PayFastConfig {
  merchantId: string;
  merchantKey: string;
  passphrase: string;
  sandbox: boolean;
  /** Ask PayFast to confirm each ITN (/eng/query/validate). On by default. */
  validateRemotely?: boolean;
  clock: Clock;
  checkoutTtlMinutes?: number;
  fetch?: HttpFetch;
  /** Addresses PayFast notifies from (DNS of its hosts); injectable for tests. */
  resolveHosts?: () => Promise<Set<string>>;
}

/** PHP `urlencode`: spaces as "+", uppercase hex, and ~!*'() encoded too. */
export function phpUrlencode(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
const rand = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const toCents = (s: string | undefined) => {
  if (s === undefined || !/^-?\d+(\.\d{1,2})?$/.test(s.trim())) throw new WebhookSignatureError("bad amount");
  return Math.round(Math.abs(Number(s)) * 100);
};

/** The form signature (official SDK Auth::generateSignature). */
export function formSignature(fields: [string, string][], passphrase: string): string {
  const parts = fields.filter(([, v]) => v.trim() !== "").map(([k, v]) => `${k}=${phpUrlencode(v.trim())}`);
  if (passphrase) parts.push(`passphrase=${phpUrlencode(passphrase.trim())}`);
  return md5(parts.join("&"));
}

/** The ITN param string, fields as received up to `signature` (official SDK Notification). */
function itnParamString(pairs: [string, string][]): string {
  const out: string[] = [];
  for (const [k, v] of pairs) {
    if (k === "signature") break;
    out.push(`${k}=${phpUrlencode(v)}`);
  }
  return out.join("&");
}

/** The REST API signature (official SDK Auth::generateApiSignature). */
export function apiSignature(data: Record<string, string>, passphrase: string): string {
  const all: Record<string, string> = { ...data, ...(passphrase ? { passphrase } : {}) };
  return md5(
    Object.keys(all)
      .sort()
      .filter((k) => k !== "signature" && all[k] !== "")
      .map((k) => `${k}=${phpUrlencode(all[k]!)}`)
      .join("&"),
  );
}

const HOSTS = ["www.payfast.co.za", "sandbox.payfast.co.za", "w1w.payfast.co.za", "w2w.payfast.co.za"];

async function resolvePayFastHosts(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const h of HOSTS) {
    try {
      for (const a of await lookup(h, { all: true })) out.add(a.address);
    } catch {
      /* one host failing to resolve must not block the others */
    }
  }
  return out;
}

const normaliseIp = (ip: string) => ip.replace(/^::ffff:/, "");

export class PayFastProvider implements PaymentProvider {
  readonly name = "payfast";
  readonly capabilities = {
    // Split payments: one receiving PayFast merchant per payment, set up on both accounts.
    nativeSplit: true,
    payouts: false,
    tokenization: false,
    methods: ["card" as const, "apple_pay" as const, "google_pay" as const, "pay_by_bank" as const],
  };
  private readonly base: string;
  private readonly fetchFn: HttpFetch;
  private hosts: { at: number; ips: Set<string> } | null = null;
  /** Seen in verified ITNs, so status and refunds work without another call. */
  private readonly known = new Map<string, { status: PaymentStatus; pfPaymentId: string | null }>();
  private readonly refunds = new Map<string, RefundResult>();

  constructor(private readonly c: PayFastConfig) {
    this.base = c.sandbox ? "https://sandbox.payfast.co.za" : "https://www.payfast.co.za";
    this.fetchFn = c.fetch ?? (globalThis.fetch as unknown as HttpFetch);
  }

  /** m_payment_id: derived from the idempotency key, so a retried Pay now is the same payment. */
  private paymentId(key: string): string {
    return `tp${createHash("sha256").update(key).digest("hex").slice(0, 30)}`;
  }

  async createCheckout(i: CreateCheckoutInput): Promise<CheckoutResult> {
    const providerRef = this.paymentId(i.idempotencyKey);
    // Documented field order (official SDK whitelist order).
    const fields: [string, string][] = [
      ["merchant_id", this.c.merchantId],
      ["merchant_key", this.c.merchantKey],
      ["return_url", i.returnUrl],
      ["cancel_url", i.cancelUrl ?? i.returnUrl],
      ["notify_url", i.webhookUrl],
      ["m_payment_id", providerRef],
      ["amount", rand(i.amount)],
      ["item_name", i.description.slice(0, 100)],
      ["custom_str1", i.reference],
    ];
    const signed: [string, string][] = [...fields.filter(([, v]) => v.trim() !== ""), ["signature", formSignature(fields, this.c.passphrase)]];
    if (i.splits && i.splits.length > 0) {
      if (i.splits.length > 1) throw new Error("PayFast splits a payment with one other merchant only");
      const s = i.splits[0]!;
      // Not part of the signature (PROVIDER_NOTES PayFast split payments).
      signed.push(["setup", JSON.stringify({ split_payment: { merchant_id: Number(s.destination), amount: s.amount } })]);
    }
    const ttl = (this.c.checkoutTtlMinutes ?? 10) * 60_000;
    return {
      providerRef,
      url: `${this.base}/eng/process`,
      expiresAt: new Date(this.c.clock.now().getTime() + ttl),
      form: { action: `${this.base}/eng/process`, fields: signed },
    };
  }

  private async allowedIps(): Promise<Set<string>> {
    const now = Date.now();
    if (!this.hosts || now - this.hosts.at > 10 * 60_000) this.hosts = { at: now, ips: await (this.c.resolveHosts ?? resolvePayFastHosts)() };
    return this.hosts.ips;
  }

  async verifyWebhook(i: { headers: Record<string, string | undefined>; rawBody: Buffer; remoteIp?: string }): Promise<VerifiedEvent> {
    const pairs = [...new URLSearchParams(i.rawBody.toString("utf8")).entries()];
    const f = Object.fromEntries(pairs);
    const got = f.signature;
    if (!got || !/^[a-f0-9]{32}$/.test(got)) throw new WebhookSignatureError("missing signature");
    const param = itnParamString(pairs);
    const want = md5(this.c.passphrase ? `${param}&passphrase=${phpUrlencode(this.c.passphrase)}` : param);
    if (!timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new WebhookSignatureError();
    if (f.merchant_id !== this.c.merchantId) throw new WebhookSignatureError("other merchant");
    // Source check (official code resolves PayFast's hosts); skipped in sandbox like the official plugins.
    if (!this.c.sandbox) {
      const ip = normaliseIp(i.remoteIp ?? "");
      if (!(await this.allowedIps()).has(ip)) throw new WebhookSignatureError("not from PayFast");
    }
    if (this.c.validateRemotely ?? true) {
      const r = await call(this.fetchFn, `${this.base}/eng/query/validate`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: param,
        timeoutMs: 15_000,
        retries: 2,
      });
      if (r.text.trim().toUpperCase() !== "VALID") throw new WebhookSignatureError("PayFast did not confirm the notification");
    }
    const status = (f.payment_status ?? "").toUpperCase();
    const providerRef = f.m_payment_id ?? "";
    if (status === "PENDING") throw new WebhookIgnoredError("pending");
    const type = status === "COMPLETE" ? "payment.succeeded" : status === "CANCELLED" ? "payment.cancelled" : status === "FAILED" ? "payment.failed" : null;
    if (!type) throw new WebhookIgnoredError(`status ${status}`);
    const pfPaymentId = f.pf_payment_id ?? null;
    this.known.set(providerRef, { status: type === "payment.succeeded" ? "succeeded" : type === "payment.failed" ? "failed" : "cancelled", pfPaymentId });
    return {
      eventId: `${pfPaymentId ?? providerRef}:${status}`,
      type,
      reference: f.custom_str1 ?? "",
      providerRef,
      amount: cents(toCents(f.amount_gross)),
      currency: "ZAR",
      method: "unknown",
      ...(f.amount_fee ? { feeCents: cents(toCents(f.amount_fee)) } : {}),
      ...(pfPaymentId ? { providerPaymentId: pfPaymentId } : {}),
      raw: { payment_status: status, pf_payment_id: pfPaymentId },
    };
  }

  /** From verified notifications (PayFast's query API needs its own id; see PROVIDER_NOTES). */
  async getPaymentStatus(providerRef: string): Promise<PaymentStatus> {
    return this.known.get(providerRef)?.status ?? "pending";
  }

  private async api(method: "GET" | "POST", path: string, body: Record<string, string>) {
    const timestamp = sastTimestamp(this.c.clock.now());
    const headers = { "merchant-id": this.c.merchantId, version: "v1", timestamp };
    const signature = apiSignature({ ...headers, ...body }, this.c.passphrase);
    const r = await call(this.fetchFn, `https://api.payfast.co.za${path}${this.c.sandbox ? "?testing=true" : ""}`, {
      method,
      headers: { ...headers, signature, "content-type": "application/json", accept: "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      timeoutMs: 20_000,
    });
    let json: { code?: number; status?: string; data?: { response?: unknown; message?: string } } = {};
    try {
      json = JSON.parse(r.text || "{}");
    } catch {
      /* non-JSON error page */
    }
    return { status: r.status, json };
  }

  /**
   * Refund (POST /refunds/{pf_payment_id}, amount in cents). PayFast has no idempotency key, so
   * the API keeps one refund row per key and calls this once; the memo covers an in-process retry.
   */
  async refund(i: { providerRef: string; providerPaymentId?: string | null; amount: number; reason: string; idempotencyKey: string }): Promise<RefundResult> {
    const prior = this.refunds.get(i.idempotencyKey);
    if (prior) return prior;
    const pf = i.providerPaymentId ?? this.known.get(i.providerRef)?.pfPaymentId;
    if (!pf) return { providerRefundRef: "", status: "failed" };
    const r = await this.api("POST", `/refunds/${encodeURIComponent(pf)}`, { amount: String(i.amount), reason: i.reason.slice(0, 100), notify_buyer: "1" });
    const ok = r.status >= 200 && r.status < 300 && r.json.status === "success";
    const result: RefundResult = { providerRefundRef: ok ? `${pf}:${i.idempotencyKey}` : "", status: ok ? "succeeded" : "failed" };
    this.refunds.set(i.idempotencyKey, result);
    return result;
  }
}

/** "2026-10-02T14:05:00+02:00" (PayFast API timestamps; South Africa has no daylight saving). */
function sastTimestamp(d: Date): string {
  return `${new Date(d.getTime() + 2 * 3_600_000).toISOString().slice(0, 19)}+02:00`;
}

