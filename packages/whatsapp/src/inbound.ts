/**
 * Parse a WhatsApp Cloud API webhook body into the messages we act on. Status callbacks and
 * unsupported message types are dropped (unsupported ones come back as kind "other" so the
 * bot can answer with the fallback message). Shape per Meta's webhook docs; re-verify in M8.
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
