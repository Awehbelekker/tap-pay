/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@tappay/config";
import { Crypto, SEED, type DbHandle } from "@tappay/db";
import { freshTestDb } from "@tappay/db/testing";
import { testEnv } from "@tappay/testkit";
import { Harness } from "./harness.js";

/**
 * M4 backend acceptance: staff sign-in (WhatsApp code, PIN, lockout, device binding, rotating
 * refresh tokens), the merchant API with tenant isolation and roles, idempotent bill creation,
 * live events over SSE with resume, and alerts delivered once per event per channel.
 */
const url = process.env.TEST_DATABASE_URL;
const COACH = "27600000002"; // seeded: Sipho, staff
const MANAGER = "27600000001"; // seeded: Demo Manager

describe.skipIf(!url)("merchant API, auth and notifications (e2e)", () => {
  let h: DbHandle;
  let t: Harness;
  let other: { merchantId: string; staffId: string | null };

  beforeAll(async () => {
    h = await freshTestDb(url!, Crypto.fromConfig(loadConfig(testEnv())));
    t = new Harness(h, url!);
    other = await t.addMerchant({ name: "Other Shop", mode: "counter", staff: "Olga", staffMsisdn: "27600000099", staffRole: "manager", tagCode: "OTHER-TILL" });
  });
  afterAll(async () => {
    await t?.close();
    await h?.close();
  });
  beforeEach(async () => {
    await h.pool.query("update bills set status = 'cancelled' where status in ('open','claimed')");
    await h.pool.query("update users set pin_hash = null, pin_failures = 0, pin_locked_until = null, notify_mute = false, active = true");
    await h.pool.query("delete from otp_codes");
    await h.pool.query("update devices set push_subscription = null");
    await t.reset();
  });

  // ── Auth ───────────────────────────────────────────────────────────────────

  describe("sign-in", () => {
    it("first sign-in: WhatsApp code, then a PIN that is not trivial", async () => {
      await t.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { msisdn: "060 000 0002" } });
      const code = t.lastOtp(COACH);
      expect(code).toMatch(/^\d{6}$/);
      const verify = (pin?: string) => t.app.inject({ method: "POST", url: "/v1/auth/otp/verify", payload: { msisdn: COACH, code, ...(pin ? { pin } : {}) } });
      expect((await verify()).json()).toMatchObject({ code: "pin_required" });
      expect((await verify("1234")).json()).toMatchObject({ code: "weak_pin" });
      expect((await verify("7777")).json()).toMatchObject({ code: "weak_pin" });
      const ok = await verify("4826");
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), deviceId: expect.any(String), expiresIn: 900 });
      // The code is single use.
      expect((await verify("4826")).statusCode).toBe(401);
    });

    it("never reveals whether a number is staff, and never stores or logs the code", async () => {
      const r = await t.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { msisdn: "27829999999" } });
      expect(r.statusCode).toBe(202);
      expect(t.wa.messagesTo("27829999999")).toHaveLength(0);
      await t.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { msisdn: COACH } });
      const code = t.lastOtp(COACH);
      const rows = await h.pool.query("select row_to_json(o)::text as j from otp_codes o");
      for (const row of rows.rows) expect(row.j).not.toContain(code);
    });

    it("rate limits code requests to 3 per 15 minutes", async () => {
      for (let i = 0; i < 5; i++) await t.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { msisdn: COACH } });
      expect(t.wa.messagesTo(COACH).filter((m) => m.kind === "template")).toHaveLength(3);
    });

    it("a code dies after 5 wrong tries", async () => {
      await t.app.inject({ method: "POST", url: "/v1/auth/otp/request", payload: { msisdn: COACH } });
      const code = t.lastOtp(COACH);
      const wrong = code === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i++) await t.app.inject({ method: "POST", url: "/v1/auth/otp/verify", payload: { msisdn: COACH, code: wrong, pin: "4826" } });
      expect((await t.app.inject({ method: "POST", url: "/v1/auth/otp/verify", payload: { msisdn: COACH, code, pin: "4826" } })).statusCode).toBe(401);
    });

    it("PIN login on an enrolled device; 5 wrong PINs lock it for 15 minutes", async () => {
      const first = await t.enrol(COACH);
      const login = (pin: string, deviceId = first.deviceId) => t.app.inject({ method: "POST", url: "/v1/auth/login", payload: { msisdn: COACH, pin, deviceId } });
      expect((await login("4826")).statusCode).toBe(200);
      expect((await login("4826", randomUUID())).json()).toMatchObject({ code: "unknown_device" });
      for (let i = 0; i < 4; i++) expect((await login("0000")).statusCode).toBe(401);
      expect((await login("0000")).statusCode).toBe(423);
      expect((await login("4826")).statusCode).toBe(423); // locked even with the right PIN
      t.clock.advance(15 * 60_000 + 1000);
      expect((await login("4826")).statusCode).toBe(200);
    });

    it("a refresh retried within 30 s (lost response on a weak signal) still works", async () => {
      const a = await t.enrol(COACH);
      const refresh = (rt: string) => t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: rt } });
      expect((await refresh(a.refreshToken)).statusCode).toBe(200); // response "lost"
      t.clock.advance(10_000);
      const retry = await refresh(a.refreshToken);
      expect(retry.statusCode).toBe(200);
      expect((await refresh(retry.json().refreshToken)).statusCode).toBe(200);
    });

    it("refresh tokens rotate; re-using an old one after 30 s revokes the whole family", async () => {
      const a = await t.enrol(COACH);
      const b = (await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: a.refreshToken } })).json();
      expect(b.refreshToken).not.toBe(a.refreshToken);
      t.clock.advance(31_000);
      expect((await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: a.refreshToken } })).statusCode).toBe(401);
      // The thief's reuse also kills the legitimate newer token.
      expect((await t.app.inject({ method: "POST", url: "/v1/auth/refresh", payload: { refreshToken: b.refreshToken } })).statusCode).toBe(401);
    });

    it("access ends at once when staff are deactivated or the phone is revoked", async () => {
      const a = await t.enrol(COACH);
      expect((await t.api(a.accessToken, "GET", "/v1/merchant/me")).statusCode).toBe(200);
      await h.pool.query("update devices set revoked_at = now() where id = $1", [a.deviceId]);
      expect((await t.api(a.accessToken, "GET", "/v1/merchant/me")).statusCode).toBe(401);
      await h.pool.query("update devices set revoked_at = null where id = $1", [a.deviceId]);
      await h.pool.query("update users set active = false where id = $1", [SEED.coachId]);
      expect((await t.api(a.accessToken, "GET", "/v1/merchant/me")).statusCode).toBe(401);
    });

    it("rejects missing, tampered and expired access tokens", async () => {
      const a = await t.enrol(COACH);
      expect((await t.app.inject({ url: "/v1/merchant/me" })).statusCode).toBe(401);
      const [hdr, body, sig] = a.accessToken.split(".");
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), role: "owner" })).toString("base64url");
      expect((await t.api(`${hdr}.${forged}.${sig}`, "GET", "/v1/merchant/me")).statusCode).toBe(401);
      t.clock.advance(16 * 60_000);
      expect((await t.api(a.accessToken, "GET", "/v1/merchant/me")).statusCode).toBe(401);
    });
  });

  // ── Bills over the API ─────────────────────────────────────────────────────

  describe("bills", () => {
    it("staff create a bill from a service on their tag; Idempotency-Key makes a retry safe", async () => {
      const coach = await t.enrol(COACH);
      const services = (await t.api(coach.accessToken, "GET", "/v1/merchant/services")).json().items;
      const lesson = services.find((s: any) => s.name === "Beginner lesson");
      const key = randomUUID();
      const make = () => t.api(coach.accessToken, "POST", "/v1/merchant/bills", { serviceId: lesson.id, tagCode: SEED.tags.coach, customerMsisdn: "082 123 4567" }, { "idempotency-key": key });
      const [r1, r2] = [await make(), await make()];
      expect(r1.statusCode).toBe(201);
      expect(r2.json().id).toBe(r1.json().id);
      expect(r1.json()).toMatchObject({ status: "open", subtotalCents: 50000, tagCode: SEED.tags.coach, billCode: expect.stringMatching(/^\d{4}$/), link: expect.stringMatching(/\/b\//) });
      const n = await h.pool.query("select count(*)::int n from bills where status = 'open' and merchant_id = $1", [SEED.merchantId]);
      expect(n.rows[0].n).toBe(1);
    });

    it("a tag holds one claimable bill at a time", async () => {
      const coach = await t.enrol(COACH);
      const body = { lines: [{ description: "Lesson", amountCents: 10000 }], tagCode: SEED.tags.till };
      expect((await t.api(coach.accessToken, "POST", "/v1/merchant/bills", body)).statusCode).toBe(201);
      expect((await t.api(coach.accessToken, "POST", "/v1/merchant/bills", body)).json()).toMatchObject({ code: "tag_busy" });
    });

    it("validates input", async () => {
      const coach = await t.enrol(COACH);
      for (const bad of [{}, { lines: [] }, { lines: [{ description: "x", amountCents: -5 }] }, { lines: [{ description: "x", amountCents: 1.5 }] }, { serviceId: randomUUID(), lines: [{ description: "x", amountCents: 100 }] }]) {
        expect((await t.api(coach.accessToken, "POST", "/v1/merchant/bills", bad)).statusCode).toBe(422);
      }
    });

    it("edit, release and cancel over the API act on the live bill", async () => {
      const coach = await t.enrol(COACH);
      const bill = (await t.api(coach.accessToken, "POST", "/v1/merchant/bills", { lines: [{ description: "Lesson", amountCents: 50000 }], tagCode: SEED.tags.coach })).json();
      const c = "27823000001";
      await t.text(c, await t.tap(SEED.tags.coach));
      expect((await t.api(coach.accessToken, "GET", `/v1/merchant/bills/${bill.id}`)).json()).toMatchObject({ status: "claimed", maskedCustomer: "***001", customerName: "Test" });
      expect((await t.api(coach.accessToken, "PATCH", `/v1/merchant/bills/${bill.id}`, { lines: [{ description: "Private lesson", amountCents: 90000 }] })).json()).toMatchObject({ subtotalCents: 90000 });
      expect(t.lastBody(c)).toContain("Private lesson: R900,00");
      expect((await t.api(coach.accessToken, "POST", `/v1/merchant/bills/${bill.id}/release`)).json()).toMatchObject({ status: "open" });
      expect((await t.api(coach.accessToken, "POST", `/v1/merchant/bills/${bill.id}/cancel`)).json()).toMatchObject({ status: "cancelled" });
      expect((await t.api(coach.accessToken, "POST", `/v1/merchant/bills/${bill.id}/cancel`)).statusCode).toBe(409);
    });

    it("staff see only their own bills; managers see all", async () => {
      const coach = await t.enrol(COACH);
      const mgr = await t.enrol(MANAGER);
      const mine = (await t.api(coach.accessToken, "POST", "/v1/merchant/bills", { lines: [{ description: "Mine", amountCents: 1000 }], tagCode: SEED.tags.coach })).json();
      const theirs = (await t.api(mgr.accessToken, "POST", "/v1/merchant/bills", { lines: [{ description: "Desk", amountCents: 2000 }], tagCode: SEED.tags.till })).json();
      const coachIds = (await t.api(coach.accessToken, "GET", "/v1/merchant/bills?status=open")).json().items.map((b: any) => b.id);
      const mgrIds = (await t.api(mgr.accessToken, "GET", "/v1/merchant/bills?status=open")).json().items.map((b: any) => b.id);
      expect(coachIds).toEqual([mine.id]);
      expect(mgrIds.sort()).toEqual([mine.id, theirs.id].sort());
      expect((await t.api(coach.accessToken, "GET", `/v1/merchant/bills/${theirs.id}`)).statusCode).toBe(404);
      expect((await t.api(coach.accessToken, "POST", `/v1/merchant/bills/${theirs.id}/cancel`)).statusCode).toBe(404);
    });

    it("only managers assign or revoke tags and see staff", async () => {
      const coach = await t.enrol(COACH);
      const mgr = await t.enrol(MANAGER);
      expect((await t.api(coach.accessToken, "PUT", `/v1/merchant/tags/${SEED.tags.spare}`, { assignedUserId: SEED.coachId })).statusCode).toBe(403);
      expect((await t.api(coach.accessToken, "GET", "/v1/merchant/staff")).statusCode).toBe(403);
      expect((await t.api(mgr.accessToken, "PUT", `/v1/merchant/tags/${SEED.tags.spare.toLowerCase()}`, { assignedUserId: SEED.coachId, label: "Spare band" })).statusCode).toBe(200);
      const tags = (await t.api(coach.accessToken, "GET", "/v1/merchant/tags")).json().items;
      expect(tags.find((x: any) => x.code === SEED.tags.spare)).toMatchObject({ status: "active", assignedName: "Sipho", label: "Spare band" });
      const staff = (await t.api(mgr.accessToken, "GET", "/v1/merchant/staff")).json().items;
      expect(staff.map((s: any) => s.maskedNumber).sort()).toEqual(["***001", "***002"]);
      await t.api(mgr.accessToken, "POST", `/v1/merchant/tags/${SEED.tags.spare}/revoke`);
      expect((await t.app.inject({ url: `/t/${SEED.tags.spare}` })).statusCode).toBe(404);
      await h.pool.query("update tags set status = 'unassigned', assigned_user_id = null, label = null where code = $1", [SEED.tags.spare]);
    });
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────

  it("another merchant's manager gets 404 for every merchant endpoint that takes an id", async () => {
    const coach = await t.enrol(COACH);
    const olga = await t.enrol("27600000099");
    const bill = (await t.api(coach.accessToken, "POST", "/v1/merchant/bills", { lines: [{ description: "Lesson", amountCents: 1000 }], tagCode: SEED.tags.coach })).json();
    const svc = (await t.api(coach.accessToken, "GET", "/v1/merchant/services")).json().items[0];
    const probes: [string, string, unknown?][] = [
      ["GET", `/v1/merchant/bills/${bill.id}`],
      ["PATCH", `/v1/merchant/bills/${bill.id}`, { lines: [{ description: "x", amountCents: 1 }] }],
      ["POST", `/v1/merchant/bills/${bill.id}/cancel`],
      ["POST", `/v1/merchant/bills/${bill.id}/release`],
      ["PUT", `/v1/merchant/tags/${SEED.tags.coach}`, { assignedUserId: null }],
      ["POST", `/v1/merchant/tags/${SEED.tags.coach}/revoke`],
      ["POST", "/v1/merchant/bills", { serviceId: svc.id }],
      ["POST", "/v1/merchant/bills", { lines: [{ description: "x", amountCents: 100 }], tagCode: SEED.tags.coach }],
    ];
    for (const [method, path, body] of probes) {
      const r = await t.api(olga.accessToken, method as any, path, body);
      expect(r.statusCode, `${method} ${path}`).toBe(404);
    }
    const lists = ["/v1/merchant/bills", "/v1/merchant/tags", "/v1/merchant/services", "/v1/merchant/staff"];
    for (const path of lists) {
      const body = JSON.stringify((await t.api(olga.accessToken, "GET", path)).json());
      expect(body, path).not.toContain(bill.id);
      expect(body, path).not.toContain(SEED.tags.coach);
      expect(body, path).not.toContain("Sipho");
    }
    expect((await t.api(coach.accessToken, "GET", `/v1/merchant/bills/${bill.id}`)).json().status).toBe("open");
    void other;
  });

  // ── Notifications ──────────────────────────────────────────────────────────

  describe("alerts", () => {
    const sub = (n: string) => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: "BNc", auth: "x" } });

    async function paidBill(customer: string) {
      await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: SEED.tags.coach, lines: [{ description: "Beginner lesson", amountCents: 50000 }] });
      await t.text(customer, await t.tap(SEED.tags.coach));
      await t.pick(customer, "tip_bp_1000");
      await t.press(customer, "pay_now");
      return t.checkoutRef(customer);
    }

    it("coach gets one push, manager (no push) gets one WhatsApp, even when the webhook repeats", async () => {
      const coach = await t.enrol(COACH);
      await t.enrol(MANAGER);
      await t.api(coach.accessToken, "PUT", "/v1/merchant/devices/current/push", { subscription: sub("coach") });
      const ref = await paidBill("27824000001");
      const r = await t.app.inject({ method: "POST", url: `/mock-checkout/${ref}`, payload: { outcome: "succeeded", repeat: 3 } });
      expect(r.json().webhookStatuses).toEqual([200, 200, 200]);

      expect(t.push.sent).toHaveLength(1);
      expect(t.push.sent[0]).toMatchObject({ endpoint: "https://push.example/coach", payload: { title: "Demo Surf School: paid R550,00", kind: "paid" } });
      expect((t.push.sent[0]!.payload as any).body).toBe("Paid R500,00 (Beginner lesson) + R50,00 tip. Your share R50,00. Customer Test, ending 001.");
      const wa = t.wa.messagesTo(MANAGER).filter((m) => m.kind === "template" && m.template === "merchant_paid_alert");
      expect(wa).toHaveLength(1);
      expect((wa[0] as any).params).toEqual(["Test, ending 001", "R500,00", "R50,00", "Demo Surf School", "R550,00"]);
      expect(t.wa.messagesTo(COACH).filter((m) => m.kind === "template" && m.template !== "otp")).toHaveLength(0);
      const rows = await h.pool.query("select channel, status, count(*)::int n from notifications group by 1, 2 order by 1, 2");
      expect(rows.rows).toEqual([
        { channel: "push", status: "sent", n: 1 },
        { channel: "push", status: "skipped", n: 1 },
        { channel: "whatsapp", status: "sent", n: 1 },
      ]);
      await h.pool.query("delete from notifications");
    });

    it("push that fails falls back to WhatsApp; a gone subscription is forgotten; muted staff get nothing", async () => {
      const coach = await t.enrol(COACH);
      await t.api(coach.accessToken, "PUT", "/v1/merchant/devices/current/push", { subscription: sub("gone") });
      t.push.gone.add("https://push.example/gone");
      await h.pool.query("update merchants set notify_managers = 'off' where id = $1", [SEED.merchantId]);
      await t.approve(await paidBill("27824000002"));
      expect(t.wa.messagesTo(COACH).filter((m) => m.kind === "template" && m.template === "merchant_paid_alert")).toHaveLength(1);
      const dev = await h.pool.query("select push_subscription from devices where id = $1", [coach.deviceId]);
      expect(dev.rows[0].push_subscription).toBeNull();

      await t.api(coach.accessToken, "PUT", "/v1/merchant/me/settings", { muted: true });
      const before = t.wa.outbox.length;
      await t.approve(await paidBill("27824000003"));
      expect(t.wa.outbox.slice(before).filter((m) => m.to === COACH)).toHaveLength(0);
      await h.pool.query("update merchants set notify_managers = 'each_payment' where id = $1", [SEED.merchantId]);
      await h.pool.query("delete from notifications");
    });

    it("a failed payment alerts the staff member only", async () => {
      const coach = await t.enrol(COACH);
      await t.api(coach.accessToken, "PUT", "/v1/merchant/devices/current/push", { subscription: sub("coach2") });
      await t.approve(await paidBill("27824000004"), "failed");
      expect(t.push.sent.map((p) => (p.payload as any).kind)).toEqual(["failed"]);
      expect(t.wa.messagesTo(MANAGER).filter((m) => m.kind === "template" && m.template !== "otp")).toHaveLength(0);
      await h.pool.query("delete from notifications");
    });

    it("today's totals", async () => {
      const coach = await t.enrol(COACH);
      await t.approve(await paidBill("27824000005"));
      const r = (await t.api(coach.accessToken, "GET", "/v1/merchant/reports/today")).json();
      expect(r.count).toBeGreaterThanOrEqual(1);
      expect(r.tipCents).toBeGreaterThanOrEqual(5000);
      await h.pool.query("delete from notifications");
    });
  });

  // ── Live events (SSE over a real socket) ───────────────────────────────────

  describe("live events", () => {
    async function openStream(token: string, lastEventId?: number) {
      if (!t.app.server.listening) await t.app.listen({ port: 0, host: "127.0.0.1" });
      const port = (t.app.server.address() as AddressInfo).port;
      const ctrl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/v1/merchant/events`, {
        headers: { authorization: `Bearer ${token}`, ...(lastEventId !== undefined ? { "last-event-id": String(lastEventId) } : {}) },
        signal: ctrl.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/event-stream");
      const reader = res.body!.getReader();
      const events: { id: number; event: string; data: any }[] = [];
      let buf = "";
      const pump = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buf += Buffer.from(value).toString("utf8");
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const f = Object.fromEntries(block.split("\n").filter((l) => /^(id|event|data):/.test(l)).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
              if (f.event) events.push({ id: Number(f.id), event: f.event, data: JSON.parse(f.data ?? "{}") });
            }
          }
        } catch {
          /* aborted */
        }
      })();
      const waitFor = async (pred: () => boolean, ms = 5000) => {
        const until = Date.now() + ms;
        while (!pred()) {
          if (Date.now() > until) throw new Error(`timed out; got ${events.map((e) => e.event).join(",")}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      };
      return { events, waitFor, close: async () => (ctrl.abort(), await pump) };
    }

    it("the PWA sees created, claimed and paid within moments, and resumes from Last-Event-ID", async () => {
      const mgr = await t.enrol(MANAGER);
      const s = await openStream(mgr.accessToken);
      const bill = await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: SEED.tags.coach, lines: [{ description: "Beginner lesson", amountCents: 50000 }] });
      const c = "27825000001";
      await t.text(c, await t.tap(SEED.tags.coach));
      await t.pick(c, "tip_none");
      const started = Date.now();
      await t.payNow(c);
      await s.waitFor(() => s.events.some((e) => e.event === "bill.paid"));
      expect(Date.now() - started).toBeLessThan(5000); // SPEC 20: paid to merchant under 5 s
      expect(s.events.filter((e) => e.data.billId === bill.bill.id).map((e) => e.event)).toEqual(["bill.created", "bill.claimed", "bill.paid"]);
      expect(s.events.find((e) => e.event === "bill.paid")!.data).toMatchObject({ totalCents: 50000, customer: "Test, ending 001" });
      const claimedId = s.events.find((e) => e.event === "bill.claimed")!.id;
      await s.close();

      const again = await openStream(mgr.accessToken, claimedId);
      await again.waitFor(() => again.events.some((e) => e.event === "bill.paid"));
      expect(again.events.map((e) => e.event)).toEqual(["bill.paid"]);
      await again.close();
    });

    it("staff streams carry only their own bills", async () => {
      const coach = await t.enrol(COACH);
      const s = await openStream(coach.accessToken);
      const theirs = await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.managerId, tagCode: SEED.tags.till, lines: [{ description: "Desk", amountCents: 1000 }] });
      const mine = await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: SEED.tags.coach, lines: [{ description: "Mine", amountCents: 1000 }] });
      await s.waitFor(() => s.events.some((e) => e.data.billId === mine.bill.id));
      expect(s.events.some((e) => e.data.billId === theirs.bill.id)).toBe(false);
      await s.close();
    });

    it("another merchant's stream sees nothing of ours", async () => {
      const olga = await t.enrol("27600000099");
      const s = await openStream(olga.accessToken);
      await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: SEED.tags.coach, lines: [{ description: "Mine", amountCents: 1000 }] });
      await t.flow.createBill({ merchantId: other.merchantId, createdBy: null, tagCode: "OTHER-TILL", lines: [{ description: "Theirs", amountCents: 1000 }] });
      await s.waitFor(() => s.events.length >= 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(s.events.every((e) => e.event === "bill.created")).toBe(true);
      expect(s.events).toHaveLength(1);
      await s.close();
    });
  });
});
