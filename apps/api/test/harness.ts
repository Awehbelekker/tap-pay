import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "vitest";
import { loadConfig, type Config } from "@tappay/config";
import { Crypto, type DbHandle } from "@tappay/db";
import { MockPaymentProvider } from "@tappay/providers";
import { FixedClock, testEnv } from "@tappay/testkit";
import { inboundPayload, sign, type Inbound } from "@tappay/wa-sim";
import { SimWhatsAppClient, type SimMessage } from "@tappay/whatsapp";
import { buildApp } from "../src/app.js";
import type { Tokens } from "../src/auth.js";
import { MemoryPushClient } from "../src/push.js";
import type { PayFlow } from "../src/flow.js";

/**
 * Drives the real HTTP app like a phone would: tap a tag, send WhatsApp messages and button
 * presses (signed like Meta), approve the mock checkout. Shared by the e2e suites.
 */
export class Harness {
  readonly config: Config;
  readonly crypto: Crypto;
  readonly clock = new FixedClock(new Date());
  app!: FastifyInstance;
  wa!: SimWhatsAppClient;
  provider!: MockPaymentProvider;
  push!: MemoryPushClient;
  flow!: PayFlow;

  constructor(
    readonly h: DbHandle,
    url: string,
  ) {
    this.config = loadConfig(testEnv({ DATABASE_URL: url }));
    this.crypto = Crypto.fromConfig(this.config);
  }

  async reset(): Promise<void> {
    await this.app?.close();
    this.clock.set(new Date());
    this.wa = new SimWhatsAppClient();
    this.provider = new MockPaymentProvider({ secret: this.config.MOCK_PROVIDER_SECRET, publicApiUrl: this.config.PUBLIC_API_URL, clock: this.clock, checkoutTtlMinutes: 10 });
    this.push = new MemoryPushClient();
    this.app = buildApp({ config: this.config, db: this.h, queue: { ready: async () => true }, clock: this.clock, wa: this.wa, provider: this.provider, push: this.push });
    await this.app.ready();
    this.flow = (this.app as unknown as { payFlow: PayFlow }).payFlow;
  }

  async close(): Promise<void> {
    await this.app?.close();
  }

  /** Follow a /t/ or /b/ redirect and return the prefilled "PAY XXXXXX" text. */
  async open(path: string): Promise<string> {
    const r = await this.app.inject({ url: path });
    expect(r.statusCode, `${path} should redirect`).toBe(302);
    const text = new URL(r.headers.location as string).searchParams.get("text")!;
    expect(text).toMatch(/^PAY [A-Z2-9]{6}$/);
    return text;
  }

  tap(code: string): Promise<string> {
    return this.open(`/t/${code}`);
  }

  async say(from: string, message: Inbound, messageId = `wamid.${randomUUID()}`): Promise<void> {
    const raw = Buffer.from(JSON.stringify(inboundPayload({ from, profileName: "Test Customer", phoneNumberId: "p", displayNumber: this.config.WA_PHONE_NUMBER, message, messageId })));
    const r = await this.app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(this.config.WA_APP_SECRET, raw) },
      payload: raw,
    });
    expect(r.statusCode).toBe(200);
  }

  text(from: string, t: string) {
    return this.say(from, { kind: "text", text: t });
  }

  press(from: string, id: string) {
    return this.say(from, { kind: "button_reply", id, title: id });
  }

  pick(from: string, id: string) {
    return this.say(from, { kind: "list_reply", id, title: id });
  }

  last(to: string): SimMessage {
    const m = this.wa.messagesTo(to).at(-1);
    expect(m, `no message to ${to}`).toBeDefined();
    return m!;
  }

  body(m: SimMessage): string {
    return "body" in m ? m.body : "caption" in m ? (m.caption ?? "") : "";
  }

  lastBody(to: string): string {
    return this.body(this.last(to));
  }

  /** Ids of the rows or buttons on the last message. */
  options(to: string): string[] {
    const m = this.last(to);
    return m.kind === "list" ? m.rows.map((r) => r.id) : m.kind === "buttons" ? m.buttons.map((b) => b.id) : [];
  }

  checkoutRef(to: string): string {
    const ref = /\/mock-checkout\/(mock_[0-9a-f-]+)/.exec(this.lastBody(to))?.[1];
    expect(ref, `no pay link sent to ${to}`).toBeDefined();
    return ref!;
  }

  async approve(ref: string, outcome: "succeeded" | "failed" = "succeeded"): Promise<void> {
    const r = await this.app.inject({ method: "POST", url: `/mock-checkout/${ref}`, payload: { outcome } });
    expect(r.statusCode).toBe(200);
  }

  /** Press Pay now and approve: returns the checkout ref. */
  async payNow(to: string): Promise<string> {
    await this.press(to, "pay_now");
    const ref = this.checkoutRef(to);
    await this.approve(ref);
    expect(this.last(to).kind, "slip image after payment").toBe("image");
    return ref;
  }

  async billStatus(id: string): Promise<string> {
    return (await this.h.db.selectFrom("bills").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
  }

  // ── Staff (merchant PWA) ──────────────────────────────────────────────────

  /** The sign-in code WhatsApp delivered to this number (sim outbox, template "otp"). */
  lastOtp(msisdn: string): string {
    const m = this.wa.messagesTo(msisdn).filter((x) => x.kind === "template" && x.template === "otp").at(-1);
    expect(m, `no OTP sent to ${msisdn}`).toBeDefined();
    return (m as { params: string[] }).params[0]!;
  }

  /** First sign-in on a new device: OTP by WhatsApp, then set the PIN. */
  async enrol(msisdn: string, pin = "4826", merchantId?: string): Promise<Tokens> {
    const r1 = await this.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { msisdn } });
    expect(r1.statusCode).toBe(202);
    const code = this.lastOtp(msisdn);
    const r2 = await this.app.inject({ method: "POST", url: "/v1/auth/otp/verify", payload: { msisdn, code, pin, ...(merchantId ? { merchantId } : {}) } });
    expect(r2.statusCode, r2.body).toBe(200);
    return r2.json();
  }

  async api(
    token: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ statusCode: number; body: string; json: () => any }> {
    return this.app.inject({ method, url, headers: { authorization: `Bearer ${token}`, ...headers }, ...(payload === undefined ? {} : { payload: payload as never }) });
  }

  /** A second merchant with its own staff member and tag, for the other modes. */
  async addMerchant(i: { name: string; mode: string; noBillAction?: "none" | "ask_amount" | null; staff?: string; staffMsisdn?: string; staffRole?: "owner" | "manager" | "staff"; tagCode: string }) {
    const { db } = this.h;
    const m = await db
      .insertInto("merchants")
      .values({ name: i.name, trading_name: null, vat_number: null, mode: i.mode as never, no_bill_action: i.noBillAction ?? null })
      .returning("id")
      .executeTakeFirstOrThrow();
    let staffId: string | null = null;
    if (i.staff) {
      const num = i.staffMsisdn ?? `2760${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
      staffId = (
        await db
          .insertInto("users")
          .values({ merchant_id: m.id, display_name: i.staff, role: i.staffRole ?? "staff", msisdn_enc: this.crypto.encrypt(num), msisdn_hash: this.crypto.lookupHash(num), pin_hash: null })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    }
    await db.insertInto("tags").values({ merchant_id: m.id, code: i.tagCode, kind: "static", uid: null, assigned_user_id: staffId, label: null, status: "active" }).execute();
    return { merchantId: m.id, staffId };
  }
}
