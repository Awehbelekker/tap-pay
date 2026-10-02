import { cents, type PaymentProvider, type VerifiedEvent } from "@tappay/core";

/**
 * Shared contract suite (TEST_PLAN: contract layer). Every PaymentProvider adapter must pass
 * it: mock always, real adapters against sandbox credentials in M8. Test-framework agnostic:
 * pass in vitest's `describe`/`it`/`expect`.
 */
export interface ContractHarness {
  provider: PaymentProvider;
  /** Drive a checkout to completion and return the provider's signed webhook. */
  complete(providerRef: string, outcome: "succeeded" | "failed"): Promise<{ headers: Record<string, string>; rawBody: Buffer }>;
}

type Describe = (name: string, fn: () => void) => void;
type It = (name: string, fn: () => Promise<void>) => void;
type Expect = (v: unknown) => { toBe(x: unknown): void; toMatch(x: RegExp): void; rejects: { toThrow(x?: unknown): Promise<void> } };

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
      const ev: VerifiedEvent = await h.provider.verifyWebhook(await h.complete(r.providerRef, "succeeded"));
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
      const tampered = Buffer.from(w.rawBody.toString("utf8").replace("55000", "1"));
      await expect(h.provider.verifyWebhook({ headers: w.headers, rawBody: tampered })).rejects.toThrow();
    });

    it("rejects a missing signature", async () => {
      const h = make();
      const r = await checkout(h);
      const w = await h.complete(r.providerRef, "succeeded");
      await expect(h.provider.verifyWebhook({ headers: {}, rawBody: w.rawBody })).rejects.toThrow();
    });

    it("reports failure", async () => {
      const h = make();
      const r = await checkout(h);
      const ev = await h.provider.verifyWebhook(await h.complete(r.providerRef, "failed"));
      expect(ev.type).toBe("payment.failed");
    });
  });
}
