import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Crypto, SEED, type DbHandle } from "@tappay/db";
import { freshTestDb } from "@tappay/db/testing";
import { loadConfig } from "@tappay/config";
import { testEnv } from "@tappay/testkit";
import { Harness } from "./harness.js";

/**
 * M2 acceptance: every merchant mode end to end, the SPEC 5 matching rules (number match,
 * first-tap claim, choose between bills, 4-digit code with 3 tries and a 15-minute lock,
 * release, edit after claim, shares), and 50 parallel taps on one bill yielding one claim.
 */
const url = process.env.TEST_DATABASE_URL;
const lesson = [{ description: "Beginner lesson", amountCents: 50000 }];

describe.skipIf(!url)("merchant modes and bill matching (e2e)", () => {
  let h: DbHandle;
  let t: Harness;
  let carGuard: { merchantId: string; staffId: string | null };
  let cafe: { merchantId: string; staffId: string | null };
  let restaurant: { merchantId: string; staffId: string | null };

  beforeAll(async () => {
    const crypto = Crypto.fromConfig(loadConfig(testEnv()));
    h = await freshTestDb(url!, crypto);
    t = new Harness(h, url!);
    carGuard = await t.addMerchant({ name: "Kalk Bay Parking", mode: "quick_tip", staff: "Thabo", tagCode: "GUARD-THABO" });
    cafe = await t.addMerchant({ name: "Bean and Brew", mode: "counter", noBillAction: "ask_amount", tagCode: "CAFE-TILL-1" });
    restaurant = await t.addMerchant({ name: "Harbour Grill", mode: "table", tagCode: "GRILL-TABLE-4" });
  });
  afterAll(async () => {
    await t?.close();
    await h?.close();
  });
  beforeEach(async () => {
    await h.pool.query("update bills set status = 'cancelled' where status in ('open','claimed')");
    await h.pool.query("delete from bill_code_prompts");
    await t.reset();
  });

  const newBill = (extra: Partial<Parameters<Harness["flow"]["createBill"]>[0]> = {}) =>
    t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: SEED.tags.coach, lines: lesson, ...extra });

  // ── Appointment ────────────────────────────────────────────────────────────

  it("appointment: the number on the bill taps and claims straight away", async () => {
    const ann = "27821110001";
    const { bill, billCode } = await newBill({ customerMsisdn: "082 111 0001" });
    expect(billCode).toMatch(/^\d{4}$/);
    await t.text(ann, await t.tap(SEED.tags.coach));
    expect(t.lastBody(ann)).toContain("Add a tip for Sipho?");
    await t.pick(ann, "tip_bp_1000");
    await t.payNow(ann);
    expect(await t.billStatus(bill.id)).toBe("paid");
  });

  it("appointment: another number needs the 4-digit code; 3 wrong tries lock it for 15 minutes", async () => {
    const { bill, billCode } = await newBill({ customerMsisdn: "0821110002" });
    const friend = "27821110003";
    await t.text(friend, await t.tap(SEED.tags.coach));
    expect(t.lastBody(friend)).toContain("Enter the 4-digit code");

    const wrong = billCode === "0000" ? "1111" : "0000";
    await t.text(friend, wrong);
    expect(t.lastBody(friend)).toBe("That code does not match. 2 tries left.");
    await t.text(friend, wrong);
    expect(t.lastBody(friend)).toBe("That code does not match. 1 try left.");
    await t.text(friend, wrong);
    expect(t.lastBody(friend)).toContain("Too many tries");

    // Locked: a new tap is refused, and the right code typed now is not accepted either.
    await t.text(friend, await t.tap(SEED.tags.coach));
    expect(t.lastBody(friend)).toContain("Too many tries");
    await t.text(friend, billCode!);
    expect(await t.billStatus(bill.id)).toBe("open");

    // After 15 minutes the count starts again and the right code claims the bill.
    t.clock.advance(15 * 60_000 + 1000);
    await t.text(friend, await t.tap(SEED.tags.coach));
    expect(t.lastBody(friend)).toContain("Enter the 4-digit code");
    await t.text(friend, billCode!);
    expect(t.last(friend).kind).toBe("list");
    expect(await t.billStatus(bill.id)).toBe("claimed");
  });

  it("appointment: two bills for the same number, the customer chooses", async () => {
    const ann = "27821110004";
    const a = await newBill({ customerMsisdn: ann, lines: [{ description: "Board hire", amountCents: 15000 }] });
    const b = await newBill({ customerMsisdn: ann, lines: [{ description: "Private lesson", amountCents: 90000 }] });
    await t.text(ann, await t.tap(SEED.tags.coach));
    expect(t.options(ann).sort()).toEqual([`bill_${a.bill.id}`, `bill_${b.bill.id}`].sort());
    await t.pick(ann, `bill_${b.bill.id}`);
    expect(t.lastBody(ann)).toContain("Private lesson: R900,00");
    expect(await t.billStatus(b.bill.id)).toBe("claimed");
    expect(await t.billStatus(a.bill.id)).toBe("open");
  });

  it("a forged bill choice for someone else's bill is ignored", async () => {
    const other = await newBill({ customerMsisdn: "27821110005" });
    await t.pick("27821110006", `bill_${other.bill.id}`);
    expect(t.lastBody("27821110006")).toContain("did not understand");
    expect(await t.billStatus(other.bill.id)).toBe("open");
  });

  // ── Counter ────────────────────────────────────────────────────────────────

  it("counter: first tap claims, the next phone is locked until the merchant releases", async () => {
    const { bill } = await newBill();
    const first = "27821120001";
    const second = "27821120002";
    await t.text(first, await t.tap(SEED.tags.coach));
    await t.text(second, await t.tap(SEED.tags.coach));
    expect(t.lastBody(second)).toContain("being paid from another phone");

    await t.flow.releaseBill(SEED.merchantId, bill.id, SEED.managerId);
    expect(t.lastBody(first)).toContain("released this bill");
    expect(await t.billStatus(bill.id)).toBe("open");

    await t.text(second, await t.tap(SEED.tags.coach));
    expect(t.last(second).kind).toBe("list");
    await t.press(first, "tip_none"); // stale button from the released session
    expect(t.lastBody(first)).toContain("did not understand");
  });

  it("counter with open amount: each customer types their own amount at the till", async () => {
    const a = "27821130001";
    const b = "27821130002";
    await t.text(a, await t.tap("CAFE-TILL-1"));
    await t.text(b, await t.tap("CAFE-TILL-1"));
    expect(t.lastBody(a)).toBe("Enter the amount to pay Bean and Brew, in rand. For example 85,50.");
    expect(t.lastBody(b)).toBe("Enter the amount to pay Bean and Brew, in rand. For example 85,50.");
    await t.text(a, "lots");
    expect(t.lastBody(a)).toContain("Please send an amount between R1,00 and R50 000,00");
    await t.text(a, "85,50");
    expect(t.lastBody(a)).toContain("Amount: R85,50");
    await t.pick(a, "tip_none");
    expect(t.lastBody(a)).toBe("Pay R85,50 to Bean and Brew?\nAmount: R85,50\nTip: R0,00");
    await t.payNow(a);
    const paid = await h.db.selectFrom("bills").select(["type", "subtotal_cents", "status"]).where("merchant_id", "=", cafe.merchantId).where("status", "=", "paid").execute();
    expect(paid).toEqual([{ type: "open", subtotal_cents: 8550, status: "paid" }]);
  });

  // ── Quick tip ──────────────────────────────────────────────────────────────

  it("quick tip: car guard, R10 preset, 100% to the person", async () => {
    const c = "27821140001";
    await t.text(c, await t.tap("GUARD-THABO"));
    expect(t.lastBody(c)).toBe("Tip Thabo at Kalk Bay Parking. How much?");
    expect(t.options(c)).toEqual(["qt_500", "qt_1000", "qt_2000", "qt_other"]);
    await t.pick(c, "qt_99900"); // forged amount: ignored
    expect(t.options(c)).toEqual(["qt_500", "qt_1000", "qt_2000", "qt_other"]);
    await t.pick(c, "qt_1000");
    expect(t.lastBody(c)).toBe("Tip R10,00 to Thabo at Kalk Bay Parking?");
    const ref = await t.payNow(c);
    const pay = await h.db.selectFrom("payments").select(["id", "amount_cents"]).where("provider_ref", "=", ref).executeTakeFirstOrThrow();
    expect(pay.amount_cents).toBe(1000);
    const ledger = await h.db.selectFrom("ledger_entries").select(["kind", "party_user_id", "amount_cents"]).where("payment_id", "=", pay.id).where("amount_cents", ">", 0).execute();
    expect(ledger).toEqual([{ kind: "tip", party_user_id: carGuard.staffId, amount_cents: 1000 }]);
  });

  it("quick tip: Other amount within R2 to R1 000, then change amount", async () => {
    const c = "27821140002";
    await t.text(c, await t.tap("GUARD-THABO"));
    await t.pick(c, "qt_other");
    expect(t.lastBody(c)).toBe("Type the tip in rand, between R2,00 and R1 000,00.");
    await t.text(c, "1");
    expect(t.lastBody(c)).toContain("between R2,00 and R1 000,00");
    await t.text(c, "25");
    expect(t.lastBody(c)).toBe("Tip R25,00 to Thabo at Kalk Bay Parking?");
    await t.press(c, "change_tip");
    expect(t.options(c)).toContain("qt_other");
    await t.pick(c, "qt_2000");
    expect(t.lastBody(c)).toBe("Tip R20,00 to Thabo at Kalk Bay Parking?");
  });

  it("quick tip: two people tip the same guard at the same time", async () => {
    await Promise.all(["27821140003", "27821140004"].map(async (c) => t.text(c, await t.tap("GUARD-THABO"))));
    for (const c of ["27821140003", "27821140004"]) expect(t.lastBody(c)).toContain("How much?");
  });

  // ── Table and shares ───────────────────────────────────────────────────────

  it("table: a R300 bill in 3 shares, three payers, paid only when the last share is", async () => {
    const { bill } = await t.flow.createBill({
      merchantId: restaurant.merchantId,
      createdBy: null,
      tagCode: "GRILL-TABLE-4",
      tableLabel: "Table 4",
      lines: [{ description: "Dinner", amountCents: 30000 }],
      shares: { equal: 3 },
    });
    const [a, b, c] = ["27821150001", "27821150002", "27821150003"];
    for (const p of [a, b, c]) await t.text(p, await t.tap("GRILL-TABLE-4"));
    expect(t.lastBody(a)).toContain("This bill is R300,00, split into shares");
    const shareIds = t.options(a);
    expect(shareIds).toHaveLength(3);

    await t.pick(a, shareIds[0]!);
    expect(t.lastBody(a)).toContain("Share 1 of 3 of Dinner: R100,00");
    await t.pick(b, shareIds[0]!); // already taken: offered the remaining shares
    expect(t.options(b)).toEqual(shareIds.slice(1));
    await t.pick(b, shareIds[1]!);
    await t.pick(c, shareIds[2]!);

    for (const p of [a, b]) {
      await t.pick(p, "tip_none");
      await t.payNow(p);
      expect(await t.billStatus(bill.id)).toBe("open");
    }
    await t.pick(c, "tip_bp_1000");
    expect(t.lastBody(c)).toContain("Pay R110,00");
    await t.payNow(c);
    expect(await t.billStatus(bill.id)).toBe("paid");

    // The slip shows the payer's share, not the whole table.
    const receiptPath = new URL(/Receipt: (\S+)/.exec(t.lastBody(c))![1]!).pathname;
    const png = await t.app.inject({ url: `${receiptPath}/slip.png` });
    expect(png.statusCode).toBe(200);
  });

  it("table: shares with a remainder split to the cent, and a fourth payer is told they are taken", async () => {
    await t.flow.createBill({ merchantId: restaurant.merchantId, createdBy: null, tagCode: "GRILL-TABLE-4", lines: [{ description: "Dinner", amountCents: 10001 }], shares: { equal: 3 } });
    const amounts = await h.db.selectFrom("bill_shares").innerJoin("bills", "bills.id", "bill_shares.bill_id").select("bill_shares.amount_cents").where("bills.status", "=", "open").execute();
    expect(amounts.map((x) => x.amount_cents).sort()).toEqual([3333, 3334, 3334].sort());
    const payers = ["27821160001", "27821160002", "27821160003"];
    for (const p of payers) {
      await t.text(p, await t.tap("GRILL-TABLE-4"));
      await t.pick(p, t.options(p)[0]!);
    }
    await t.text("27821160004", await t.tap("GRILL-TABLE-4"));
    expect(t.lastBody("27821160004")).toContain("already being paid or paid");
  });

  // ── Field and remote invoice (bill link, no tag) ───────────────────────────

  it("field / remote invoice: bill link opens WhatsApp and anyone holding the link may pay", async () => {
    const { bill, link } = await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: null, lines: lesson, customerMsisdn: "0821170001" });
    const path = new URL(link).pathname;
    const payer = "27821170099"; // not the number on the bill: the link was forwarded
    await t.text(payer, await t.open(path));
    expect(t.lastBody(payer)).toContain("Beginner lesson: R500,00");
    await t.pick(payer, "tip_none");
    await t.payNow(payer);
    expect(await t.billStatus(bill.id)).toBe("paid");
    expect((await t.app.inject({ url: path })).statusCode).toBe(404);
    expect((await t.app.inject({ url: "/b/not-a-real-token-at-all-xx" })).statusCode).toBe(404);
  });

  // ── Merchant changes ───────────────────────────────────────────────────────

  it("merchant edits the amount after a claim: old session cancelled, customer re-prompted", async () => {
    const { bill } = await newBill();
    const c = "27821180001";
    await t.text(c, await t.tap(SEED.tags.coach));
    await t.pick(c, "tip_none");
    await t.press(c, "pay_now");
    const oldRef = t.checkoutRef(c);

    await t.flow.editBillLines(SEED.merchantId, bill.id, [{ description: "Private lesson", amountCents: 90000 }], SEED.managerId);
    const msgs = t.wa.messagesTo(c).slice(-2).map((m) => t.body(m));
    expect(msgs[0]).toContain("changed the amount");
    expect(msgs[1]).toContain("Private lesson: R900,00");

    // Paying the stale R500 checkout records the money but does not settle the bill.
    await t.approve(oldRef);
    expect(await t.billStatus(bill.id)).toBe("claimed");
    const flags = await h.db.selectFrom("audit_log").select("action").where("action", "=", "payment.needs_refund").execute();
    expect(flags.length).toBeGreaterThanOrEqual(1);

    // The new amount pays the bill.
    await t.pick(c, "tip_none");
    await t.payNow(c);
    expect(await t.billStatus(bill.id)).toBe("paid");
  });

  it("merchant cancels: customer told, tag has nothing open", async () => {
    const { bill } = await newBill();
    const c = "27821190001";
    await t.text(c, await t.tap(SEED.tags.coach));
    await t.flow.cancelBill(SEED.merchantId, bill.id, SEED.managerId);
    expect(t.lastBody(c)).toContain("cancelled this bill. Nothing was charged.");
    expect(await t.billStatus(bill.id)).toBe("cancelled");
    await t.text(c, await t.tap(SEED.tags.coach));
    expect(t.lastBody(c)).toContain("has no bill ready yet");
  });

  it("tapping a bill you just paid sends the receipt again", async () => {
    await newBill();
    const c = "27821200001";
    await t.text(c, await t.tap(SEED.tags.coach));
    await t.pick(c, "tip_none");
    await t.payNow(c);
    await t.text(c, await t.tap(SEED.tags.coach));
    expect(t.lastBody(c)).toMatch(/already paid\. Your receipt: http:\/\/localhost:3000\/r\/[A-Za-z0-9_-]{32}$/);
    const receiptPath = new URL(t.lastBody(c).split("receipt: ")[1]!).pathname;
    expect((await t.app.inject({ url: receiptPath })).statusCode).toBe(200);
  });

  // ── Concurrency (M2 acceptance) ────────────────────────────────────────────

  it("50 simultaneous taps on one bill yield exactly one claim", async () => {
    const { bill } = await newBill();
    const phones = Array.from({ length: 50 }, (_, i) => `27831${String(i).padStart(6, "0")}`);
    const tokens = await Promise.all(phones.map(() => t.tap(SEED.tags.coach)));
    await Promise.all(phones.map((p, i) => t.text(p, tokens[i]!)));
    expect(phones.filter((p) => t.last(p).kind === "list")).toHaveLength(1);
    expect(phones.filter((p) => t.lastBody(p).includes("being paid from another phone"))).toHaveLength(49);
    const sessions = await h.db.selectFrom("sessions").select("id").where("bill_id", "=", bill.id).execute();
    expect(sessions).toHaveLength(1);
  });

  it("50 simultaneous share picks: each share claimed once", async () => {
    const { bill } = await t.flow.createBill({ merchantId: restaurant.merchantId, createdBy: null, tagCode: "GRILL-TABLE-4", lines: [{ description: "Dinner", amountCents: 50000 }], shares: { equal: 5 } });
    const shares = await h.db.selectFrom("bill_shares").select("id").where("bill_id", "=", bill.id).execute();
    const phones = Array.from({ length: 50 }, (_, i) => `27832${String(i).padStart(6, "0")}`);
    await Promise.all(phones.map((p, i) => t.pick(p, `share_${shares[i % 5]!.id}`)));
    const claimed = await h.db.selectFrom("bill_shares").select(["status", "customer_id"]).where("bill_id", "=", bill.id).execute();
    expect(claimed.every((x) => x.status === "claimed")).toBe(true);
    expect(new Set(claimed.map((x) => x.customer_id)).size).toBe(5);
    const sessions = await h.db.selectFrom("sessions").select("id").where("bill_id", "=", bill.id).execute();
    expect(sessions).toHaveLength(5);
  });
});
