import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@tappay/config";
import { Crypto, receiptView, type DbHandle } from "@tappay/db";
import { freshTestDb } from "@tappay/db/testing";
import { testEnv } from "@tappay/testkit";
import { slipData } from "../src/routes.js";
import { Harness } from "./harness.js";

/**
 * M3 acceptance: every tip path end to end. Presets (rounded half up on the bill), no tip,
 * custom rand and percentage tips, merchant tip caps, change tip, tips turned off, quick tip,
 * and the tip on the ledger and on the slip. The maths itself is property-tested in
 * packages/core/test/tips.test.ts.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("tips (e2e)", () => {
  let h: DbHandle;
  let t: Harness;
  let salon: { merchantId: string; staffId: string | null };
  let capped: { merchantId: string; staffId: string | null };
  let noTips: { merchantId: string; staffId: string | null };

  beforeAll(async () => {
    h = await freshTestDb(url!, Crypto.fromConfig(loadConfig(testEnv())));
    t = new Harness(h, url!);
    salon = await t.addMerchant({ name: "Lerato Hair", mode: "appointment", staff: "Lerato", tagCode: "SALON-LERATO" });
    capped = await t.addMerchant({ name: "Fit Physio", mode: "appointment", staff: "Pieter", tagCode: "PHYSIO-PIETER" });
    noTips = await t.addMerchant({ name: "City Pharmacy", mode: "counter", tagCode: "PHARM-TILL" });
    // Physio caps tips at 15% and R50; pharmacy takes no tips.
    await h.db.updateTable("merchants").set({ tip_max_bp: 1500, tip_max_cents: 5000 }).where("id", "=", capped.merchantId).execute();
    await h.db.updateTable("merchants").set({ tips_enabled: false }).where("id", "=", noTips.merchantId).execute();
  });
  afterAll(async () => {
    await t?.close();
    await h?.close();
  });
  beforeEach(async () => {
    await h.pool.query("update bills set status = 'cancelled' where status in ('open','claimed')");
    await t.reset();
  });

  const bill = (merchantId: string, tagCode: string, amountCents: number, description = "Cut and blow-dry") =>
    t.flow.createBill({ merchantId, createdBy: null, tagCode, lines: [{ description, amountCents }] });

  const ledgerFor = async (ref: string) => {
    const pay = await h.db.selectFrom("payments").select(["id", "amount_cents"]).where("provider_ref", "=", ref).executeTakeFirstOrThrow();
    const lines = await h.db.selectFrom("ledger_entries").select(["kind", "party_user_id", "amount_cents"]).where("payment_id", "=", pay.id).execute();
    return { pay, lines };
  };

  const slipFor = async (ref: string) => {
    const pay = await h.db.selectFrom("payments").select("id").where("provider_ref", "=", ref).executeTakeFirstOrThrow();
    const r = await h.db.selectFrom("receipts").select("receipt_token").where("payment_id", "=", pay.id).executeTakeFirstOrThrow();
    return slipData((await receiptView(h.db, r.receipt_token))!, "TestPay");
  };

  it("each preset shows its rand value, rounded half up on the bill", async () => {
    await bill(salon.merchantId, "SALON-LERATO", 33300);
    const c = "27822000001";
    await t.text(c, await t.tap("SALON-LERATO"));
    const m = t.last(c);
    expect(m.kind === "list" && m.rows.map((r) => r.title)).toEqual(["No tip", "10% (R33,30)", "15% (R49,95)", "20% (R66,60)", "Other amount"]);
  });

  it("20% preset: tip is a separate ledger line to the staff member and its own line on the slip", async () => {
    await bill(salon.merchantId, "SALON-LERATO", 33300);
    const c = "27822000002";
    await t.text(c, await t.tap("SALON-LERATO"));
    await t.pick(c, "tip_bp_2000");
    expect(t.lastBody(c)).toBe("Pay R399,60 to Lerato Hair?\nCut and blow-dry: R333,00\nTip: R66,60");
    const ref = await t.payNow(c);
    const { pay, lines } = await ledgerFor(ref);
    expect(pay.amount_cents).toBe(39960);
    expect(lines.filter((l) => l.amount_cents > 0)).toEqual([
      { kind: "sale", party_user_id: null, amount_cents: 33300 },
      { kind: "tip", party_user_id: salon.staffId, amount_cents: 6660 },
    ]);
    expect(await slipFor(ref)).toMatchObject({ base: 33300, tip: 6660, total: 39960, staff: "Lerato", lines: [{ description: "Cut and blow-dry", amount: 33300 }] });
  });

  it("no tip: total is the bill, no tip ledger line, slip shows R0 tip without a name", async () => {
    await bill(salon.merchantId, "SALON-LERATO", 25000);
    const c = "27822000003";
    await t.text(c, await t.tap("SALON-LERATO"));
    await t.pick(c, "tip_none");
    expect(t.lastBody(c)).toBe("Pay R250,00 to Lerato Hair?\nCut and blow-dry: R250,00\nTip: R0,00");
    const ref = await t.payNow(c);
    const { lines } = await ledgerFor(ref);
    expect(lines.some((l) => l.kind === "tip")).toBe(false);
    expect(await slipFor(ref)).toMatchObject({ tip: 0, total: 25000, staff: null });
  });

  it("custom tip in rand and as a percentage", async () => {
    await bill(salon.merchantId, "SALON-LERATO", 20000);
    const c = "27822000004";
    await t.text(c, await t.tap("SALON-LERATO"));
    await t.pick(c, "tip_custom");
    await t.text(c, "R 35");
    expect(t.lastBody(c)).toContain("Tip: R35,00");
    await t.press(c, "change_tip");
    await t.pick(c, "tip_custom");
    await t.text(c, "7,5%");
    expect(t.lastBody(c)).toBe("Pay R215,00 to Lerato Hair?\nCut and blow-dry: R200,00\nTip: R15,00");
  });

  it("change tip at the confirm step goes back to the list and the new tip replaces the old", async () => {
    await bill(salon.merchantId, "SALON-LERATO", 10000);
    const c = "27822000005";
    await t.text(c, await t.tap("SALON-LERATO"));
    await t.pick(c, "tip_bp_2000");
    expect(t.lastBody(c)).toContain("Tip: R20,00");
    await t.press(c, "change_tip");
    expect(t.last(c).kind).toBe("list");
    await t.pick(c, "tip_bp_1000");
    expect(t.lastBody(c)).toBe("Pay R110,00 to Lerato Hair?\nCut and blow-dry: R100,00\nTip: R10,00");
    const ref = await t.payNow(c);
    expect((await ledgerFor(ref)).pay.amount_cents).toBe(11000);
  });

  it("merchant cap (15% and R50): bigger presets hidden, bigger custom tips refused", async () => {
    await bill(capped.merchantId, "PHYSIO-PIETER", 50000, "Session");
    const c = "27822000006";
    await t.text(c, await t.tap("PHYSIO-PIETER"));
    expect(t.options(c)).toEqual(["tip_none", "tip_bp_1000", "tip_custom"]); // 15% = R75 > R50
    await t.pick(c, "tip_bp_2000"); // forged or stale: shown the real list again
    expect(t.options(c)).toEqual(["tip_none", "tip_bp_1000", "tip_custom"]);
    await t.pick(c, "tip_custom");
    await t.text(c, "60");
    expect(t.lastBody(c)).toBe("Please send an amount between R1,00 and R50,00, or a percentage up to 15%, or tap No tip.");
    await t.text(c, "12%");
    expect(t.lastBody(c)).toContain("between R1,00 and R50,00");
    await t.text(c, "50");
    expect(t.lastBody(c)).toBe("Pay R550,00 to Fit Physio?\nSession: R500,00\nTip: R50,00");
  });

  it("tips turned off: straight to Pay now, no tip line, no Change tip", async () => {
    await bill(noTips.merchantId, "PHARM-TILL", 12950, "Prescription");
    const c = "27822000007";
    await t.text(c, await t.tap("PHARM-TILL"));
    expect(t.lastBody(c)).toBe("Pay R129,50 to City Pharmacy?\nPrescription: R129,50");
    expect(t.options(c)).toEqual(["pay_now", "cancel"]);
    await t.press(c, "change_tip"); // ignored: re-shows the confirmation
    expect(t.options(c)).toEqual(["pay_now", "cancel"]);
    const ref = await t.payNow(c);
    expect((await ledgerFor(ref)).pay.amount_cents).toBe(12950);
  });

  it("a tip on a split share is a percentage of that share", async () => {
    await t.flow.createBill({ merchantId: salon.merchantId, createdBy: null, tagCode: "SALON-LERATO", lines: [{ description: "Bridal party", amountCents: 90000 }], shares: { equal: 3 } });
    const c = "27822000008";
    await t.text(c, await t.tap("SALON-LERATO"));
    await t.pick(c, t.options(c)[0]!);
    expect(t.last(c).kind === "list" && (t.last(c) as { rows: { title: string }[] }).rows[1]!.title).toBe("10% (R30,00)");
    await t.pick(c, "tip_bp_1000");
    const ref = await t.payNow(c);
    expect(await slipFor(ref)).toMatchObject({ base: 30000, tip: 3000, total: 33000, lines: [{ description: "Share 1 of 3", amount: 30000 }] });
  });

  it("quick tip: all of it is tip, shown on the slip with the person's name and no bill line", async () => {
    await t.addMerchant({ name: "Fuel Stop", mode: "quick_tip", staff: "Sizwe", tagCode: "PUMP-SIZWE" });
    const c = "27822000009";
    await t.text(c, await t.tap("PUMP-SIZWE"));
    await t.pick(c, "qt_2000");
    const ref = await t.payNow(c);
    expect(await slipFor(ref)).toMatchObject({ base: 0, tip: 2000, total: 2000, staff: "Sizwe", lines: [] });
  });

  it("the database refuses more than 4 presets or a preset over 100%", async () => {
    await expect(h.db.updateTable("merchants").set({ tip_presets: [5, 10, 15, 20, 25] }).where("id", "=", salon.merchantId).execute()).rejects.toThrow(/tip_presets_valid/);
    await expect(h.db.updateTable("merchants").set({ tip_presets: [10, 150] }).where("id", "=", salon.merchantId).execute()).rejects.toThrow(/tip_presets_valid/);
    await expect(h.db.updateTable("merchants").set({ tip_max_bp: 0 }).where("id", "=", salon.merchantId).execute()).rejects.toThrow();
  });
});
