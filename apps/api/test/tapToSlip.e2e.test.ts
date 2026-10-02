import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@tappay/config";
import { Crypto, createBill, SEED, type DbHandle } from "@tappay/db";
import { freshTestDb } from "@tappay/db/testing";
import { MockPaymentProvider } from "@tappay/providers";
import { FixedClock, testEnv } from "@tappay/testkit";
import { inboundPayload, sign, type Inbound } from "@tappay/wa-sim";
import { SimWhatsAppClient, type SimMessage } from "@tappay/whatsapp";
import { buildApp } from "../src/app.js";

/**
 * M1 acceptance: the scripted tap-to-slip journey through the real HTTP routes, real Postgres,
 * the WhatsApp simulator client and the mock provider. Also: duplicate webhooks have no double
 * effect, and bad signatures are rejected.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("tap to slip (e2e)", () => {
  const config = loadConfig(testEnv({ DATABASE_URL: url ?? "postgres://x@localhost/x_test" }));
  const crypto = Crypto.fromConfig(config);
  const clock = new FixedClock(new Date());
  let h: DbHandle;
  let app: FastifyInstance;
  let wa: SimWhatsAppClient;
  let provider: MockPaymentProvider;

  beforeAll(async () => {
    h = await freshTestDb(url!, crypto);
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  beforeEach(async () => {
    await app?.close();
    clock.set(new Date());
    // Every scenario starts with no live bills on the demo tags.
    await h.pool.query("update bills set status = 'cancelled' where status in ('open','claimed')");
    wa = new SimWhatsAppClient();
    provider = new MockPaymentProvider({ secret: config.MOCK_PROVIDER_SECRET, publicApiUrl: config.PUBLIC_API_URL, clock, checkoutTtlMinutes: 10 });
    app = buildApp({ config, db: h, queue: { ready: async () => true }, clock, wa, provider });
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  const newBill = (amountCents = 50000, tag = SEED.tags.coach) =>
    h.db
      .selectFrom("tags")
      .select(["id", "assigned_user_id"])
      .where("code", "=", tag)
      .executeTakeFirstOrThrow()
      .then((t) =>
        createBill(h.db, {
          merchantId: SEED.merchantId,
          tagId: t.id,
          assignedUserId: t.assigned_user_id,
          createdBy: SEED.coachId,
          lines: [{ description: "Beginner lesson", amountCents }],
          billToken: randomUUID(),
          expiresAt: new Date(clock.now().getTime() + 24 * 3_600_000),
        }),
      );

  async function tap(code: string = SEED.tags.coach): Promise<string> {
    const r = await app.inject({ url: `/t/${code}` });
    expect(r.statusCode).toBe(302);
    const loc = new URL(r.headers.location as string);
    const text = loc.searchParams.get("text")!;
    expect(text).toMatch(/^PAY [A-Z2-9]{6}$/);
    return text;
  }

  async function say(from: string, message: Inbound, messageId = `wamid.${randomUUID()}`) {
    const raw = Buffer.from(JSON.stringify(inboundPayload({ from, profileName: "Test Customer", phoneNumberId: "p", displayNumber: config.WA_PHONE_NUMBER, message, messageId })));
    const r = await app.inject({ method: "POST", url: "/webhooks/whatsapp", headers: { "content-type": "application/json", "x-hub-signature-256": sign(config.WA_APP_SECRET, raw) }, payload: raw });
    expect(r.statusCode).toBe(200);
    return messageId;
  }

  const text = (from: string, t: string, id?: string) => say(from, { kind: "text", text: t }, id);
  const press = (from: string, id: string, messageId?: string) => say(from, { kind: "button_reply", id, title: id }, messageId);
  const last = (to: string): SimMessage => wa.messagesTo(to).at(-1)!;
  const body = (m: SimMessage) => ("body" in m ? m.body : "caption" in m ? (m.caption ?? "") : "");
  const checkoutRef = (to: string) => /\/mock-checkout\/(mock_[0-9a-f-]+)/.exec(body(last(to)))![1]!;

  async function payThroughToLink(customer: string, tipId = "tip_bp_1500") {
    await text(customer, await tap());
    expect(last(customer).kind).toBe("list");
    await press(customer, tipId);
    expect(last(customer).kind).toBe("buttons");
    await press(customer, "pay_now");
    return checkoutRef(customer);
  }

  const counts = async (paymentRef: string) => {
    const pay = await h.db.selectFrom("payments").selectAll().where("provider_ref", "=", paymentRef).executeTakeFirstOrThrow();
    const ledger = await h.db.selectFrom("ledger_entries").select(["kind", "party_kind", "party_user_id", "amount_cents"]).where("payment_id", "=", pay.id).execute();
    const receipts = await h.db.selectFrom("receipts").select("receipt_token").where("payment_id", "=", pay.id).execute();
    return { pay, ledger, receipts };
  };

  // ── scenarios ──────────────────────────────────────────────────────────────

  it("happy path: tap, tip 15%, pay, slip; duplicate webhooks change nothing", async () => {
    const bill = await newBill();
    const customer = "27820000001";
    await text(customer, await tap());

    const tipList = last(customer);
    expect(tipList.kind === "list" && tipList.rows.map((r) => r.id)).toEqual(["tip_none", "tip_bp_1000", "tip_bp_1500", "tip_bp_2000", "tip_custom"]);
    expect(body(tipList)).toContain("Demo Surf School");
    expect(body(tipList)).toContain("Sipho");

    await press(customer, "tip_bp_1500");
    expect(body(last(customer))).toBe("Pay R575,00 to Demo Surf School?\nBeginner lesson: R500,00\nTip: R75,00");

    await press(customer, "pay_now");
    const ref = checkoutRef(customer);
    expect(body(last(customer))).toContain("The link works for 10 minutes.");

    const page = await app.inject({ url: `/mock-checkout/${ref}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("R575,00");

    // Provider sends the same signed webhook three times.
    const res = await app.inject({ method: "POST", url: `/mock-checkout/${ref}`, payload: { outcome: "succeeded", repeat: 3 } });
    expect(res.json()).toEqual({ ok: true, webhookStatuses: [200, 200, 200] });

    const slip = last(customer);
    expect(slip.kind).toBe("image");
    expect(body(slip)).toContain("Paid R575,00 to Demo Surf School");
    expect(wa.messagesTo(customer).filter((m) => m.kind === "image")).toHaveLength(1);

    const { pay, ledger, receipts } = await counts(ref);
    expect(pay.status).toBe("succeeded");
    expect(pay.amount_cents).toBe(57500);
    expect(receipts).toHaveLength(1);
    const credits = ledger.filter((l) => l.amount_cents > 0).reduce((a, l) => a + l.amount_cents, 0);
    expect(credits).toBe(57500);
    expect(ledger).toContainEqual({ kind: "tip", party_kind: "staff", party_user_id: SEED.coachId, amount_cents: 7500 });
    expect(ledger.find((l) => l.kind === "fee")!.amount_cents).toBeLessThan(0);

    const b = await h.db.selectFrom("bills").select(["status", "paid_at"]).where("id", "=", bill.id).executeTakeFirstOrThrow();
    expect(b.status).toBe("paid");
    expect(b.paid_at).not.toBeNull();
    const events = await h.db.selectFrom("webhook_events").select(["status"]).where("source", "=", "mock").execute();
    expect(events.filter((e) => e.status === "processed")).toHaveLength(1);

    // The receipt page and slip image are served by the unguessable token.
    const receiptUrl = new URL(/Receipt: (\S+)/.exec(body(slip))![1]!);
    const html = await app.inject({ url: receiptUrl.pathname });
    expect(html.statusCode).toBe(200);
    const png = await app.inject({ url: `${receiptUrl.pathname}/slip.png` });
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    expect((await app.inject({ url: "/r/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).statusCode).toBe(404);

    // Replaying the exact same provider event later is still a no-op.
    const replay = provider.sign(Buffer.from(JSON.stringify({ id: "evt_replay", type: "payment.succeeded", reference: pay.session_id, providerRef: ref, amountCents: 57500, currency: "ZAR" })));
    const again = await app.inject({ method: "POST", url: "/webhooks/provider/mock", headers: replay.headers, payload: replay.rawBody });
    expect(again.statusCode).toBe(200);
    expect((await counts(ref)).ledger).toHaveLength(ledger.length);
    expect(wa.messagesTo(customer).filter((m) => m.kind === "image")).toHaveLength(1);
  });

  it("rejects WhatsApp webhooks with a missing or wrong signature", async () => {
    await newBill();
    const raw = Buffer.from(JSON.stringify(inboundPayload({ from: "27820000002", profileName: "x", phoneNumberId: "p", displayNumber: "1", message: { kind: "text", text: await tap() } })));
    for (const sig of [undefined, "sha256=00", sign("wrong-secret", raw)]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (sig) headers["x-hub-signature-256"] = sig;
      const r = await app.inject({ method: "POST", url: "/webhooks/whatsapp", headers, payload: raw });
      expect(r.statusCode).toBe(401);
    }
    expect(wa.outbox).toHaveLength(0);
  });

  it("rejects forged provider webhooks and never marks the payment paid", async () => {
    await newBill();
    const customer = "27820000003";
    const ref = await payThroughToLink(customer);
    const pay = (await counts(ref)).pay;
    const forged = Buffer.from(JSON.stringify({ id: "evt_forged", type: "payment.succeeded", reference: pay.session_id, providerRef: ref, amountCents: 57500, currency: "ZAR" }));
    for (const sig of [undefined, "00", "deadbeef".repeat(8)]) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (sig) headers["x-mock-signature"] = sig;
      expect((await app.inject({ method: "POST", url: "/webhooks/provider/mock", headers, payload: forged })).statusCode).toBe(401);
    }
    expect((await counts(ref)).pay.status).toBe("pending");
  });

  it("does not mark paid when the confirmed amount differs", async () => {
    await newBill();
    const customer = "27820000004";
    const ref = await payThroughToLink(customer, "tip_none");
    const pay = (await counts(ref)).pay;
    const hook = provider.sign(Buffer.from(JSON.stringify({ id: "evt_short", type: "payment.succeeded", reference: pay.session_id, providerRef: ref, amountCents: 100, currency: "ZAR" })));
    expect((await app.inject({ method: "POST", url: "/webhooks/provider/mock", headers: hook.headers, payload: hook.rawBody })).statusCode).toBe(200);
    expect((await counts(ref)).pay.status).toBe("pending");
    const ev = await h.db.selectFrom("webhook_events").select(["status", "error"]).where("external_id", "=", "evt_short").executeTakeFirstOrThrow();
    expect(ev).toEqual({ status: "failed", error: "amount_mismatch" });
    const audit = await h.db.selectFrom("audit_log").select("action").where("entity_id", "=", pay.id).execute();
    expect(audit.map((a) => a.action)).toContain("payment.amount_mismatch");
  });

  it("claim tokens are single use and expire", async () => {
    await newBill();
    const customer = "27820000005";
    const t = await tap();
    await text(customer, t);
    expect(last(customer).kind).toBe("list");
    await text("27820000006", t);
    expect(body(last("27820000006"))).toContain("expired or was already used");

    const t2 = await tap();
    clock.advance(121_000);
    await text("27820000007", t2);
    expect(body(last("27820000007"))).toContain("expired or was already used");
  });

  it("a second phone sees the bill locked; the first can tap again and carry on", async () => {
    await newBill();
    await text("27820000008", await tap());
    await press("27820000008", "tip_bp_1000");
    await text("27820000009", await tap());
    expect(body(last("27820000009"))).toContain("being paid from another phone");
    await text("27820000008", await tap());
    expect(body(last("27820000008"))).toContain("Pay R550,00");
  });

  it("tapping again after the session timed out restarts the step on the same bill", async () => {
    const bill = await newBill();
    const customer = "27820000020";
    await text(customer, await tap());
    clock.advance(11 * 60_000);
    await text(customer, await tap());
    expect(last(customer).kind).toBe("list");
    expect(wa.messagesTo(customer).some((m) => body(m).includes("expired"))).toBe(false);
    const b = await h.db.selectFrom("bills").select(["status", "customer_id"]).where("id", "=", bill.id).executeTakeFirstOrThrow();
    expect(b.status).toBe("claimed");
    const live = await h.db.selectFrom("sessions").select("status").where("bill_id", "=", bill.id).execute();
    expect(live.map((x) => x.status).sort()).toEqual(["awaiting_tip", "expired"]);
  });

  it("only one of many simultaneous taps claims the bill", async () => {
    const bill = await newBill();
    const phones = Array.from({ length: 20 }, (_, i) => `278300000${String(i).padStart(2, "0")}`);
    const tokens = await Promise.all(phones.map(() => tap()));
    await Promise.all(phones.map((p, i) => text(p, tokens[i]!)));
    const gotBill = phones.filter((p) => last(p).kind === "list");
    expect(gotBill).toHaveLength(1);
    const locked = phones.filter((p) => body(last(p)).includes("being paid from another phone"));
    expect(locked).toHaveLength(19);
    const sessions = await h.db.selectFrom("sessions").select("id").where("bill_id", "=", bill.id).execute();
    expect(sessions).toHaveLength(1);
  });

  it("a redelivered WhatsApp message is handled once", async () => {
    await newBill();
    const customer = "27820000010";
    await text(customer, await tap());
    const id = `wamid.${randomUUID()}`;
    await press(customer, "tip_bp_2000", id);
    await press(customer, "tip_bp_2000", id);
    expect(wa.messagesTo(customer).filter((m) => m.kind === "buttons")).toHaveLength(1);
  });

  it("custom tip: rejects nonsense and over-cap amounts, accepts a valid one", async () => {
    await newBill(10000);
    const customer = "27820000011";
    await text(customer, await tap());
    await press(customer, "tip_custom");
    expect(body(last(customer))).toContain("Type the tip amount");
    for (const bad of ["lots", "0,50", "101"]) {
      await text(customer, bad);
      expect(body(last(customer))).toContain("between R1,00 and R100,00");
    }
    await text(customer, "12,50");
    expect(body(last(customer))).toBe("Pay R112,50 to Demo Surf School?\nBeginner lesson: R100,00\nTip: R12,50");
  });

  it("ignores a tip percentage the merchant did not offer", async () => {
    await newBill();
    const customer = "27820000012";
    await text(customer, await tap());
    await press(customer, "tip_bp_9900");
    expect(last(customer).kind).toBe("list");
  });

  it("failed payment, then Try again with a new reference, then success", async () => {
    const bill = await newBill();
    const customer = "27820000013";
    const ref1 = await payThroughToLink(customer, "tip_none");
    await app.inject({ method: "POST", url: `/mock-checkout/${ref1}`, payload: { outcome: "failed" } });
    expect(body(last(customer))).toContain("did not go through. No money was taken.");
    await press(customer, "try_again");
    expect(body(last(customer))).toContain("Pay R500,00");
    await press(customer, "pay_now");
    const ref2 = checkoutRef(customer);
    expect(ref2).not.toBe(ref1);
    await app.inject({ method: "POST", url: `/mock-checkout/${ref2}`, payload: { outcome: "succeeded" } });
    expect(last(customer).kind).toBe("image");
    expect((await counts(ref1)).pay.status).toBe("failed");
    expect((await counts(ref2)).pay.status).toBe("succeeded");
    expect((await h.db.selectFrom("bills").select("status").where("id", "=", bill.id).executeTakeFirstOrThrow()).status).toBe("paid");
  });

  it("records a late success after the session expired (money was taken)", async () => {
    const bill = await newBill();
    const customer = "27820000014";
    const ref = await payThroughToLink(customer, "tip_none");
    clock.advance(11 * 60_000);
    await text(customer, "hello");
    expect(body(last(customer))).toContain("expired");
    expect((await h.db.selectFrom("bills").select("status").where("id", "=", bill.id).executeTakeFirstOrThrow()).status).toBe("open");
    await app.inject({ method: "POST", url: `/mock-checkout/${ref}`, payload: { outcome: "succeeded" } });
    expect((await counts(ref)).pay.status).toBe("succeeded");
    expect((await h.db.selectFrom("bills").select("status").where("id", "=", bill.id).executeTakeFirstOrThrow()).status).toBe("paid");
    expect(last(customer).kind).toBe("image");
  });

  it("cancel releases the bill for the next tap", async () => {
    const bill = await newBill();
    await text("27820000015", await tap());
    await press("27820000015", "tip_none");
    await press("27820000015", "cancel");
    expect(body(last("27820000015"))).toContain("Cancelled. Nothing was charged.");
    expect((await h.db.selectFrom("bills").select("status").where("id", "=", bill.id).executeTakeFirstOrThrow()).status).toBe("open");
    await text("27820000016", await tap());
    expect(last("27820000016").kind).toBe("list");
  });

  it("no open bill, unknown and revoked tags", async () => {
    await text("27820000017", await tap());
    expect(body(last("27820000017"))).toContain("has no bill ready yet");
    expect((await app.inject({ url: "/t/NOPE-NOPE" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/t/bad code" })).statusCode).toBe(404);
    expect((await app.inject({ url: `/t/${SEED.tags.spare}` })).statusCode).toBe(404); // unassigned
  });

  it("HELP and STOP", async () => {
    await text("27820000018", "help");
    expect(body(last("27820000018"))).toContain("Reply STOP");
    await text("27820000018", "STOP");
    expect(body(last("27820000018"))).toContain("will not get reminders");
    const n = await h.pool.query("select count(*)::int as n from opt_outs o join customers c on c.id = o.customer_id where o.merchant_id is null");
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("never stores phone numbers in plain text", async () => {
    await newBill();
    await text("27820000019", await tap());
    const dump = await h.pool.query("select row_to_json(t)::text as j from (select * from customers) t");
    for (const r of dump.rows) expect(r.j).not.toContain("27820000019");
    const events = await h.pool.query("select payload::text as p from webhook_events");
    for (const r of events.rows) expect(r.p).not.toContain("2782000");
  });
});
