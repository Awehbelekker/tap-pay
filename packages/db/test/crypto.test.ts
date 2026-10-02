import { describe, expect, it } from "vitest";
import { Crypto, maskMsisdn, normaliseMsisdn } from "../src/crypto.js";

const k1 = Buffer.alloc(32, 1).toString("base64");
const k2 = Buffer.alloc(32, 2).toString("base64");
const pepper = "p".repeat(32);

describe("Crypto", () => {
  const c = new Crypto([{ id: 1, keyBase64: k1 }], 1, pepper);

  it("round-trips and never stores plaintext", () => {
    const blob = c.encrypt("27821234567");
    expect(blob.includes(Buffer.from("27821234567"))).toBe(false);
    expect(c.decrypt(blob)).toBe("27821234567");
  });

  it("uses a fresh IV every time", () => {
    expect(c.encrypt("x").equals(c.encrypt("x"))).toBe(false);
  });

  it("detects tampering", () => {
    const blob = c.encrypt("27821234567");
    blob[blob.length - 1]! ^= 1;
    expect(() => c.decrypt(blob)).toThrow();
  });

  it("decrypts data written under an older key after rotation", () => {
    const old = c.encrypt("secret");
    const rotated = new Crypto([{ id: 1, keyBase64: k1 }, { id: 2, keyBase64: k2 }], 2, pepper);
    expect(rotated.decrypt(old)).toBe("secret");
    expect(rotated.encrypt("new")[0]).toBe(2);
  });

  it("hashes equivalent number formats to the same lookup key", () => {
    expect(c.lookupHash("082 123 4567").equals(c.lookupHash("+27821234567"))).toBe(true);
    expect(c.lookupHash("0821234567").equals(c.lookupHash("0821234568"))).toBe(false);
  });

  it("rejects bad keys", () => {
    expect(() => new Crypto([{ id: 1, keyBase64: Buffer.alloc(16).toString("base64") }], 1, pepper)).toThrow();
    expect(() => new Crypto([{ id: 1, keyBase64: k1 }], 2, pepper)).toThrow();
  });
});

describe("msisdn helpers", () => {
  it("normalises SA local numbers", () => {
    expect(normaliseMsisdn("082 123 4567")).toBe("27821234567");
    expect(normaliseMsisdn("+27 82 123 4567")).toBe("27821234567");
  });

  it("masks to the last three digits", () => {
    expect(maskMsisdn("+27821234482")).toBe("***482");
  });
});
