import { cents } from "@tappay/core";
import { describe, expect, it } from "vitest";
import { assertBody, assertButtons, assertRows, catalogue, IDS, parseTipId, type OutMessage } from "../src/index.js";

function assertSendable(m: OutMessage): void {
  if (m.kind === "image") return;
  assertBody(m.body);
  if (m.kind === "buttons") assertButtons(m.buttons);
  if (m.kind === "list") assertRows(m.rows);
  expect(m.body).not.toMatch(/\p{Extended_Pictographic}/u);
}

describe("catalogue", () => {
  const all: OutMessage[] = [
    catalogue.claimFixed({ merchant: "Bean and Brew Coffee, Tokai", description: "Beginner lesson", base: cents(50000), staff: "Sipho", tipPercents: [10, 15, 20] }),
    catalogue.tipCustomAsk(),
    catalogue.tipCustomInvalid({ min: cents(100), max: cents(50000), maxPercent: 100 }),
    catalogue.confirm({ merchant: "Bean and Brew", description: "Beginner lesson", base: cents(50000), tip: cents(5000) }),
    catalogue.payLink({ merchant: "Bean and Brew", total: cents(55000), url: "https://x.test/c/1", minutes: 10 }),
    catalogue.payFailed({ merchant: "Bean and Brew" }),
    catalogue.sessionExpired(),
    catalogue.billClaimedOther({ merchant: "M" }),
    catalogue.billNone({ merchant: "M" }),
    catalogue.tokenInvalid(),
    catalogue.tagNotVerified(),
    catalogue.fallback(),
    catalogue.help(),
  ];

  it("every message fits WhatsApp limits and has no emoji", () => {
    for (const m of all) assertSendable(m);
  });

  it("shows the exact total, merchant and tip before Pay now", () => {
    const m = catalogue.confirm({ merchant: "Bean and Brew", description: "Beginner lesson", base: cents(50000), tip: cents(5000) });
    expect(m.kind === "buttons" && m.body).toBe("Pay R550,00 to Bean and Brew?\nBeginner lesson: R500,00\nTip: R50,00");
  });

  it("offers No tip, each preset with its rand value, and Other", () => {
    const m = catalogue.claimFixed({ merchant: "M", description: "Lesson", base: cents(50000), staff: null, tipPercents: [10, 15, 20] });
    expect(m.kind === "list" && m.rows.map((r) => r.title)).toEqual(["No tip", "10% (R50,00)", "15% (R75,00)", "20% (R100,00)", "Other amount"]);
  });

  it("round-trips tip ids and rejects junk", () => {
    expect(parseTipId(IDS.tipPercent(1500))).toEqual({ kind: "percent", bp: 1500 });
    expect(parseTipId(IDS.tipNone)).toEqual({ kind: "none" });
    expect(parseTipId(IDS.tipCustom)).toEqual({ kind: "custom" });
    for (const bad of ["tip_bp_0", "tip_bp_10001", "tip_bp_x", "pay_now"]) expect(parseTipId(bad)).toBeNull();
  });
});
