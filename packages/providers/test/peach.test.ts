import { describe, expect, it } from "vitest";
import { cents, systemClock, WebhookIgnoredError } from "@tappay/core";
import { providerContract, withoutSignatureField } from "../src/contract.js";
import { FakePeach } from "../src/fakes.js";
import { PeachProvider, peachSignature } from "../src/peach.js";

const cfg = { entityId: "8ac7a4ca68c22c4d0168c2caab2e0025", clientId: "client-test", clientSecret: "test-only-not-a-secret", merchantId: "merchant-test", secretToken: "test-only-secret-token" };

function make() {
  const fake = new FakePeach(cfg);
  const provider = new PeachProvider({ ...cfg, sandbox: true, allowlistedUrl: "https://pay.example.test", clock: systemClock, fetch: fake.fetch });
  return {
    fake,
    provider,
    amountInBody: "550.00",
    unsigned: withoutSignatureField,
    complete: async (ref: string, outcome: "succeeded" | "failed") => ({ headers: { "content-type": "application/x-www-form-urlencoded" }, rawBody: fake.webhook(ref, outcome) }),
  };
}

providerContract("peach (fake Peach Checkout v2 from PROVIDER_NOTES)", make, { describe, it, expect: expect as never });

describe("Peach specifics", () => {
  it("signature matches Peach's own SDK example webhooks", () => {
    const processed = {
      amount: "10.00",
      "card.bin": "420000",
      "card.expiryMonth": "01",
      "card.expiryYear": "2025",
      "card.holder": "Avish",
      "card.last4Digits": "0042",
      checkoutId: "e25a62e6c22b4125ac819438bf8c5f59",
      currency: "ZAR",
      id: "8ac7a49f93b294a30193b48242b41727",
      "merchant.name": "SB Sandbox Avish SA",
      merchantTransactionId: "f6527aa27988dfabc81e3e1dd7bb0bcb",
      paymentBrand: "VISA",
      paymentType: "DB",
      "recon.authCode": "006887",
      "recon.resultCode": "000",
      "recon.rrn": "416789862593",
      "recon.stan": "860002",
      "result.code": "000.100.110",
      "result.description": "Request successfully processed in 'Merchant in Integrator Test Mode'",
      "resultDetails.AcquirerResponse": "E0000",
      "resultDetails.ExtendedDescription": "Transaction Successful",
      timestamp: "2024-12-11T06:59:59Z",
    };
    expect(peachSignature(processed, "THIS_IS_MY_SECRET")).toBe("55acdf4cec9bd58b56c336eec6711ec20d0b50de5bbc7627856536dd1cc30edc");
    const created = { amount: "10.00", checkoutId: "e25a62e6c22b4125ac819438bf8c5f59", currency: "ZAR", merchantTransactionId: "f6527aa27988dfabc81e3e1dd7bb0bcb", paymentType: "DB", "result.code": "000.200.100", "result.description": "successfully created checkout", timestamp: "2024-12-11T06:57:13Z" };
    expect(peachSignature(created, "THIS_IS_MY_SECRET")).toBe("96bd51b25f880bf3561d1cb315452a7bca767479baa3bed99f66d69bee269034");
  });

  it("checkout: OAuth token reused, flat dotted keys, rand amount, our session in merchantTransactionId", async () => {
    const { provider, fake } = make();
    const a = await provider.createCheckout({ reference: "0b6e7a9c-1111-4222-8333-444455556666", amount: cents(55000), description: "x", returnUrl: "https://x/r", webhookUrl: "https://x/w", idempotencyKey: "0b6e7a9c-1111-4222-8333-444455556666:v3" });
    await provider.createCheckout({ reference: "s2", amount: cents(100), description: "x", returnUrl: "https://x/r", webhookUrl: "https://x/w", idempotencyKey: "other" });
    expect(fake.tokensIssued).toBe(1);
    const body = fake.checkouts.get(a.providerRef)!.body;
    expect(body).toMatchObject({ "authentication.entityId": cfg.entityId, amount: "550.00", currency: "ZAR", paymentType: "DB", merchantTransactionId: "0b6e7a9c111142228333444455556666v3", shopperResultUrl: "https://x/r", notificationUrl: "https://x/w" });
    expect(a.url).toMatch(/^https:\/\/testsecure\.peachpayments\.com\/checkout\?plugin=session&checkoutId=[a-f0-9]{32}$/);
    const ev = await provider.verifyWebhook({ headers: {}, rawBody: fake.webhook(a.providerRef, "succeeded") });
    expect(ev.reference).toBe("0b6e7a9c-1111-4222-8333-444455556666");
    expect(ev.method).toBe("card");
  });

  it("pending and the JSON configuration webhook are ignored; cancelled is cancelled", async () => {
    const { provider, fake } = make();
    await expect(provider.verifyWebhook({ headers: {}, rawBody: Buffer.from('{"type":"config"}') })).rejects.toBeInstanceOf(WebhookIgnoredError);
    const r = await provider.createCheckout({ reference: "s", amount: cents(100), description: "x", returnUrl: "https://x", webhookUrl: "https://x", idempotencyKey: "c1" });
    const f = Object.fromEntries(new URLSearchParams(fake.webhook(r.providerRef, "succeeded").toString()));
    f["result.code"] = "000.200.000";
    f.signature = peachSignature(f, cfg.secretToken);
    await expect(provider.verifyWebhook({ headers: {}, rawBody: Buffer.from(new URLSearchParams(f).toString()) })).rejects.toBeInstanceOf(WebhookIgnoredError);
    const r2 = await provider.createCheckout({ reference: "s", amount: cents(100), description: "x", returnUrl: "https://x", webhookUrl: "https://x", idempotencyKey: "c2" });
    expect((await provider.verifyWebhook({ headers: {}, rawBody: fake.webhook(r2.providerRef, "cancelled") })).type).toBe("payment.cancelled");
  });

  it("refund goes against the payment id, signed, form-encoded; a declined refund (HTTP 200) is a failure", async () => {
    const { provider, fake } = make();
    const r = await provider.createCheckout({ reference: "s", amount: cents(55000), description: "x", returnUrl: "https://x", webhookUrl: "https://x", idempotencyKey: "rf" });
    const ev = await provider.verifyWebhook({ headers: {}, rawBody: fake.webhook(r.providerRef, "succeeded") });
    expect((await provider.refund({ providerRef: r.providerRef, providerPaymentId: ev.providerPaymentId!, amount: cents(11000), reason: "x", idempotencyKey: "a" })).status).toBe("succeeded");
    expect(fake.refundCalls[0]).toMatchObject({ "authentication.entityId": cfg.entityId, amount: "110.00", currency: "ZAR", id: ev.providerPaymentId, paymentType: "RF" });
    expect((await provider.refund({ providerRef: r.providerRef, providerPaymentId: ev.providerPaymentId!, amount: cents(50000), reason: "x", idempotencyKey: "b" })).status).toBe("failed");
  });
});
