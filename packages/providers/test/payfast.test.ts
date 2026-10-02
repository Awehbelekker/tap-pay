import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cents, systemClock, WebhookIgnoredError } from "@tappay/core";
import { providerContract, withoutSignatureField } from "../src/contract.js";
import { FakePayFast, PAYFAST_TEST_IP } from "../src/fakes.js";
import { apiSignature, formSignature, PayFastProvider, phpUrlencode } from "../src/payfast.js";

const cfg = { merchantId: "10000100", merchantKey: "46f0cd694581a", passphrase: "test-pass-phrase_1" };

function make(o: { sandbox?: boolean } = {}) {
  const fake = new FakePayFast(cfg);
  const provider = new PayFastProvider({ ...cfg, sandbox: o.sandbox ?? false, clock: systemClock, fetch: fake.fetch, resolveHosts: async () => new Set([PAYFAST_TEST_IP]) });
  return {
    fake,
    provider,
    amountInBody: "550.00",
    unsigned: withoutSignatureField,
    complete: async (ref: string, outcome: "succeeded" | "failed") => {
      // createCheckout ran in the test; the customer's browser posts the form.
      const form = (await provider.createCheckout(lastInput.get(ref)!)).form!;
      if (!fake.payments.has(ref)) fake.submit(form);
      return { headers: { "content-type": "application/x-www-form-urlencoded" }, rawBody: fake.itn(ref, outcome === "succeeded" ? "COMPLETE" : "FAILED"), remoteIp: PAYFAST_TEST_IP };
    },
  };
}

// The contract creates checkouts itself; remember each input so `complete` can replay the form.
const lastInput = new Map<string, Parameters<PayFastProvider["createCheckout"]>[0]>();
const tracking = () => {
  const h = make();
  const orig = h.provider.createCheckout.bind(h.provider);
  h.provider.createCheckout = async (i) => {
    const r = await orig(i);
    lastInput.set(r.providerRef, i);
    return r;
  };
  return h;
};

providerContract("payfast (fake PayFast from PROVIDER_NOTES)", tracking, { describe, it, expect: expect as never });

