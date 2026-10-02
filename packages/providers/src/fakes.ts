import { createHash, createHmac, randomInt } from "node:crypto";
import type { HttpFetch } from "@tappay/core";
import { apiSignature, formSignature, phpUrlencode } from "./payfast.js";
import { peachSignature } from "./peach.js";

/**
 * In-process fakes of PayFast and Peach Payments, built from the same notes as the adapters
 * (docs/PROVIDER_NOTES.md). They check what the real services check (signatures, credentials)
 * and answer in the documented shapes, so the shared contract suite runs offline. They are no
 * substitute for the sandbox runs (packages/providers/test/sandbox.*.test.ts).
 */

type Resp = { status: number; ok: boolean; text(): Promise<string> };
const resp = (status: number, body: string): Resp => ({ status, ok: status < 300, text: async () => body });

// ── PayFast ──────────────────────────────────────────────────────────────────

export const PAYFAST_TEST_IP = "197.97.145.145";

export class FakePayFast {
  readonly payments = new Map<string, { fields: Record<string, string>; pfPaymentId: string; status: string; refunded: number }>();
  readonly issuedItns = new Set<string>();
  readonly refundCalls: { pfPaymentId: string; body: Record<string, string> }[] = [];

  constructor(private readonly cfg: { merchantId: string; merchantKey: string; passphrase: string }) {}

  /** The customer's browser posting the signed form (checks the signature like PayFast). */
  submit(form: { action: string; fields: [string, string][] }): string {
    const f = Object.fromEntries(form.fields);
    const signed = form.fields.filter(([k]) => k !== "signature" && k !== "setup");
    if (f.signature !== formSignature(signed, this.cfg.passphrase)) throw new Error("PayFast: signature mismatch on form");
    if (f.merchant_id !== this.cfg.merchantId || f.merchant_key !== this.cfg.merchantKey) throw new Error("PayFast: bad merchant");
    const pfPaymentId = String(randomInt(1_000_000, 9_999_999));
    this.payments.set(f.m_payment_id!, { fields: f, pfPaymentId, status: "PENDING", refunded: 0 });
    return f.m_payment_id!;
  }

  /** The ITN PayFast posts to notify_url, signed with the ITN scheme, fields in PayFast's order. */
  itn(mPaymentId: string, outcome: "COMPLETE" | "FAILED" | "CANCELLED" | "PENDING"): Buffer {
    const p = this.payments.get(mPaymentId);
    if (!p) throw new Error("unknown payment");
    if (p.status !== "COMPLETE") p.status = outcome;
    const gross = p.fields.amount!;
    const feeCents = Math.round(Number(gross) * 100 * 0.032) + 200;
    const fee = `-${(feeCents / 100).toFixed(2)}`;
    const pairs: [string, string][] = [
      ["m_payment_id", mPaymentId],
      ["pf_payment_id", p.pfPaymentId],
      ["payment_status", outcome],
      ["item_name", p.fields.item_name ?? ""],
      ["item_description", ""],
      ["amount_gross", gross],
      ["amount_fee", fee],
      ["amount_net", ((Math.round(Number(gross) * 100) - feeCents) / 100).toFixed(2)],
      ["custom_str1", p.fields.custom_str1 ?? ""],
      ["custom_str2", ""],
      ["name_first", "Test"],
      ["name_last", "Buyer"],
      ["email_address", "buyer@example.test"],
      ["merchant_id", this.cfg.merchantId],
    ];
    const param = pairs.map(([k, v]) => `${k}=${phpUrlencode(v)}`).join("&");
    this.issuedItns.add(param);
    const sig = createHash("md5").update(this.cfg.passphrase ? `${param}&passphrase=${phpUrlencode(this.cfg.passphrase)}` : param).digest("hex");
    return Buffer.from(`${param}&signature=${sig}`);
  }

  /** PayFast's side of /eng/query/validate and the REST refund. */
  readonly fetch: HttpFetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/eng/query/validate") return resp(200, this.issuedItns.has(init?.body ?? "") ? "VALID" : "INVALID");
    const m = /^\/refunds\/(\d+)$/.exec(u.pathname);
    if (m && init?.method === "POST") {
      const h = init.headers ?? {};
      const body = JSON.parse(init.body ?? "{}") as Record<string, string>;
      const want = apiSignature({ "merchant-id": h["merchant-id"]!, version: h.version!, timestamp: h.timestamp!, ...body }, this.cfg.passphrase);
      if (h.signature !== want || h["merchant-id"] !== this.cfg.merchantId) return resp(401, JSON.stringify({ code: 401, status: "failed", data: { message: "Signature mismatch" } }));
      const p = [...this.payments.values()].find((x) => x.pfPaymentId === m[1]);
      const amount = Number(body.amount);
      if (!p || p.status !== "COMPLETE" || !Number.isInteger(amount) || p.refunded + amount > Math.round(Number(p.fields.amount) * 100)) {
        return resp(400, JSON.stringify({ code: 400, status: "failed", data: { message: "Not refundable" } }));
      }
      p.refunded += amount;
      this.refundCalls.push({ pfPaymentId: m[1]!, body });
      return resp(200, JSON.stringify({ code: 200, status: "success", data: { response: true } }));
    }
    return resp(404, "not found");
  };
}

