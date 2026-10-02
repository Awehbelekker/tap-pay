import { cents, type PaymentProvider, type VerifiedEvent } from "@tappay/core";

/**
 * Shared contract suite (TEST_PLAN: contract layer). Every PaymentProvider adapter must pass
 * it: mock always, real adapters against sandbox credentials in M8. Test-framework agnostic:
 * pass in vitest's `describe`/`it`/`expect`.
 */
export interface ContractHarness {
  provider: PaymentProvider;
  /** Drive a checkout to completion and return the provider's signed webhook. */
  complete(providerRef: string, outcome: "succeeded" | "failed"): Promise<{ headers: Record<string, string>; rawBody: Buffer; remoteIp?: string }>;
  /** How R550,00 appears in this provider's webhook body (for the tamper test). Default "55000". */
  amountInBody?: string;
  /** The webhook without its signature (default: no headers; body-signed providers strip the field). */
  unsigned?: (w: { headers: Record<string, string>; rawBody: Buffer }) => { headers: Record<string, string>; rawBody: Buffer };
}

type Describe = (name: string, fn: () => void) => void;
type It = (name: string, fn: () => Promise<void>) => void;
type Expect = (v: unknown) => { toBe(x: unknown): void; toMatch(x: RegExp): void; rejects: { toThrow(x?: unknown): Promise<void> } };

/** For providers that sign inside a form-encoded body (PayFast, Peach). */
export function withoutSignatureField(w: { headers: Record<string, string>; rawBody: Buffer }) {
  const p = new URLSearchParams(w.rawBody.toString("utf8"));
  p.delete("signature");
  return { headers: w.headers, rawBody: Buffer.from(p.toString()) };
}

export function providerContract(name: string, make: () => ContractHarness, t: { describe: Describe; it: It; expect: Expect }): void {
  const { describe, it, expect } = t;
  describe(`PaymentProvider contract: ${name}`, () => {
    const checkout = (h: ContractHarness, key = `idem-${Math.random()}`) =>
      h.provider.createCheckout({
        reference: "session-1",
        amount: cents(55000),
        description: "Beginner lesson",
        returnUrl: "http://localhost/return",
        webhookUrl: "http://localhost/webhooks/provider/x",
        idempotencyKey: key,
      });

    it("creates a hosted checkout with an https/http URL", async () => {
      const r = await checkout(make());
      expect(r.url).toMatch(/^https?:\/\//);
      expect(typeof r.providerRef).toBe("string");
    });

    it("is idempotent on the idempotency key", async () => {
      const h = make();
      const a = await checkout(h, "same");
      const b = await checkout(h, "same");
      expect(a.providerRef).toBe(b.providerRef);
    });

    it("verifies a genuine success webhook with matching reference and amount", async () => {
      const h = make();
      const r = await checkout(h);
      const w = await h.complete(r.providerRef, "succeeded");
      const ev: VerifiedEvent = await h.provider.verifyWebhook(w);
      expect(ev.type).toBe("payment.succeeded");
      expect(ev.reference).toBe("session-1");
      expect(ev.amount).toBe(55000);
      expect(ev.currency).toBe("ZAR");
      expect(await h.provider.getPaymentStatus(r.providerRef)).toBe("succeeded");
    });

    it("rejects a tampered body", async () => {
      const h = make();
      const r = await checkout(h);
      const w = await h.complete(r.providerRef, "succeeded");
      const body = w.rawBody.toString("utf8");
      const amount = h.amountInBody ?? "55000";
      expect(body.includes(amount)).toBe(true);
      const tampered = Buffer.from(body.replace(amount, amount.replace(/^\d/, "1")));
      await expect(h.provider.verifyWebhook({ headers: w.headers, rawBody: tampered, ...(w.remoteIp ? { remoteIp: w.remoteIp } : {}) })).rejects.toThrow();
    });

    it("rejects a missing signature", async () => {
      const h = make();
      const r = await checkout(h);
      const w = await h.complete(r.providerRef, "succeeded");
      const u = h.unsigned ? h.unsigned(w) : { headers: {}, rawBody: w.rawBody };
      await expect(h.provider.verifyWebhook({ ...u, ...(w.remoteIp ? { remoteIp: w.remoteIp } : {}) })).rejects.toThrow();
    });

    it("reports failure", async () => {
      const h = make();
      const r = await checkout(h);
      const ev = await h.provider.verifyWebhook(await h.complete(r.providerRef, "failed"));
      expect(ev.type).toBe("payment.failed");
    });

    it("a repeated webhook is the same event (same id), so it is processed once", async () => {
      const h = make();
      const r = await checkout(h);
      const w = await h.complete(r.providerRef, "succeeded");
      const a = await h.provider.verifyWebhook(w);
      const b = await h.provider.verifyWebhook(w);
      expect(a.eventId).toBe(b.eventId);
      expect(a.providerRef).toBe(r.providerRef);
    });

    it("refunds part of a paid checkout; a retried refund with the same key is not repeated", async () => {
      const h = make();
      const r = await checkout(h);
      await h.provider.verifyWebhook(await h.complete(r.providerRef, "succeeded"));
      const a = await h.provider.refund({ providerRef: r.providerRef, amount: cents(11000), reason: "short lesson", idempotencyKey: "refund-1" });
      expect(a.status === "succeeded" || a.status === "pending").toBe(true);
      const b = await h.provider.refund({ providerRef: r.providerRef, amount: cents(11000), reason: "short lesson", idempotencyKey: "refund-1" });
      expect(b.providerRefundRef).toBe(a.providerRefundRef);
    });
  });
}
