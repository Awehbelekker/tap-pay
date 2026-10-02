import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  cents,
  WebhookSignatureError,
  type CheckoutResult,
  type Clock,
  type CreateCheckoutInput,
  type PaymentProvider,
  type PaymentStatus,
  type RefundResult,
  type VerifiedEvent,
} from "@tappay/core";

/**
 * Mock hosted-checkout provider (ARCHITECTURE: adapters). Default in dev and tests. The API
 * serves /mock-checkout/:ref with Succeed / Fail / Cancel / Delay buttons that call `resolve()`,
 * which produces a signed webhook exactly like a real provider would. Duplicate and
 * out-of-order deliveries are simulated by re-posting the same signed body.
 */

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

export type MockOutcome = "succeeded" | "failed" | "cancelled";

interface MockCheckout {
  input: CreateCheckoutInput;
  providerRef: string;
  status: PaymentStatus;
  refundedCents: number;
}

export interface SignedWebhook {
  headers: Record<string, string>;
  rawBody: Buffer;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock";
  readonly capabilities = {
    nativeSplit: false,
    payouts: true,
    tokenization: false,
    methods: ["apple_pay" as const, "google_pay" as const, "card" as const],
  };

  private readonly byRef = new Map<string, MockCheckout>();
  private readonly byIdem = new Map<string, string>();

  constructor(
    private readonly opts: { secret: string; publicApiUrl: string; clock: Clock; checkoutTtlMinutes?: number },
  ) {}

  async createCheckout(i: CreateCheckoutInput): Promise<CheckoutResult> {
    const existing = this.byIdem.get(i.idempotencyKey);
    const providerRef = existing ?? `mock_${randomUUID()}`;
    if (!existing) {
      this.byIdem.set(i.idempotencyKey, providerRef);
      this.byRef.set(providerRef, { input: i, providerRef, status: "pending", refundedCents: 0 });
    }
    const ttl = (this.opts.checkoutTtlMinutes ?? 10) * 60_000;
    return {
      providerRef,
      url: `${this.opts.publicApiUrl}/mock-checkout/${providerRef}`,
      expiresAt: new Date(this.opts.clock.now().getTime() + ttl),
    };
  }

  /** Simulate the customer finishing checkout. Returns the signed webhook the provider sends. */
  resolve(providerRef: string, outcome: MockOutcome): SignedWebhook {
    const c = this.byRef.get(providerRef);
    if (!c) throw new Error("unknown mock checkout");
    if (c.status === "pending") c.status = outcome;
    const body = {
      id: `evt_${randomUUID()}`,
      type: `payment.${outcome}`,
      reference: c.input.reference,
      providerRef,
      amountCents: c.input.amount,
      currency: "ZAR",
      method: "apple_pay",
      feeCents: outcome === "succeeded" ? Math.floor((c.input.amount * 290) / 10000) : 0,
    };
    return this.sign(Buffer.from(JSON.stringify(body)));
  }

  sign(rawBody: Buffer): SignedWebhook {
    const sig = createHmac("sha256", this.opts.secret).update(rawBody).digest("hex");
    return { headers: { "content-type": "application/json", [MOCK_SIGNATURE_HEADER]: sig }, rawBody };
  }

  async verifyWebhook(i: { headers: Record<string, string | undefined>; rawBody: Buffer }): Promise<VerifiedEvent> {
    const got = i.headers[MOCK_SIGNATURE_HEADER];
    if (!got) throw new WebhookSignatureError("missing signature");
    const want = createHmac("sha256", this.opts.secret).update(i.rawBody).digest();
    const gotBuf = Buffer.from(got, "hex");
    if (gotBuf.length !== want.length || !timingSafeEqual(gotBuf, want)) throw new WebhookSignatureError();
    const b = JSON.parse(i.rawBody.toString("utf8")) as Record<string, unknown>;
    const type = String(b.type);
    if (!["payment.succeeded", "payment.failed", "payment.cancelled"].includes(type)) {
      throw new WebhookSignatureError("unsupported event type");
    }
    return {
      eventId: String(b.id),
      type: type as VerifiedEvent["type"],
      reference: String(b.reference),
      providerRef: String(b.providerRef),
      amount: cents(Number(b.amountCents)),
      currency: "ZAR",
      method: "apple_pay",
      feeCents: cents(Number(b.feeCents ?? 0)),
      raw: b,
    };
  }

  async getPaymentStatus(providerRef: string): Promise<PaymentStatus> {
    const c = this.byRef.get(providerRef);
    if (!c) throw new Error("unknown mock checkout");
    return c.status;
  }

  async refund(i: { providerRef: string; amount: number; reason: string; idempotencyKey: string }): Promise<RefundResult> {
    const c = this.byRef.get(i.providerRef);
    if (!c || (c.status !== "succeeded" && c.status !== "partially_refunded")) {
      return { providerRefundRef: "", status: "failed" };
    }
    if (c.refundedCents + i.amount > c.input.amount) return { providerRefundRef: "", status: "failed" };
    c.refundedCents += i.amount;
    c.status = c.refundedCents === c.input.amount ? "refunded" : "partially_refunded";
    return { providerRefundRef: `mock_refund_${i.idempotencyKey}`, status: "succeeded" };
  }
}
