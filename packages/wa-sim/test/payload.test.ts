import { describe, expect, it } from "vitest";
import { verifyMetaSignature } from "@tappay/whatsapp";
import { inboundPayload, sign } from "../src/payload.js";

describe("wa-sim payloads", () => {
  it("produces a Cloud-API-shaped text message", () => {
    const p = inboundPayload({
      from: "27820000482",
      profileName: "Ann",
      phoneNumberId: "pnid",
      displayNumber: "27600000000",
      message: { kind: "text", text: "PAY AB12CD" },
      messageId: "wamid.1",
    }) as { entry: { changes: { value: { messages: { type: string; text: { body: string } }[]; contacts: { wa_id: string }[] } }[] }[] };
    const v = p.entry[0]!.changes[0]!.value;
    expect(v.messages[0]).toMatchObject({ type: "text", text: { body: "PAY AB12CD" } });
    expect(v.contacts[0]!.wa_id).toBe("27820000482");
  });

  it("encodes button and list replies as interactive messages", () => {
    const p = JSON.stringify(
      inboundPayload({ from: "1", profileName: "x", phoneNumberId: "p", displayNumber: "2", message: { kind: "list_reply", id: "tip_15", title: "15%" } }),
    );
    expect(p).toContain('"type":"interactive"');
    expect(p).toContain('"list_reply":{"id":"tip_15"');
  });

  it("signs exactly like Meta, so the API's verifier accepts it", () => {
    const raw = Buffer.from('{"a":1}');
    expect(verifyMetaSignature("s3cret", raw, sign("s3cret", raw))).toBe(true);
    expect(verifyMetaSignature("other", raw, sign("s3cret", raw))).toBe(false);
  });
});
