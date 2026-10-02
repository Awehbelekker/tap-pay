import { describe, expect, it } from "vitest";
import { cents, systemClock } from "@tappay/core";
import { MockPaymentProvider } from "../src/mock.js";
import { providerContract } from "../src/contract.js";

const make = () => {
  const provider = new MockPaymentProvider({ secret: "s".repeat(16), publicApiUrl: "http://localhost:3000", clock: systemClock });
  return { provider, complete: async (ref: string, outcome: "succeeded" | "failed") => provider.resolve(ref, outcome) };
};

providerContract("mock", make, { describe, it, expect: expect as never });

describe("MockPaymentProvider extras", () => {
  it("first outcome wins; a later resolve cannot flip a paid checkout", async () => {
    const { provider } = make();
    const r = await provider.createCheckout({
      reference: "s",
      amount: cents(100),
      description: "x",
      returnUrl: "http://x",
      webhookUrl: "http://x",
      idempotencyKey: "k",
    });
    provider.resolve(r.providerRef, "succeeded");
    provider.resolve(r.providerRef, "failed");
    expect(await provider.getPaymentStatus(r.providerRef)).toBe("succeeded");
  });

  it("never refunds more than was paid", async () => {
    const { provider } = make();
    const r = await provider.createCheckout({
      reference: "s",
      amount: cents(1000),
      description: "x",
      returnUrl: "http://x",
      webhookUrl: "http://x",
      idempotencyKey: "k2",
    });
    provider.resolve(r.providerRef, "succeeded");
    expect((await provider.refund({ providerRef: r.providerRef, amount: 600, reason: "r", idempotencyKey: "a" })).status).toBe("succeeded");
    expect((await provider.refund({ providerRef: r.providerRef, amount: 600, reason: "r", idempotencyKey: "b" })).status).toBe("failed");
    expect(await provider.getPaymentStatus(r.providerRef)).toBe("partially_refunded");
  });
});
