/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@tappay/config";
import { Crypto, SEED, type DbHandle } from "@tappay/db";
import { freshTestDb } from "@tappay/db/testing";
import { testEnv } from "@tappay/testkit";
import type { Tokens } from "../src/auth.js";
import { Money } from "../src/money.js";
import { Harness } from "./harness.js";

/**
 * M5 acceptance: split rules (merchant default and per service), the tip pool, ledger lines
 * that always sum to the payment, append-only ledger, full and partial refunds that reverse
 * the split (idempotent), chargebacks, balances, and payouts that never pay twice (ledger_only
 * manual payouts and collect_then_payout through the provider, including a failed payout).
 * The split maths is property-tested in packages/core/test/split.test.ts.
 */
const url = process.env.TEST_DATABASE_URL;
const COACH = "27600000002";
const MANAGER = "27600000001";

describe.skipIf(!url)("money: splits, refunds, payouts (e2e)", () => {
  let h: DbHandle;
  let t: Harness;
  let coach: Tokens;
  let manager: Tokens;
  let customerSeq = 0;

  beforeAll(async () => {
    h = await freshTestDb(url!, Crypto.fromConfig(loadConfig(testEnv())));
    t = new Harness(h, url!);
    await t.reset();
    coach = await t.enrol(COACH);
    manager = await t.enrol(MANAGER, "5937");
  });
  afterAll(async () => {
    await t?.close();
    await h?.close();
  });
  beforeEach(async () => {
    await h.pool.query("update bills set status = 'cancelled' where status in ('open','claimed')");
    await h.pool.query("update split_rules set active = false");
    await h.pool.query("update shifts set ends_at = now() where ends_at is null");
    await h.pool.query("update merchants set tip_rule = 'direct', tip_house_cut_bp = 0, fee_policy = 'proportional', payout_threshold_cents = 10000");
    await t.reset();
  });

  const lessonId = async () => (await t.api(coach.accessToken, "GET", "/v1/merchant/services")).json().items.find((s: any) => s.name === "Beginner lesson").id as string;

  /** The coach bills on their tag; a customer taps, picks a tip and pays. Returns the payment. */
  async function pay(opts: { serviceId?: string; amountCents?: number; tip?: string } = {}) {
    if (opts.serviceId) {
      const b = await t.api(coach.accessToken, "POST", "/v1/merchant/bills", { serviceId: opts.serviceId, tagCode: SEED.tags.coach });
      expect(b.statusCode, b.body).toBe(201);
    } else {
      // Straight through the flow, so tests that move the clock forward days need no fresh token.
      await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: SEED.tags.coach, lines: [{ description: "Lesson", amountCents: opts.amountCents ?? 50000 }] });
    }
    const customer = `2782500${String(++customerSeq).padStart(4, "0")}`;
    await t.text(customer, await t.tap(SEED.tags.coach));
    await t.pick(customer, opts.tip ?? "tip_bp_1000");
    const ref = await t.payNow(customer);
    const p = await h.db.selectFrom("payments").selectAll().where("provider_ref", "=", ref).executeTakeFirstOrThrow();
    return { ...p, customer, ref };
  }

  const lines = (paymentId: string) =>
    h.db.selectFrom("ledger_entries").select(["kind", "party_kind", "party_user_id", "amount_cents", "reverses"]).where("payment_id", "=", paymentId).orderBy("id").execute();
  const credit = (l: { kind: string; amount_cents: number }) => (l.kind === "sale" || l.kind === "tip") && l.amount_cents > 0;
  const sum = (xs: { amount_cents: number }[]) => xs.reduce((a, x) => a + x.amount_cents, 0);

  function expectBalanced(ls: { kind: string; amount_cents: number }[], amount: number, fee: number) {
    expect(sum(ls.filter(credit))).toBe(amount);
    expect(sum(ls.filter((l) => l.kind === "fee"))).toBe(-fee);
  }

  describe("split rules", () => {
    it("only managers set rules, and a scope cannot go over 100%", async () => {
      const rules = { rules: [{ serviceId: null, staffUserId: null, basisPoints: 7000 }] };
      expect((await t.api(coach.accessToken, "PUT", "/v1/merchant/split-rules", rules)).statusCode).toBe(403);
      const over = await t.api(manager.accessToken, "PUT", "/v1/merchant/split-rules", { rules: [...rules.rules, { serviceId: null, staffUserId: SEED.coachId, basisPoints: 4000 }] });
      expect(over.statusCode).toBe(422);
      expect(over.json().code).toBe("over_100");
      expect((await t.api(manager.accessToken, "PUT", "/v1/merchant/split-rules", { rules: [{ serviceId: null, staffUserId: randomUUID(), basisPoints: 100 }] })).statusCode).toBe(404);
      expect((await t.api(manager.accessToken, "PUT", "/v1/merchant/split-rules", rules)).statusCode).toBe(200);
      expect((await t.api(coach.accessToken, "GET", "/v1/merchant/split-rules")).json().items).toEqual([{ id: expect.any(String), serviceId: null, staffUserId: null, basisPoints: 7000 }]);
    });

    it("SPEC example: R500 lesson + R50 tip, coach 70% of the sale plus the tip; lines sum to the payment", async () => {
      await t.api(manager.accessToken, "PUT", "/v1/merchant/split-rules", { rules: [{ serviceId: null, staffUserId: null, basisPoints: 7000 }] });
      const p = await pay();
      expect(p.amount_cents).toBe(55000);
      const ls = await lines(p.id);
      expect(ls.filter(credit).map((l) => [l.kind, l.party_kind, l.amount_cents])).toEqual(
        expect.arrayContaining([
          ["sale", "staff", 35000],
          ["sale", "merchant", 15000],
          ["tip", "staff", 5000],
        ]),
      );
      expectBalanced(ls, 55000, p.provider_fee_cents ?? 0);
      // Fee shared in proportion: coach credited 40000 of 55000.
      expect(ls.find((l) => l.kind === "fee" && l.party_kind === "staff")!.amount_cents).toBe(-Math.floor(((p.provider_fee_cents ?? 0) * 40000) / 55000));
    });

    it("a service's own rule wins over the merchant default; the merchant can absorb the fee", async () => {
      const svc = await lessonId();
      await t.api(manager.accessToken, "PUT", "/v1/merchant/split-rules", {
        rules: [
          { serviceId: null, staffUserId: null, basisPoints: 7000 },
          { serviceId: svc, staffUserId: null, basisPoints: 5000 },
        ],
      });
      expect((await t.api(manager.accessToken, "PATCH", "/v1/merchant/settings", { feePolicy: "merchant_absorbs" })).statusCode).toBe(200);
      const p = await pay({ serviceId: svc, tip: "tip_none" });
      const ls = await lines(p.id);
      expect(ls.find((l) => l.kind === "sale" && l.party_kind === "staff")!.amount_cents).toBe(25000);
      expect(ls.filter((l) => l.kind === "fee").map((l) => l.party_kind)).toEqual(["merchant"]);
      expectBalanced(ls, 50000, p.provider_fee_cents ?? 0);
    });

    it("tip pool: no shift running holds tips in the pool; a shift splits them by weight", async () => {
      await t.api(manager.accessToken, "PATCH", "/v1/merchant/settings", { tipRule: "pool" });
      const p1 = await pay({ amountCents: 10000 });
      expect((await lines(p1.id)).filter((l) => l.kind === "tip")).toEqual([expect.objectContaining({ party_kind: "pool", amount_cents: 1000 })]);

      expect((await t.api(coach.accessToken, "POST", "/v1/merchant/shifts", { members: [{ userId: SEED.coachId }] })).statusCode).toBe(403);
      const s = await t.api(manager.accessToken, "POST", "/v1/merchant/shifts", { members: [{ userId: SEED.coachId, weight: 2 }, { userId: SEED.managerId, weight: 1 }] });
      expect(s.statusCode).toBe(201);
      expect((await t.api(coach.accessToken, "GET", "/v1/merchant/shifts/current")).json().members).toHaveLength(2);
      const p2 = await pay({ amountCents: 10000 });
      const tips = (await lines(p2.id)).filter((l) => l.kind === "tip" && l.amount_cents > 0);
      expect(Object.fromEntries(tips.map((l) => [l.party_user_id ?? l.party_kind, l.amount_cents]))).toEqual({ [SEED.coachId]: 666, [SEED.managerId]: 333, merchant: 1 });
      expect((await t.api(manager.accessToken, "POST", "/v1/merchant/shifts/current/end")).statusCode).toBe(200);
      expect((await t.api(manager.accessToken, "GET", "/v1/merchant/shifts/current")).statusCode).toBe(404);
    });

    it("house cut: the business keeps its share of each tip", async () => {
      await t.api(manager.accessToken, "PATCH", "/v1/merchant/settings", { tipRule: "house_cut", tipHouseCutBp: 2000 });
      const p = await pay();
      const tips = (await lines(p.id)).filter((l) => l.kind === "tip");
      expect(tips.map((l) => [l.party_kind, l.amount_cents])).toEqual(expect.arrayContaining([["staff", 4000], ["merchant", 1000]]));
    });
  });

  it("the ledger is append-only: no update, delete or truncate", async () => {
    const p = await pay({ amountCents: 1000, tip: "tip_none" });
    await expect(h.pool.query("update ledger_entries set amount_cents = 1 where payment_id = $1", [p.id])).rejects.toThrow();
    await expect(h.pool.query("delete from ledger_entries where payment_id = $1", [p.id])).rejects.toThrow();
    await expect(h.pool.query("truncate ledger_entries cascade")).rejects.toThrow();
    expectBalanced(await lines(p.id), 1000, p.provider_fee_cents ?? 0);
  });

  describe("refunds", () => {
    const refund = (paymentId: string, body: object, key: string | null = randomUUID(), token = manager.accessToken) =>
      t.api(token, "POST", `/v1/merchant/payments/${paymentId}/refund`, body, key ? { "idempotency-key": key } : {});

    it("partial then full refund reverses the split in proportion, idempotently, and tells the customer", async () => {
      await t.api(manager.accessToken, "PUT", "/v1/merchant/split-rules", { rules: [{ serviceId: null, staffUserId: null, basisPoints: 7000 }] });
      const p = await pay();
      expect((await refund(p.id, { reason: "lesson cut short" }, null)).statusCode).toBe(400);
      expect((await refund(p.id, { amountCents: 100, reason: "nope" }, randomUUID(), coach.accessToken)).statusCode).toBe(403);
      expect((await refund(p.id, { amountCents: 60000, reason: "too much" })).json().code).toBe("too_much");

      const key = randomUUID();
      const r1 = await refund(p.id, { amountCents: 11000, reason: "lesson cut short" }, key);
      expect(r1.statusCode, r1.body).toBe(200);
      expect(r1.json()).toMatchObject({ amountCents: 11000, status: "succeeded" });
      const again = await refund(p.id, { amountCents: 11000, reason: "lesson cut short" }, key);
      expect(again.json().id).toBe(r1.json().id);
      let ls = await lines(p.id);
      const rev = ls.filter((l) => l.kind === "refund");
      expect(sum(rev)).toBe(-11000);
      // 20% refunded: coach sale 35000 -> 7000, coach tip 5000 -> 1000, shop sale 15000 -> 3000.
      expect(rev.map((l) => [l.reverses, l.party_kind, l.amount_cents])).toEqual(expect.arrayContaining([["sale", "staff", -7000], ["tip", "staff", -1000], ["sale", "merchant", -3000]]));
      let pay2 = await h.db.selectFrom("payments").select(["status", "refunded_cents"]).where("id", "=", p.id).executeTakeFirstOrThrow();
      expect(pay2).toEqual({ status: "partially_refunded", refunded_cents: 11000 });
      expect(t.lastBody(p.customer)).toBe("R110,00 was refunded by Demo Surf School. It can take a few days to show.");

      const r2 = await refund(p.id, { reason: "customer unhappy" });
      expect(r2.json()).toMatchObject({ amountCents: 44000, status: "succeeded" });
      ls = await lines(p.id);
      for (const c of ls.filter(credit)) {
        const back = ls.filter((l) => l.kind === "refund" && l.reverses === c.kind && l.party_kind === c.party_kind && l.party_user_id === c.party_user_id);
        expect(sum(back), `${c.kind} ${c.party_kind}`).toBe(-c.amount_cents);
      }
      pay2 = await h.db.selectFrom("payments").select(["status", "refunded_cents"]).where("id", "=", p.id).executeTakeFirstOrThrow();
      expect(pay2).toEqual({ status: "refunded", refunded_cents: 55000 });
      const session = await h.db.selectFrom("sessions").select("status").where("id", "=", p.session_id).executeTakeFirstOrThrow();
      expect(session.status).toBe("refunded");
      expect((await refund(p.id, { reason: "again" })).json().code).toBe("not_refundable");
      // The coach saw the payment list with the refund.
      const listed = (await t.api(coach.accessToken, "GET", "/v1/merchant/payments")).json().items.find((x: any) => x.id === p.id);
      expect(listed).toMatchObject({ status: "refunded", refundedCents: 55000, amountCents: 55000 });
    });

    it("another merchant cannot refund our payment", async () => {
      const other = await t.addMerchant({ name: "Elsewhere", mode: "counter", staff: "Eve", staffMsisdn: "27600000077", staffRole: "manager", tagCode: "ELSE-TILL" });
      const eve = await t.enrol("27600000077", "5937", other.merchantId);
      const p = await pay({ amountCents: 2000 });
      expect((await refund(p.id, { reason: "not mine" }, randomUUID(), eve.accessToken)).statusCode).toBe(404);
    });

    it("a chargeback reverses everything once, even if the notice repeats", async () => {
      const p = await pay({ amountCents: 20000 });
      const hook = t.provider.chargeback(p.ref);
      for (let i = 0; i < 2; i++) {
        const r = await t.app.inject({ method: "POST", url: "/webhooks/provider/mock", headers: hook.headers, payload: hook.rawBody });
        expect(r.statusCode).toBe(200);
      }
      const ls = await lines(p.id);
      expect(sum(ls.filter((l) => l.kind === "refund"))).toBe(-22000);
      const flagged = await h.pool.query("select count(*)::int n from audit_log where action = 'merchant.flagged_chargeback' and entity_id = $1", [p.id]);
      expect(flagged.rows[0].n).toBe(1);
    });
  });

  describe("balances and payouts", () => {
    async function settle() {
      // Clear everyone's balance so each test starts from zero (payouts are ledger debits).
      const m = new Money({ config: t.config, db: h.db, crypto: t.crypto, provider: t.provider, clock: t.clock, log: t.app.log });
      for (const b of await m.balances(SEED.merchantId)) {
        if (b.partyKind === "staff" && b.balanceCents !== 0) {
          await h.db.insertInto("ledger_entries").values({ merchant_id: SEED.merchantId, payment_id: null, payout_id: null, kind: "adjustment", party_kind: "staff", party_user_id: b.userId, amount_cents: -b.balanceCents, note: "test reset", refund_id: null, reverses: null }).execute();
        }
      }
    }

    it("staff see their own balance, managers see everyone's; a run pays once per day above the threshold", async () => {
      await settle();
      await pay({ amountCents: 50000, tip: "tip_bp_2000" }); // coach tip R100
      const mine = (await t.api(coach.accessToken, "GET", "/v1/merchant/balances")).json().items;
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ partyKind: "staff", userId: SEED.coachId, tipCents: expect.any(Number) });
      const all = (await t.api(manager.accessToken, "GET", "/v1/merchant/balances")).json().items;
      expect(all.map((b: any) => b.partyKind)).toContain("merchant");
      const owed = mine[0].balanceCents;
      expect(owed).toBeGreaterThan(9000); // R100 less a share of the fee

      // Below the threshold nothing is created.
      await t.api(manager.accessToken, "PATCH", "/v1/merchant/settings", { payoutThresholdCents: 20000 });
      expect((await t.api(manager.accessToken, "POST", "/v1/merchant/payouts/run")).json()).toEqual({ created: 0, sent: 0, failed: 0 });
      await t.api(manager.accessToken, "PATCH", "/v1/merchant/settings", { payoutThresholdCents: 5000 });
      expect((await t.api(coach.accessToken, "POST", "/v1/merchant/payouts/run")).statusCode).toBe(403);
      const [r1, r2] = await Promise.all([t.api(manager.accessToken, "POST", "/v1/merchant/payouts/run"), t.api(manager.accessToken, "POST", "/v1/merchant/payouts/run")]);
      expect(r1.json().created + r2.json().created).toBe(1);
      const payouts = (await t.api(coach.accessToken, "GET", "/v1/merchant/payouts")).json().items;
      expect(payouts[0]).toMatchObject({ userId: SEED.coachId, amountCents: owed, status: "pending", method: "manual" });
      expect((await t.api(coach.accessToken, "GET", "/v1/merchant/balances")).json().items[0].balanceCents).toBe(0);

      // More tips the same day wait for tomorrow's run (one payout per person per day).
      await pay({ amountCents: 50000, tip: "tip_bp_2000" });
      expect((await t.api(manager.accessToken, "POST", "/v1/merchant/payouts/run")).json().created).toBe(0);

      // The manager pays by EFT and records it; the coach is told on WhatsApp (no push).
      expect((await t.api(coach.accessToken, "POST", `/v1/merchant/payouts/${payouts[0].id}/mark-paid`)).statusCode).toBe(403);
      expect((await t.api(manager.accessToken, "POST", `/v1/merchant/payouts/${payouts[0].id}/mark-paid`)).statusCode).toBe(200);
      expect((await t.api(manager.accessToken, "POST", `/v1/merchant/payouts/${payouts[0].id}/mark-paid`)).statusCode).toBe(409);
      const note = t.wa.messagesTo(COACH).filter((m) => m.kind === "template" && m.template === "staff_tip_payout");
      expect(note).toHaveLength(1);
      expect((note[0] as any).params[1]).toBe("Demo Surf School");
    });

    it("collect_then_payout sends through the provider; a refused payout puts the money back", async () => {
      await settle();
      // The manager records where the coach's payouts go (stored encrypted, never returned).
      expect((await t.api(manager.accessToken, "PUT", `/v1/merchant/staff/${SEED.coachId}/payout-destination`, { ref: "recipient-sipho" })).statusCode).toBe(200);
      const dest = (await h.db.selectFrom("users").select("payout_dest_enc").where("id", "=", SEED.coachId).executeTakeFirstOrThrow()).payout_dest_enc;
      expect(t.crypto.decrypt(dest!)).toBe("recipient-sipho");
      t.clock.set(new Date(t.clock.now().getTime() + 2 * 86_400_000)); // a later day than the run above
      const m = new Money({ config: { ...t.config, SPLIT_STRATEGY: "collect_then_payout" }, db: h.db, crypto: t.crypto, provider: t.provider, clock: t.clock, log: t.app.log, alerts: (t.app as any).notifier });
      await h.db.updateTable("users").set({ payout_dest_enc: null }).where("id", "=", SEED.coachId).execute();
      await h.pool.query("update merchants set payout_threshold_cents = 1000");
      await pay({ amountCents: 30000, tip: "tip_bp_2000" });
      const owed = (await m.balances(SEED.merchantId, SEED.coachId))[0]!.balanceCents;

      // No destination on file: the payout fails and the balance is restored.
      expect(await m.runPayouts(SEED.merchantId)).toEqual({ created: 1, sent: 0, failed: 1 });
      expect((await m.balances(SEED.merchantId, SEED.coachId))[0]!.balanceCents).toBe(owed);
      const failed = await h.db.selectFrom("payouts").select(["status", "failure_reason"]).where("party_user_id", "=", SEED.coachId).orderBy("created_at", "desc").executeTakeFirstOrThrow();
      expect(failed).toEqual({ status: "failed", failure_reason: "no_payout_destination" });

      // Next day, with the destination back on file: sent once, and the coach is told.
      await h.db.updateTable("users").set({ payout_dest_enc: dest }).where("id", "=", SEED.coachId).execute();
      t.clock.set(new Date(t.clock.now().getTime() + 86_400_000));
      const before = t.wa.messagesTo(COACH).length;
      expect(await m.runAllPayouts()).toMatchObject({ created: 1, sent: 1, failed: 0 });
      expect(await m.runPayouts(SEED.merchantId)).toEqual({ created: 0, sent: 0, failed: 0 });
      expect(t.provider.payoutsSent.filter((x) => x.to === "recipient-sipho")).toEqual([{ to: "recipient-sipho", amount: owed, reference: expect.any(String) }]);
      expect((await m.balances(SEED.merchantId, SEED.coachId))[0]!.balanceCents).toBe(0);
      expect(t.wa.messagesTo(COACH).slice(before).filter((x) => x.kind === "template" && x.template === "staff_tip_payout")).toHaveLength(1);

      // The provider refusing (destination "fail...") also restores the balance.
      await h.db.updateTable("users").set({ payout_dest_enc: t.crypto.encrypt("fail-closed-account") }).where("id", "=", SEED.coachId).execute();
      await pay({ amountCents: 30000, tip: "tip_bp_2000" });
      t.clock.set(new Date(t.clock.now().getTime() + 86_400_000));
      const owed2 = (await m.balances(SEED.merchantId, SEED.coachId))[0]!.balanceCents;
      expect(await m.runPayouts(SEED.merchantId)).toEqual({ created: 1, sent: 0, failed: 1 });
      expect((await m.balances(SEED.merchantId, SEED.coachId))[0]!.balanceCents).toBe(owed2);
    });
  });
});
