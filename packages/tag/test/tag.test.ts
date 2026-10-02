import { describe, expect, it } from "vitest";
import { isValidTagCode, tagUrl, waMeLink } from "../src/index.js";

describe("tag urls", () => {
  it("builds https tag URLs on our domain and http only for localhost", () => {
    expect(tagUrl("pay.example.co.za", "DEMO-COACH-1")).toBe("https://pay.example.co.za/t/DEMO-COACH-1");
    expect(tagUrl("localhost:3000", "DEMO-TILL-1")).toBe("http://localhost:3000/t/DEMO-TILL-1");
  });

  it("rejects codes that could break the URL", () => {
    for (const bad of ["", "a/b", "abc", "DEMO?x=1", "x".repeat(33)]) expect(isValidTagCode(bad)).toBe(false);
    expect(() => tagUrl("x", "../etc")).toThrow();
  });

  it("encodes the claim message into wa.me", () => {
    expect(waMeLink("27600000000", "AB12CD")).toBe("https://wa.me/27600000000?text=PAY%20AB12CD");
  });
});
