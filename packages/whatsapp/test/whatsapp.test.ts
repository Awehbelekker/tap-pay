import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SimWhatsAppClient, verifyMetaSignature, WaLimitError } from "../src/index.js";

describe("verifyMetaSignature", () => {
  const secret = "app-secret";
  const body = Buffer.from('{"entry":[]}');
  const good = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts a correct signature", () => {
    expect(verifyMetaSignature(secret, body, good)).toBe(true);
  });

  it.each([undefined, "", "sha1=abc", "sha256=", "sha256=zz", `sha256=${"0".repeat(64)}`])("rejects %j", (h) => {
    expect(verifyMetaSignature(secret, body, h)).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verifyMetaSignature(secret, Buffer.from('{"entry":[1]}'), good)).toBe(false);
  });
});

describe("SimWhatsAppClient", () => {
  it("records messages per recipient", async () => {
    const wa = new SimWhatsAppClient();
    await wa.sendText("27600000000", "hello");
    await wa.sendButtons("27600000000", "Pay?", [{ id: "pay", title: "Pay now" }]);
    expect(wa.messagesTo("27600000000").map((m) => m.kind)).toEqual(["text", "buttons"]);
  });

  it("enforces Meta design limits", async () => {
    const wa = new SimWhatsAppClient();
    const b = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, title: `B${i}` }));
    await expect(wa.sendButtons("1", "x", b(4))).rejects.toThrow(WaLimitError);
    await expect(wa.sendButtons("1", "x", [{ id: "a", title: "x".repeat(21) }])).rejects.toThrow(WaLimitError);
    await expect(wa.sendList("1", "x", "Choose", b(11))).rejects.toThrow(WaLimitError);
    await expect(wa.sendText("1", "x".repeat(1025))).rejects.toThrow(WaLimitError);
  });
});
