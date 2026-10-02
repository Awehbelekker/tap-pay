import { describe, expect, it } from "vitest";
import { inboundPayload } from "@tappay/wa-sim";
import { parseInbound } from "../src/inbound.js";

const p = (message: Parameters<typeof inboundPayload>[0]["message"]) =>
  inboundPayload({ from: "27820000482", profileName: "Ann Smith", phoneNumberId: "x", displayNumber: "1", message, messageId: "wamid.A", timestamp: new Date(1_790_000_000_000) });

describe("parseInbound", () => {
  it("reads text with sender and profile name", () => {
    expect(parseInbound(p({ kind: "text", text: "PAY ABCDEF" }))).toEqual([
      { messageId: "wamid.A", from: "27820000482", profileName: "Ann Smith", timestamp: new Date(1_790_000_000_000), kind: "text", text: "PAY ABCDEF" },
    ]);
  });

  it("reads button and list replies by id", () => {
    expect(parseInbound(p({ kind: "button_reply", id: "pay_now", title: "Pay now" }))[0]).toMatchObject({ kind: "reply", replyId: "pay_now" });
    expect(parseInbound(p({ kind: "list_reply", id: "tip_bp_1500", title: "15%" }))[0]).toMatchObject({ kind: "reply", replyId: "tip_bp_1500" });
  });

  it("ignores status callbacks, junk and malformed senders", () => {
    expect(parseInbound({ entry: [{ changes: [{ value: { statuses: [{ id: "x", status: "read" }] } }] }] })).toEqual([]);
    for (const junk of [null, 1, "x", {}, { entry: "x" }, { entry: [{ changes: [{ value: { messages: [{ id: "a", from: "not-a-number", type: "text" }] } }] }] }]) {
      expect(parseInbound(junk)).toEqual([]);
    }
  });

  it("maps unsupported types to other", () => {
    const body = { entry: [{ changes: [{ value: { messages: [{ id: "a", from: "27820000482", type: "image", timestamp: "1" }] } }] }] };
    expect(parseInbound(body)[0]).toMatchObject({ kind: "other" });
  });
});
