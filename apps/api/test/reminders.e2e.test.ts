/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@tappay/config";
import { inWindow, sastDay } from "@tappay/core";
import { Crypto, SEED, type DbHandle } from "@tappay/db";
import { freshTestDb } from "@tappay/db/testing";
import { testEnv } from "@tappay/testkit";
import type { SimMessage } from "@tappay/whatsapp";
import { Harness } from "./harness.js";

/**
 * M7 acceptance, with time travel through the injected Clock: a bill left unpaid becomes
 * `abandoned`, gets at most 3 reminders, at most 1 per day, never outside 08:00 to 20:00 SAST,
 * and none after it is paid or the customer replies STOP. Then `needs_follow_up` in the
 * merchant's Unpaid list, where staff send a reminder, mark it paid another way, or write it off.
 */
const url = process.env.TEST_DATABASE_URL;
const COACH = "27600000002";
const MANAGER = "27600000001";
const sast = (s: string) => new Date(`${s}+02:00`);

describe.skipIf(!url)("unpaid bills and reminders (e2e)", () => {
  let h: DbHandle;
  let t: Harness;
  let seq = 0;

  beforeAll(async () => {
    h = await freshTestDb(url!, Crypto.fromConfig(loadConfig(testEnv())));
    t = new Harness(h, url!);
  });
  afterAll(async () => {
    await t?.close();
    await h?.close();
  });
  beforeEach(async () => {
    await h.pool.query("update bills set status = 'cancelled' where status in ('open','claimed','abandoned','needs_follow_up')");
    await h.pool.query("update reminders set status = 'cancelled' where status = 'scheduled'");
    await h.pool.query("update sessions set closed_at = now() where closed_at is null");
    await h.pool.query("delete from otp_codes");
    await h.pool.query("update merchants set reminder_count = 3, reminder_first_delay_minutes = 10, reminder_window_start = 8, reminder_window_end = 20");
    await h.pool.query("update services set reminders_enabled = true");
    await t.reset();
  });

  const customer = () => `2782700${String(++seq).padStart(4, "0")}`;
  const billStatus = (id: string) => t.billStatus(id);
  const templates = (to: string) => t.wa.messagesTo(to).filter((m): m is Extract<SimMessage, { kind: "template" }> => m.kind === "template" && m.template.startsWith("reminder_"));
  const sentRows = (billId: string) => h.db.selectFrom("reminders").select(["seq", "sent_at", "template", "status"]).where("bill_id", "=", billId).where("status", "=", "sent").orderBy("seq").execute();

  /** Advance time in steps, running the two every-minute jobs as the scheduler would. */
  async function travel(totalMinutes: number, stepMinutes = 15) {
    for (let m = 0; m < totalMinutes; m += stepMinutes) {
      t.clock.advance(stepMinutes * 60_000);
      await t.flow.sweepExpiredSessions();
      await t.flow.reminders.runDue();
    }
  }

  /** A bill addressed to `to` on the coach's tag; the customer opens it, picks no tip, and leaves. */
  async function addressedAndLeft(to: string, amountCents = 50000) {
    const b = await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: SEED.tags.coach, lines: [{ description: "Beginner lesson", amountCents }], customerMsisdn: to });
    await t.text(to, await t.tap(SEED.tags.coach));
    await t.pick(to, "tip_none");
    expect(t.last(to).kind).toBe("buttons"); // confirm, never pressed
    return b.bill.id as string;
  }

  async function staffToken(msisdn: string, pin = "4826") {
    return (await t.enrol(msisdn, pin)).accessToken;
  }

  it("3 reminders on 3 different days, all inside 08:00 to 20:00, then the follow-up list", async () => {
    t.clock.set(sast("2026-10-05T19:45:00"));
    const to = customer();
    const billId = await addressedAndLeft(to);
    await travel(11, 1);
    expect(await billStatus(billId)).toBe("abandoned");
    // Addressed by the merchant: no "may we share your number" question.
    expect(t.wa.messagesTo(to).some((m) => m.kind === "buttons" && m.body.includes("see your number"))).toBe(false);

    await travel(5 * 24 * 60);
    const rows = await sentRows(billId);
    expect(rows.map((r) => r.template)).toEqual(["reminder_1", "reminder_2", "reminder_3"]);
    for (const r of rows) expect(inWindow(r.sent_at!)).toBe(true);
    expect(new Set(rows.map((r) => sastDay(r.sent_at!))).size).toBe(3);
    // Abandoned at 19:56: the 10-minute reminder would land at 20:06, so it waits for 08:00.
    const eight = sast("2026-10-06T08:00:00").getTime();
    expect(rows[0]!.sent_at!.getTime()).toBeGreaterThanOrEqual(eight);
    expect(rows[0]!.sent_at!.getTime()).toBeLessThan(eight + 15 * 60_000); // the job's next run
    expect(await billStatus(billId)).toBe("needs_follow_up");

    const sent = templates(to);
    expect(sent).toHaveLength(3);
    const [amount, merchant, link] = sent[0]!.params;
    expect([amount, merchant]).toEqual(["R500,00", "Demo Surf School"]);
    expect(link).toMatch(/\/b\/[A-Za-z0-9_-]+$/);

    // Nothing more, however long we wait.
    await travel(7 * 24 * 60, 60);
    expect(templates(to)).toHaveLength(3);

    // The link in the reminder still works after the bill's usual expiry: pay it.
    const path = new URL(link!).pathname;
    await t.text(to, await t.open(path));
    await t.pick(to, "tip_none");
    await t.payNow(to);
    expect(await billStatus(billId)).toBe("paid");
  });

  it("paid after the first reminder: no more reminders", async () => {
    t.clock.set(sast("2026-10-07T10:00:00"));
    const to = customer();
    const billId = await addressedAndLeft(to);
    await travel(30, 1);
    expect(templates(to).map((m) => m.template)).toEqual(["reminder_1"]);
    await t.text(to, await t.open(new URL(templates(to)[0]!.params[2]!).pathname));
    await t.pick(to, "tip_bp_1000");
    await t.payNow(to);
    expect(await billStatus(billId)).toBe("paid");
    await travel(5 * 24 * 60, 30);
    expect(templates(to)).toHaveLength(1);
    expect((await h.db.selectFrom("reminders").select("status").where("bill_id", "=", billId).where("status", "=", "scheduled").execute()).length).toBe(0);
  });

  it("STOP ends this merchant's reminders at once; STOP ALL ends everyone's", async () => {
    t.clock.set(sast("2026-10-07T10:00:00"));
    const to = customer();
    const billId = await addressedAndLeft(to);
    await travel(30, 1);
    expect(templates(to)).toHaveLength(1);
    await t.text(to, "stop");
    expect(t.lastBody(to)).toBe("Done. Demo Surf School will not send you reminders. Reply STOP ALL to stop reminders from every business.");
    await travel(5 * 24 * 60, 30);
    expect(templates(to)).toHaveLength(1);
    expect(await billStatus(billId)).toBe("abandoned");
    const opt = await h.pool.query("select merchant_id from opt_outs o join customers c on c.id = o.customer_id where o.merchant_id is not null");
    expect(opt.rows.map((r) => r.merchant_id)).toContain(SEED.merchantId);

    // The Unpaid list flags them, and the merchant cannot remind them any more.
    const manager = await staffToken(MANAGER, "5937");
    const item = (await t.api(manager, "GET", "/v1/merchant/unpaid")).json().items.find((x: any) => x.id === billId);
    expect(item).toMatchObject({ optedOut: true, remindersSent: 1, nextReminderAt: null });
    expect((await t.api(manager, "POST", `/v1/merchant/bills/${billId}/remind`)).json().code).toBe("opted_out");

    const other = customer();
    await t.text(other, "STOP ALL");
    expect(t.lastBody(other)).toBe("Done. You will not get reminders from us.");
    const global = await h.pool.query("select count(*)::int n from opt_outs where merchant_id is null");
    expect(global.rows[0].n).toBeGreaterThan(0);
  });

  it("a walk-up customer who only looked releases the bill; one who pressed Pay now owes it and is asked to share their number", async () => {
    t.clock.set(sast("2026-10-07T10:00:00"));
    const looker = customer();
    const b1 = await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: SEED.tags.coach, lines: [{ description: "Board hire", amountCents: 15000 }] });
    await t.text(looker, await t.tap(SEED.tags.coach));
    await travel(11, 1);
    expect(await billStatus(b1.bill.id)).toBe("open");
    expect(templates(looker)).toHaveLength(0);

    const payer = customer();
    await t.text(payer, await t.tap(SEED.tags.coach));
    await t.pick(payer, "tip_none");
    await t.press(payer, "pay_now");
    expect(t.lastBody(payer)).toContain("If it stays unpaid we may remind you. Reply STOP to opt out.");
    await travel(30, 1);
    expect(await billStatus(b1.bill.id)).toBe("abandoned");
    const ask = t.wa.messagesTo(payer).find((m) => m.kind === "buttons" && m.body.includes("May Demo Surf School see your number")) as any;
    expect(ask.body).toBe("Your bill of R150,00 at Demo Surf School is still open. May Demo Surf School see your number to contact you about it? We do not share it otherwise.");

    const coach = await staffToken(COACH);
    const masked = (await t.api(coach, "GET", "/v1/merchant/unpaid")).json().items.find((x: any) => x.id === b1.bill.id);
    expect(masked.customer).toMatchObject({ maskedNumber: expect.stringMatching(/^\*\*\*\d{3}$/), number: null });
    await t.press(payer, ask.buttons[0].id);
    expect(t.lastBody(payer)).toBe("Thanks. Demo Surf School can see your number for this bill.");
    const shared = (await t.api(coach, "GET", "/v1/merchant/unpaid")).json().items.find((x: any) => x.id === b1.bill.id);
    expect(shared.customer.number).toBe(payer);
    // The tag is free for the next customer.
    await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: SEED.tags.coach, lines: [{ description: "Wax", amountCents: 3000 }] });
  });

  it("a failed payment left alone: abandoned after the retry time, first reminder about 10 minutes after the failure", async () => {
    t.clock.set(sast("2026-10-07T10:00:00"));
    const to = customer();
    const billId = await addressedAndLeft(to);
    await t.press(to, "pay_now");
    await t.approve(t.checkoutRef(to), "failed");
    const failedAt = t.clock.now();
    await travel(9, 1);
    expect(await billStatus(billId)).toBe("claimed"); // still time to press Try again
    await travel(3, 1);
    expect(await billStatus(billId)).toBe("abandoned");
    const first = (await sentRows(billId))[0]!;
    expect((first.sent_at!.getTime() - failedAt.getTime()) / 60_000).toBeLessThanOrEqual(11);
  });

  describe("merchant actions", () => {
    it("Send reminder: now if allowed, else queued for the next allowed moment; counts toward the cap", async () => {
      t.clock.set(sast("2026-10-07T10:00:00"));
      const to = customer();
      const billId = await addressedAndLeft(to);
      await travel(11, 1); // abandoned; first reminder planned for 10 minutes later
      const coach = await staffToken(COACH);
      const r1 = await t.api(coach, "POST", `/v1/merchant/bills/${billId}/remind`);
      expect(r1.statusCode).toBe(200);
      expect(r1.json().status).toBe("sent");
      expect(templates(to).map((m) => m.template)).toEqual(["reminder_1"]);
      // A second one today waits for tomorrow 08:00.
      const r2 = await t.api(coach, "POST", `/v1/merchant/bills/${billId}/remind`);
      expect(r2.statusCode).toBe(202);
      expect(new Date(r2.json().dueAt).toISOString()).toBe(sast("2026-10-08T08:00:00").toISOString());
      expect(templates(to)).toHaveLength(1);

      t.clock.set(sast("2026-10-08T08:01:00"));
      await t.flow.reminders.runDue();
      expect(templates(to).map((m) => m.template)).toEqual(["reminder_1", "reminder_2"]);

      // Third (and last) one the next day, then the cap.
      t.clock.set(sast("2026-10-09T09:30:00"));
      const coach2 = await staffToken(COACH);
      expect((await t.api(coach2, "POST", `/v1/merchant/bills/${billId}/remind`)).json().status).toBe("sent");
      expect(templates(to).map((m) => m.template)).toEqual(["reminder_1", "reminder_2", "reminder_3"]);
      expect(await billStatus(billId)).toBe("needs_follow_up");
      const capped = await t.api(coach2, "POST", `/v1/merchant/bills/${billId}/remind`);
      expect(capped.statusCode).toBe(429);
      expect(capped.json().code).toBe("reminder_cap");
    });

    it("mark paid another way needs a reason and stops reminders; write-off is for managers", async () => {
      t.clock.set(sast("2026-10-07T10:00:00"));
      const a = customer();
      const billA = await addressedAndLeft(a);
      const b = customer();
      const billB = await addressedAndLeft(b);
      await travel(11, 1);
      const coach = await staffToken(COACH);
      const manager = await staffToken(MANAGER, "5937");
      const list = (await t.api(coach, "GET", "/v1/merchant/unpaid")).json().items.map((x: any) => x.id);
      expect(list).toEqual(expect.arrayContaining([billA, billB]));

      expect((await t.api(coach, "POST", `/v1/merchant/bills/${billA}/mark-paid-other`, {})).json().code).toBe("reason_required");
      expect((await t.api(coach, "POST", `/v1/merchant/bills/${billA}/mark-paid-other`, { reason: "Paid cash" })).statusCode).toBe(200);
      expect(await billStatus(billA)).toBe("paid_other");

      expect((await t.api(coach, "POST", `/v1/merchant/bills/${billB}/write-off`, { reason: "Gone" })).statusCode).toBe(403);
      expect((await t.api(manager, "POST", `/v1/merchant/bills/${billB}/write-off`, { reason: "Customer left town" })).statusCode).toBe(200);
      expect(await billStatus(billB)).toBe("written_off");
      expect((await t.api(manager, "POST", `/v1/merchant/bills/${billB}/write-off`, { reason: "again" })).statusCode).toBe(409);

      await travel(5 * 24 * 60, 60);
      expect(templates(a)).toHaveLength(0);
      expect(templates(b)).toHaveLength(0);
      const audit = await h.pool.query("select detail->>'reason' r from audit_log where action = 'bill.paid_other' and entity_id = $1", [billA]);
      expect(audit.rows[0].r).toBe("Paid cash");
    });

    it("settings: 0 reminders sends none and goes straight to follow-up; the window cannot be widened", async () => {
      const manager = await staffToken(MANAGER, "5937");
      expect((await t.api(manager, "PATCH", "/v1/merchant/settings", { reminderWindowStart: 7 })).statusCode).toBe(422);
      expect((await t.api(manager, "PATCH", "/v1/merchant/settings", { reminderWindowStart: 15, reminderWindowEnd: 12 })).json().code).toBe("bad_window");
      expect((await t.api(manager, "PATCH", "/v1/merchant/settings", { reminderCount: 0 })).statusCode).toBe(200);
      expect((await t.api(manager, "GET", "/v1/merchant/settings")).json()).toMatchObject({ reminderCount: 0, reminderWindowStart: 8, reminderWindowEnd: 20 });

      const to = customer();
      const billId = await addressedAndLeft(to);
      await travel(3 * 24 * 60, 60);
      expect(await billStatus(billId)).toBe("needs_follow_up");
      expect(templates(to)).toHaveLength(0);
    });
  });
});
