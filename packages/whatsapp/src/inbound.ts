/**
 * Parse a WhatsApp Cloud API webhook body into the messages we act on. Status callbacks and
 * unsupported message types are dropped (unsupported ones come back as kind "other" so the
 * bot can answer with the fallback message). Shape verified against Meta's own samples (PROVIDER_NOTES).
 */
export type InboundMessage = {
  messageId: string;
  from: string;
  profileName: string | null;
  timestamp: Date;
} & (
  | { kind: "text"; text: string }
  | { kind: "reply"; replyId: string }
  | { kind: "other" }
);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export function parseInbound(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of arr(obj(body)?.entry)) {
    for (const change of arr(obj(entry)?.changes)) {
      const value = obj(obj(change)?.value);
      if (!value) continue;
      const names = new Map<string, string>();
      for (const c of arr(value.contacts)) {
        const id = str(obj(c)?.wa_id);
        const name = str(obj(obj(c)?.profile)?.name);
        if (id && name) names.set(id, name);
      }
      for (const m of arr(value.messages)) {
        const msg = obj(m);
        const messageId = str(msg?.id);
        const from = str(msg?.from);
        if (!msg || !messageId || !from || !/^\d{8,15}$/.test(from)) continue;
        const ts = Number(msg.timestamp);
        const base = {
          messageId,
          from,
          profileName: names.get(from) ?? null,
          timestamp: Number.isFinite(ts) ? new Date(ts * 1000) : new Date(),
        };
        if (msg.type === "text") {
          const text = str(obj(msg.text)?.body);
          out.push(text ? { ...base, kind: "text", text } : { ...base, kind: "other" });
        } else if (msg.type === "interactive") {
          const it = obj(msg.interactive);
          const id = str(obj(it?.button_reply)?.id) ?? str(obj(it?.list_reply)?.id);
          out.push(id ? { ...base, kind: "reply", replyId: id } : { ...base, kind: "other" });
        } else if (msg.type === "button") {
          // Quick-reply button on a template message.
          const payload = str(obj(msg.button)?.payload);
          out.push(payload ? { ...base, kind: "reply", replyId: payload } : { ...base, kind: "other" });
        } else {
          out.push({ ...base, kind: "other" });
        }
      }
    }
  }
  return out;
}

/** Delivery receipts (`statuses[]`): sent, delivered, read, or failed with Meta's error code. */
export interface InboundStatus {
  messageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorCode: number | null;
}

export function parseStatuses(body: unknown): InboundStatus[] {
  const out: InboundStatus[] = [];
  for (const entry of arr(obj(body)?.entry)) {
    for (const change of arr(obj(entry)?.changes)) {
      for (const st of arr(obj(obj(change)?.value)?.statuses)) {
        const s = obj(st);
        const id = str(s?.id);
        const status = str(s?.status);
        if (!id || !status || !["sent", "delivered", "read", "failed"].includes(status)) continue;
        const code = Number(obj(arr(s?.errors)[0])?.code);
        out.push({ messageId: id, status: status as InboundStatus["status"], errorCode: Number.isFinite(code) ? code : null });
      }
    }
  }
  return out;
}