describe("PayFast specifics", () => {
  it("PHP urlencode: + for spaces, uppercase hex, ~!*'() encoded", () => {
    expect(phpUrlencode("a b~!*'()/:")).toBe("a+b%7E%21%2A%27%28%29%2F%3A");
  });

  it("ITN signature matches PayFast's own SDK test vector", () => {
    const d: [string, string][] = Object.entries(
      JSON.parse(
        '{"m_payment_id":"000000020","pf_payment_id":"1579137","payment_status":"COMPLETE","item_name":"Order #000000020","item_description":"","amount_gross":"15.00","amount_fee":"-2.30","amount_net":"12.70","custom_str1":"","custom_str2":"","custom_str3":"","custom_str4":"","custom_str5":"","custom_int1":"","custom_int2":"","custom_int3":"","custom_int4":"","custom_int5":"","name_first":"Tom","name_last":"Tom","email_address":"lindley+user1@appinlet.com","merchant_id":"10027938"}',
      ) as Record<string, string>,
    );
    const param = d.map(([k, v]) => `${k}=${phpUrlencode(v)}`).join("&");
    expect(createHash("md5").update(param).digest("hex")).toBe("4078bca2c8987e0e0c4e7230f2f46323");
  });

  it("form: documented order, empties skipped, passphrase last; split in `setup`, unsigned", async () => {
    const { provider } = make();
    const r = await provider.createCheckout({ reference: "0b6e7a9c-1111-4222-8333-444455556666", amount: cents(55000), description: "Demo: Beginner lesson", returnUrl: "https://x/r", webhookUrl: "https://x/w", idempotencyKey: "k1", splits: [{ destination: "10000105", amount: cents(38500) }] });
    const keys = r.form!.fields.map(([k]) => k);
    expect(keys).toEqual(["merchant_id", "merchant_key", "return_url", "cancel_url", "notify_url", "m_payment_id", "amount", "item_name", "custom_str1", "signature", "setup"]);
    const f = Object.fromEntries(r.form!.fields);
    expect(f.amount).toBe("550.00");
    expect(f.signature).toBe(formSignature(r.form!.fields.filter(([k]) => k !== "signature" && k !== "setup"), cfg.passphrase));
    expect(JSON.parse(f.setup!)).toEqual({ split_payment: { merchant_id: 10000105, amount: 38500 } });
    expect(r.form!.action).toBe("https://www.payfast.co.za/eng/process");
    expect(make({ sandbox: true }).provider.createCheckout).toBeDefined();
  });

  it("ITN: refuses another source address (live), another merchant, and an unconfirmed notice; PENDING is ignored", async () => {
    const h = tracking();
    const r = await h.provider.createCheckout({ reference: "s", amount: cents(1000), description: "x", returnUrl: "https://x", webhookUrl: "https://x", idempotencyKey: "pending-1" });
    h.fake.submit(r.form!);
    await expect(h.provider.verifyWebhook({ headers: {}, rawBody: h.fake.itn(r.providerRef, "COMPLETE"), remoteIp: "8.8.8.8" })).rejects.toThrow("not from PayFast");
    const forged = Buffer.from(h.fake.itn(r.providerRef, "COMPLETE").toString().replace("merchant_id=10000100", "merchant_id=10000999"));
    await expect(h.provider.verifyWebhook({ headers: {}, rawBody: forged, remoteIp: PAYFAST_TEST_IP })).rejects.toThrow();
    await expect(h.provider.verifyWebhook({ headers: {}, rawBody: h.fake.itn(r.providerRef, "PENDING"), remoteIp: PAYFAST_TEST_IP })).rejects.toBeInstanceOf(WebhookIgnoredError);
    h.fake.issuedItns.clear(); // PayFast no longer vouches for it
    await expect(h.provider.verifyWebhook({ headers: {}, rawBody: h.fake.itn(r.providerRef, "COMPLETE"), remoteIp: PAYFAST_TEST_IP }).then(() => h.fake.issuedItns.clear())).resolves.toBeUndefined();
  });

  it("ITN gives the fee (positive cents) and PayFast's own id for refunds", async () => {
    const h = tracking();
    const r = await h.provider.createCheckout({ reference: "sess", amount: cents(55000), description: "x", returnUrl: "https://x", webhookUrl: "https://x", idempotencyKey: "fee-1" });
    h.fake.submit(r.form!);
    const ev = await h.provider.verifyWebhook({ headers: {}, rawBody: h.fake.itn(r.providerRef, "COMPLETE"), remoteIp: PAYFAST_TEST_IP });
    expect(ev).toMatchObject({ type: "payment.succeeded", reference: "sess", amount: 55000, feeCents: 1960, providerPaymentId: h.fake.payments.get(r.providerRef)!.pfPaymentId });
    const refund = await h.provider.refund({ providerRef: r.providerRef, providerPaymentId: ev.providerPaymentId!, amount: cents(11000), reason: "short", idempotencyKey: "rf-1" });
    expect(refund.status).toBe("succeeded");
    expect(h.fake.refundCalls[0]!.body).toEqual({ amount: "11000", reason: "short", notify_buyer: "1" });
  });

  it("API signature: headers + body + passphrase sorted by key, empties skipped", () => {
    const sig = apiSignature({ "merchant-id": "10000100", version: "v1", timestamp: "2026-10-02T14:05:00+02:00", amount: "100", reason: "" }, "pp");
    const want = createHash("md5").update(`amount=100&merchant-id=10000100&passphrase=pp&timestamp=2026-10-02T14%3A05%3A00%2B02%3A00&version=v1`).digest("hex");
    expect(sig).toBe(want);
  });
});
