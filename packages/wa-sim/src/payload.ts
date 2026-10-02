import { createHmac, randomUUID } from "node:crypto";

/**
 * Builds inbound webhook bodies in the WhatsApp Cloud API shape and signs them the way Meta
 * does (X-Hub-Signature-256 = HMAC-SHA256(app secret, raw body)), so the API exercises its real
 * verification path against the simulator. Shape follows Meta's documented webhook payload;
 * re-check field names against current docs in M8 (OPEN_QUESTIONS T3).
 */

export type Inbound =
  | { kind: "text"; text: string }
  | { kind: "button_reply"; id: string; title: string }
  | { kind: "list_reply"; id: string; title: string };

export function inboundPayload(i: {
  from: string;
  profileName: string;
  phoneNumberId: string;
  displayNumber: string;
  message: Inbound;
  timestamp?: Date;
  messageId?: string;
}): Record<string, unknown> {
  const ts = Math.floor((i.timestamp ?? new Date()).getTime() / 1000).toString();
  const base = { from: i.from, id: i.messageId ?? `wamid.sim.${randomUUID()}`, timestamp: ts };
  const message =
    i.message.kind === "text"
      ? { ...base, type: "text", text: { body: i.message.text } }
      : {
          ...base,
          type: "interactive",
          interactive:
            i.message.kind === "button_reply"
              ? { type: "button_reply", button_reply: { id: i.message.id, title: i.message.title } }
              : { type: "list_reply", list_reply: { id: i.message.id, title: i.message.title } },
        };
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "sim-waba",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: i.displayNumber, phone_number_id: i.phoneNumberId },
              contacts: [{ profile: { name: i.profileName }, wa_id: i.from }],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

export function sign(appSecret: string, rawBody: Buffer): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}
