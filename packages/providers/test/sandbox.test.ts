import { describe, expect, it } from "vitest";
import { call, cents, systemClock, type HttpFetch } from "@tappay/core";
import { apiSignature, PayFastProvider } from "../src/payfast.js";
import { PeachProvider } from "../src/peach.js";

/**
 * Live sandbox checks (M8 acceptance), skipped unless credentials are in the environment. They
 * prove the parts that need no human: credentials, endpoints, signatures and response shapes.
 * The full paid flow with a real phone is the manual run in docs/PROVIDER_NOTES.md
 * "Sandbox run with a real phone". Never point these at live credentials.
 *
 *   PEACH_SANDBOX_ENTITY_ID, PEACH_SANDBOX_CLIENT_ID, PEACH_SANDBOX_CLIENT_SECRET,
 *   PEACH_SANDBOX_MERCHANT_ID, PEACH_SANDBOX_SECRET_TOKEN, PEACH_SANDBOX_ALLOWLISTED_URL
 *   PAYFAST_SANDBOX_MERCHANT_ID, PAYFAST_SANDBOX_MERCHANT_KEY, PAYFAST_SANDBOX_PASSPHRASE
 */
const env = process.env;
const fetchFn = globalThis.fetch as unknown as HttpFetch;

const peach = env.PEACH_SANDBOX_ENTITY_ID && env.PEACH_SANDBOX_CLIENT_ID && env.PEACH_SANDBOX_CLIENT_SECRET && env.PEACH_SANDBOX_MERCHANT_ID && env.PEACH_SANDBOX_SECRET_TOKEN && env.PEACH_SANDBOX_ALLOWLISTED_URL;
describe.skipIf(!peach)("Peach sandbox (live)", () => {
  it("gets a token and creates a hosted checkout", async () => {
    const p = new PeachProvider({
      entityId: env.PEACH_SANDBOX_ENTITY_ID!,
      clientId: env.PEACH_SANDBOX_CLIENT_ID!,
      clientSecret: env.PEACH_SANDBOX_CLIENT_SECRET!,
      merchantId: env.PEACH_SANDBOX_MERCHANT_ID!,
      secretToken: env.PEACH_SANDBOX_SECRET_TOKEN!,
      sandbox: true,
      allowlistedUrl: env.PEACH_SANDBOX_ALLOWLISTED_URL!,
      clock: systemClock,
    });
    const r = await p.createCheckout({
      reference: "0b6e7a9c-1111-4222-8333-444455556666",
      amount: cents(1000),
      description: "Sandbox check",
      returnUrl: `${env.PEACH_SANDBOX_ALLOWLISTED_URL}/pay/return`,
      webhookUrl: `${env.PEACH_SANDBOX_ALLOWLISTED_URL}/webhooks/provider/peach`,
      idempotencyKey: `sandbox-${Date.now()}`,
    });
    expect(r.providerRef).toMatch(/^[a-f0-9]{32}$/);
    expect(r.url).toMatch(/^https:\/\/testsecure\.peachpayments\.com\/checkout\?plugin=session&checkoutId=[a-f0-9]{32}$/);
  }, 30_000);
});

const payfast = env.PAYFAST_SANDBOX_MERCHANT_ID && env.PAYFAST_SANDBOX_MERCHANT_KEY && env.PAYFAST_SANDBOX_PASSPHRASE;
describe.skipIf(!payfast)("PayFast sandbox (live)", () => {
  it("accepts our signed API call (ping, testing=true)", async () => {
    const timestamp = `${new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 19)}+02:00`;
    const headers = { "merchant-id": env.PAYFAST_SANDBOX_MERCHANT_ID!, version: "v1", timestamp };
    const r = await call(fetchFn, "https://api.payfast.co.za/ping?testing=true", { headers: { ...headers, signature: apiSignature(headers, env.PAYFAST_SANDBOX_PASSPHRASE!) }, timeoutMs: 15_000 });
    expect(r.status).toBe(200);
  }, 30_000);

  it("the sandbox payment page accepts our signed form", async () => {
    const p = new PayFastProvider({ merchantId: env.PAYFAST_SANDBOX_MERCHANT_ID!, merchantKey: env.PAYFAST_SANDBOX_MERCHANT_KEY!, passphrase: env.PAYFAST_SANDBOX_PASSPHRASE!, sandbox: true, clock: systemClock });
    const r = await p.createCheckout({ reference: "sandbox-check", amount: cents(1000), description: "Sandbox check", returnUrl: "https://example.org/r", webhookUrl: "https://example.org/w", idempotencyKey: `sandbox-${Date.now()}` });
    const body = r.form!.fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    const res = await call(fetchFn, r.form!.action, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, timeoutMs: 20_000 });
    // A bad signature lands on an error page; a good one on the payment page.
    expect(res.status).toBeLessThan(400);
    expect(res.text.toLowerCase()).not.toContain("signature");
  }, 30_000);
});
