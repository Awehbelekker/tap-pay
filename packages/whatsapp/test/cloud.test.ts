import { describe, expect, it } from "vitest";
import type { HttpFetch } from "@tappay/core";
import { CloudWhatsAppClient, parseStatuses, WaSendError } from "../src/index.js";

/** A fake Graph API that records requests and answers like Meta does. */
function graph(answer: (body: Record<string, unknown>) => { status: number; json: unknown } = () => ({ status: 200, json: { messaging_product: "whatsapp", contacts: [{ input: "27820000001", wa_id: "27820000001" }], messages: [{ id: "wamid.TEST" }] } })) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetch: HttpFetch = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const a = answer(body);
    return { status: a.status, ok: a.status < 300, text: async () => JSON.stringify(a.json) };
  };
  const client = new CloudWhatsAppClient({ phoneNumberId: "1234567890", accessToken: "test-token-not-real", version: "v23.0", templateLang: "en_US", fetch });
  return { client, calls };
}

describe("CloudWhatsAppClient (Graph API request shapes, PROVIDER_NOTES WhatsApp)", () => {
  it("posts to /{version}/{phone-number-id}/messages with a Bearer token", async () => {
    const { client, calls } = graph();
    expect(await client.sendText("27820000001", "Hello")).toEqual({ messageId: "wamid.TEST" });
    expect(calls[0]!.url).toBe("https://graph.facebook.com/v23.0/1234567890/messages");
    expect(calls[0]!.headers.authorization).toBe("Bearer test-token-not-real");
    expect(calls[0]!.body).toEqual({ messaging_product: "whatsapp", recipient_type: "individual", to: "27820000001", type: "text", text: { preview_url: false, body: "Hello" } });
  });

  it("reply buttons, list, template, image, document and read receipts", async () => {
    const { client, calls } = graph();
    await client.sendButtons("27820000001", "Pay R550,00?", [{ id: "pay_now", title: "Pay now" }]);
    await client.sendList("27820000001", "Add a tip?", "Choose tip", [{ id: "tip_none", title: "No tip" }]);
    await client.sendTemplate("27820000001", "reminder_1", "en", ["R500,00", "Demo", "https://x/b/t"]);
    await client.sendImage("27820000001", "https://x/r/t/slip.png", "Paid");
    await client.sendDocument("27820000001", "https://x/i/t", "Tax invoice INV-000001.pdf", "Tax invoice");
    await client.markRead("wamid.IN");
    const b = calls.map((c) => c.body);
    expect(b[0]!.interactive).toEqual({ type: "button", body: { text: "Pay R550,00?" }, action: { buttons: [{ type: "reply", reply: { id: "pay_now", title: "Pay now" } }] } });
    expect(b[1]!.interactive).toEqual({ type: "list", body: { text: "Add a tip?" }, action: { button: "Choose tip", sections: [{ title: "Options", rows: [{ id: "tip_none", title: "No tip" }] }] } });
    // The language the templates were approved under wins over the caller's default.
    expect(b[2]!.template).toEqual({ name: "reminder_1", language: { code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "R500,00" }, { type: "text", text: "Demo" }, { type: "text", text: "https://x/b/t" }] }] });
    expect(b[3]!.image).toEqual({ link: "https://x/r/t/slip.png", caption: "Paid" });
    expect(b[4]!.document).toEqual({ link: "https://x/i/t", filename: "Tax invoice INV-000001.pdf", caption: "Tax invoice" });
    expect(b[5]).toEqual({ messaging_product: "whatsapp", status: "read", message_id: "wamid.IN" });
  });

  it("maps Meta's errors: outside the 24-hour window, rate limits; never retries a send", async () => {
    const { client, calls } = graph(() => ({ status: 400, json: { error: { message: "Re-engagement message", type: "OAuthException", code: 131047 } } }));
    const e = await client.sendText("27820000001", "late").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(WaSendError);
    expect((e as WaSendError).outsideWindow).toBe(true);
    expect(calls).toHaveLength(1);
    const r = graph(() => ({ status: 429, json: { error: { code: 130429 } } }));
    const e2 = (await r.client.sendText("27820000001", "x").catch((x: unknown) => x)) as WaSendError;
    expect(e2.rateLimited).toBe(true);
    expect(r.calls).toHaveLength(1);
  });

  it("enforces Meta's limits before sending", async () => {
    const { client, calls } = graph();
    await expect(client.sendButtons("27820000001", "x", [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: "t" })))).rejects.toThrow();
    await expect(client.sendText("27820000001", "x".repeat(4097))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("parses delivery receipts, including failures with Meta's code", () => {
    const body = { entry: [{ changes: [{ value: { statuses: [{ id: "wamid.A", status: "delivered" }, { id: "wamid.B", status: "failed", errors: [{ code: 131047 }] }, { id: "wamid.C", status: "weird" }] } }] }] };
    expect(parseStatuses(body)).toEqual([
      { messageId: "wamid.A", status: "delivered", errorCode: null },
      { messageId: "wamid.B", status: "failed", errorCode: 131047 },
    ]);
  });
});
