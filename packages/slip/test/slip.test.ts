import { cents } from "@tappay/core";
import { describe, expect, it } from "vitest";
import { formatSast, renderSlipPng } from "../src/index.js";

describe("slip", () => {
  it("renders a small PNG", async () => {
    const png = await renderSlipPng({
      product: "TestPay",
      merchant: "Bean and Brew Coffee, Tokai",
      receiptNumber: "R-20261002-0001",
      reference: "3f2a9c",
      paidAt: new Date("2026-10-02T12:05:00Z"),
      lines: [{ description: "Beginner lesson", amount: cents(50000) }],
      base: cents(50000),
      tip: cents(5000),
      total: cents(55000),
      method: "Apple Pay",
      staff: "Sipho",
    });
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.length).toBeGreaterThan(5_000);
    expect(png.length).toBeLessThan(1_000_000); // SPEC 14: <= 1 MB
  });

  it("formats time in South Africa", () => {
    expect(formatSast(new Date("2026-10-02T12:05:00Z"))).toMatch(/02 Oct 2026,? 14:05/);
  });
});
