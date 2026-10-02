import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@tappay/config";
import { Crypto, SEED, type DbHandle } from "@tappay/db";
import { freshTestDb } from "@tappay/db/testing";
import { FakePayFast, FakePeach, PAYFAST_TEST_IP, PayFastProvider, PeachProvider } from "@tappay/providers";
import { testEnv } from "@tappay/testkit";
import { Harness } from "./harness.js";

/**
 * M8: the whole flow through the real PayFast and Peach adapters, each talking to an in-process
 * fake of the provider (packages/providers/src/fakes.ts): tap, tip, Pay now, the provider's
 * page, its signed notification, slip, ledger, and a refund against the provider's own id.
 */
const url = process.env.TEST_DATABASE_URL;
const MANAGER = "27600000001";

describe.skipIf(!url)("real provider adapters end to end (over fakes)", () => {
  let h: DbHandle;
  let t: Harness;
  let seq = 0;
  const customer = () => `2782800${String(++seq).padStart(4, "0")}`;

  beforeAll(async () => {
    h = await freshTestDb(url!, Crypto.fromConfig(loadConfig(testEnv())));
    t = new Harness(h, url!);
  });
  afterAll(async () => {
    await t?.close();
    await h?.close();
  });
  beforeEach(async () => {
    await h.pool.query("update bills set status = 'cancelled' where status in ('open','claimed')");
    await h.pool.query("delete from otp_codes");
  });

  async function upToPayNow(to: string) {
    await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: SEED.tags.coach, lines: [{ description: "Beginner lesson", amountCents: 50000 }] });
    await t.text(to, await t.tap(SEED.tags.coach));
    await t.pick(to, "tip_bp_1000");
    await t.press(to, "pay_now");
    return t.lastBody(to);
  }

  async function refund(paymentId: string) {
    const manager = (await t.enrol(MANAGER, "5937")).accessToken;
    return t.api(manager, "POST", `/v1/merchant/payments/${paymentId}/refund`, { amountCents: 11000, reason: "short lesson" }, { "idempotency-key": randomUUID() });
  }

  it("PayFast: short link to our page that posts the signed form; ITN (form-encoded, from PayFast's address) pays; refund by pf_payment_id in cents", async () => {
    const fake = new FakePayFast({ merchantId: "10000100", merchantKey: "46f0cd694581a", passphrase: "test-pass-phrase_1" });
    t.makeProvider = () => new PayFastProvider({ merchantId: "10000100", merchantKey: "46f0cd694581a", passphrase: "test-pass-phrase_1", sandbox: false, clock: t.clock, fetch: fake.fetch, resolveHosts: async () => new Set([PAYFAST_TEST_IP]) });
    await t.reset();
    const to = customer();
    const link = /https?:\/\/\S+\/pay\/c\/([A-Za-z0-9_-]{32})/.exec(await upToPayNow(to));
    expect(link).not.toBeNull();

    // The page posts PayFast's signed form, under a CSP that only allows posting to PayFast.
    const page = await t.app.inject({ url: `/pay/c/${link![1]}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('action="https://www.payfast.co.za/eng/process"');
    expect(page.body).toContain('name="amount" value="550.00"');
    expect(String(page.headers["content-security-policy"])).toContain("form-action https://www.payfast.co.za");
    const pay = await h.db.selectFrom("payments").select(["id", "provider_ref", "checkout_form"]).where("checkout_token", "=", link![1]!).executeTakeFirstOrThrow();
    fake.submit(pay.checkout_form!);

    const itn = fake.itn(pay.provider_ref!, "COMPLETE");
    const post = (remoteAddress: string) => t.app.inject({ method: "POST", url: "/webhooks/provider/payfast", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: itn, remoteAddress });
    expect((await post("10.1.2.3")).statusCode).toBe(401); // not PayFast
    expect((await post(PAYFAST_TEST_IP)).statusCode).toBe(200);
    expect((await post(PAYFAST_TEST_IP)).json()).toMatchObject({ duplicate: true });
    expect(t.last(to).kind).toBe("image");
    const paid = await h.db.selectFrom("payments").select(["status", "provider_payment_id", "provider_fee_cents"]).where("id", "=", pay.id).executeTakeFirstOrThrow();
    expect(paid).toEqual({ status: "succeeded", provider_payment_id: fake.payments.get(pay.provider_ref!)!.pfPaymentId, provider_fee_cents: 1960 });
    // The page is gone once paid.
    expect((await t.app.inject({ url: `/pay/c/${link![1]}` })).statusCode).toBe(404);

    expect((await refund(pay.id)).json()).toMatchObject({ status: "succeeded", amountCents: 11000 });
    expect(fake.refundCalls).toEqual([{ pfPaymentId: paid.provider_payment_id, body: { amount: "11000", reason: "short lesson", notify_buyer: "1" } }]);
  });

  it("Peach: the customer gets Peach's checkout link; the signed form webhook pays; refund against the payment id", async () => {
    const cfg = { entityId: "8ac7a4ca68c22c4d0168c2caab2e0025", clientId: "client-test", clientSecret: "test-only-not-a-secret", merchantId: "merchant-test", secretToken: "test-only-secret-token" };
    const fake = new FakePeach(cfg);
    t.makeProvider = () => new PeachProvider({ ...cfg, sandbox: true, allowlistedUrl: t.config.PUBLIC_API_URL, clock: t.clock, fetch: fake.fetch });
    await t.reset();
    const to = customer();
    const body = await upToPayNow(to);
    const checkoutId = /checkoutId=([a-f0-9]{32})/.exec(body)![1]!;
    expect(body).toContain("https://testsecure.peachpayments.com/checkout?plugin=session&checkoutId=");

    const hook = fake.webhook(checkoutId, "succeeded");
    const r = await t.app.inject({ method: "POST", url: "/webhooks/provider/peach", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: hook });
    expect(r.statusCode).toBe(200);
    expect(t.last(to).kind).toBe("image");
    const pay = await h.db.selectFrom("payments").select(["id", "status", "provider_payment_id", "method"]).where("provider_ref", "=", checkoutId).executeTakeFirstOrThrow();
    expect(pay).toMatchObject({ status: "succeeded", provider_payment_id: fake.checkouts.get(checkoutId)!.paymentId, method: "card" });

    // A forged webhook is refused; the JSON setup ping is acknowledged and ignored.
    const forged = Buffer.from(hook.toString().replace("amount=550.00", "amount=1.00"));
    expect((await t.app.inject({ method: "POST", url: "/webhooks/provider/peach", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: forged })).statusCode).toBe(401);
    expect((await t.app.inject({ method: "POST", url: "/webhooks/provider/peach", headers: { "content-type": "application/json" }, payload: '{"type":"setup"}' })).json()).toMatchObject({ ignored: "configuration webhook" });

    expect((await refund(pay.id)).json()).toMatchObject({ status: "succeeded" });
    expect(fake.refundCalls[0]).toMatchObject({ id: pay.provider_payment_id, amount: "110.00", paymentType: "RF" });
  });
});
