import { describe, expect, it } from "vitest";
import { CLAIM_TOKEN_LENGTH, hashToken, newClaimToken, newUrlToken, parsePayCommand } from "../src/tokens.js";

describe("claim tokens", () => {
  it("are 6 characters from an unambiguous alphabet and parse back", () => {
    for (let i = 0; i < 200; i++) {
      const t = newClaimToken();
      expect(t).toHaveLength(CLAIM_TOKEN_LENGTH);
      expect(t).not.toMatch(/[ILO01]/);
      expect(parsePayCommand(`PAY ${t}`)).toBe(t);
    }
  });

  it("parses tolerant input and rejects anything else", () => {
    expect(parsePayCommand("  pay   abcdef ")).toBe("ABCDEF");
    for (const bad of ["PAY", "PAY ABCDE", "PAY ABCDEFG", "PAYABCDEF", "PAY ABC0EF", "hello PAY ABCDEF"]) {
      expect(parsePayCommand(bad)).toBeNull();
    }
  });

  it("hashes case-insensitively and depends on the pepper", () => {
    expect(hashToken("abcdef", "p").equals(hashToken("ABCDEF", "p"))).toBe(true);
    expect(hashToken("ABCDEF", "p").equals(hashToken("ABCDEF", "q"))).toBe(false);
  });

  it("makes long URL tokens", () => {
    expect(newUrlToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});