// ── Peach Payments (Checkout v2) ─────────────────────────────────────────────

export class FakePeach {
  readonly checkouts = new Map<string, { body: Record<string, unknown>; paymentId: string | null; code: string | null; refunded: number }>();
  readonly refundCalls: Record<string, string>[] = [];
  tokensIssued = 0;
  private token = "";

  constructor(private readonly cfg: { clientId: string; clientSecret: string; merchantId: string; entityId: string; secretToken: string }) {}

  readonly fetch: HttpFetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === "/api/oauth/token") {
      const b = JSON.parse(init?.body ?? "{}") as Record<string, string>;
      if (b.clientId !== this.cfg.clientId || b.clientSecret !== this.cfg.clientSecret || b.merchantId !== this.cfg.merchantId) return resp(401, JSON.stringify({ message: "invalid client" }));
      this.token = `jwt.${++this.tokensIssued}`;
      return resp(200, JSON.stringify({ access_token: this.token, token_type: "Bearer", expires_in: 3600 }));
    }
    if (u.pathname === "/v2/checkout" && init?.method === "POST") {
      const h = init.headers ?? {};
      if (h.authorization !== `Bearer ${this.token}`) return resp(401, JSON.stringify({ message: "Unauthorized" }));
      if (!h.referer) return resp(403, JSON.stringify({ message: "Referer not allowlisted" }));
      const b = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      if (b["authentication.entityId"] !== this.cfg.entityId) return resp(404, JSON.stringify({ message: "entity not found" }));
      if (!/^\d+\.\d{2}$/.test(String(b.amount)) || !b.nonce || !b.merchantTransactionId) return resp(400, JSON.stringify({ message: "invalid request" }));
      const checkoutId = createHash("md5").update(String(b.nonce)).digest("hex");
      this.checkouts.set(checkoutId, { body: b, paymentId: null, code: null, refunded: 0 });
      return resp(200, JSON.stringify({ checkoutId, redirectUrl: `https://testsecure.peachpayments.com/checkout?plugin=session&checkoutId=${checkoutId}` }));
    }
    if (u.pathname === "/v1/checkout/refund" && init?.method === "POST") {
      const p = Object.fromEntries(new URLSearchParams(init.body ?? "").entries());
      if (p.signature !== peachSignature(p, this.cfg.secretToken)) return resp(200, JSON.stringify({ result: { code: "800.900.300", description: "invalid signature" } }));
      const c = [...this.checkouts.values()].find((x) => x.paymentId === p.id);
      const cents = Math.round(Number(p.amount) * 100);
      if (!c || !c.code?.startsWith("000.") || c.refunded + cents > Math.round(Number(c.body.amount) * 100)) {
        return resp(200, JSON.stringify({ result: { code: "700.400.200", description: "cannot refund" } }));
      }
      c.refunded += cents;
      this.refundCalls.push(p);
      return resp(200, JSON.stringify({ id: `rf${randomInt(1e9)}`, referencedId: p.id, paymentType: "RF", amount: p.amount, currency: "ZAR", result: { code: "000.100.110", description: "Request successfully processed" } }));
    }
    return resp(404, JSON.stringify({ message: "not found" }));
  };

  /** The form-encoded webhook Checkout posts after the payment (signature inside the body). */
  webhook(checkoutId: string, outcome: "succeeded" | "failed" | "cancelled"): Buffer {
    const c = this.checkouts.get(checkoutId);
    if (!c) throw new Error("unknown checkout");
    c.paymentId ??= createHmac("sha256", "id").update(checkoutId).digest("hex").slice(0, 32);
    c.code = outcome === "succeeded" ? "000.100.110" : outcome === "cancelled" ? "100.396.101" : "800.100.151";
    const fields: Record<string, string> = {
      amount: String(c.body.amount),
      checkoutId,
      currency: "ZAR",
      id: c.paymentId,
      merchantTransactionId: String(c.body.merchantTransactionId),
      paymentBrand: "VISA",
      paymentType: "DB",
      "result.code": c.code,
      "result.description": outcome,
      timestamp: "2026-10-02T12:00:00Z",
      "card.last4Digits": "0042",
    };
    fields.signature = peachSignature(fields, this.cfg.secretToken);
    return Buffer.from(new URLSearchParams(fields).toString());
  }
}
