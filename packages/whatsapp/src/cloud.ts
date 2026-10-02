import { call, HttpError, type HttpFetch, type WaButton, type WaListRow, type WaSendResult, type WhatsAppClient } from "@tappay/core";
import { assertBody, assertButtons, assertRows } from "./index.js";

/**
 * WhatsApp Cloud API client (docs/PROVIDER_NOTES.md "WhatsApp"). POST
 * {base}/{version}/{phone-number-id}/messages with a Bearer token; bodies as in Meta's own
 * samples (WhatsApp-Nodejs-SDK, fbsamples/whatsapp-business-jaspers-market).
 *
 * Sends are not retried: Meta has no idempotency key, so a retry after a lost response could
 * message the customer twice. Callers record failures (message_log) instead. Mark-as-read is
 * harmless to repeat and gets one retry.
 */

export interface CloudConfig {
  phoneNumberId: string;
  accessToken: string;
  /** e.g. "v23.0" (WA_GRAPH_VERSION). */
  version: string;
  baseUrl?: string;
  /** Template language code as registered with Meta, e.g. "en" or "en_US" (WA_TEMPLATE_LANG). */
  templateLang?: string;
  fetch?: HttpFetch;
  timeoutMs?: number;
}

/** A send Meta refused. `code` is Meta's error code, e.g. 131047 (outside the 24-hour window). */
export class WaSendError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number | null,
    message: string,
  ) {
    super(message);
    this.name = "WaSendError";
  }
  /** Free-form message outside the 24-hour window: a template is needed (SPEC 11.3). */
  get outsideWindow(): boolean {
    return this.code === 131047;
  }
  get rateLimited(): boolean {
    return this.status === 429 || this.code === 130429 || this.code === 131056;
  }
}

const textLimit = 4096;
const captionLimit = 1024;

export class CloudWhatsAppClient implements WhatsAppClient {
  private readonly url: string;
  private readonly fetchFn: HttpFetch;

  constructor(private readonly c: CloudConfig) {
    this.url = `${c.baseUrl ?? "https://graph.facebook.com"}/${c.version}/${c.phoneNumberId}/messages`;
    this.fetchFn = c.fetch ?? (globalThis.fetch as unknown as HttpFetch);
  }

  private async post(body: Record<string, unknown>, retries = 0): Promise<Record<string, unknown>> {
    let r;
    try {
      r = await call(this.fetchFn, this.url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.c.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
        timeoutMs: this.c.timeoutMs ?? 10_000,
        retries,
      });
    } catch (e) {
      if (e instanceof HttpError) throw toSendError(e.status, e.body);
      throw e;
    }
    if (r.status < 200 || r.status >= 300) throw toSendError(r.status, r.text);
    return JSON.parse(r.text || "{}") as Record<string, unknown>;
  }

  private async send(to: string, body: Record<string, unknown>): Promise<WaSendResult> {
    const r = await this.post({ recipient_type: "individual", to: to.replace(/\D/g, ""), ...body });
    const id = (r.messages as { id?: string }[] | undefined)?.[0]?.id;
    if (!id) throw new WaSendError(200, null, "no message id in response");
    return { messageId: id };
  }

  async sendText(to: string, body: string): Promise<WaSendResult> {
    if (body.length === 0 || body.length > textLimit) throw new WaSendError(0, null, `text length ${body.length}`);
    return this.send(to, { type: "text", text: { preview_url: false, body } });
  }

  async sendButtons(to: string, body: string, buttons: WaButton[]): Promise<WaSendResult> {
    assertBody(body);
    assertButtons(buttons);
    return this.send(to, {
      type: "interactive",
      interactive: { type: "button", body: { text: body }, action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) } },
    });
  }

  async sendList(to: string, body: string, buttonLabel: string, rows: WaListRow[]): Promise<WaSendResult> {
    assertBody(body);
    assertRows(rows);
    return this.send(to, {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: body },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: [{ title: "Options", rows: rows.map((r) => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description.slice(0, 72) } : {}) })) }],
        },
      },
    });
  }

  async sendTemplate(to: string, template: string, lang: string, params: string[]): Promise<WaSendResult> {
    return this.send(to, {
      type: "template",
      template: {
        name: template,
        language: { code: this.c.templateLang ?? lang },
        ...(params.length ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] } : {}),
      },
    });
  }

  async sendImage(to: string, imageUrl: string, caption?: string): Promise<WaSendResult> {
    return this.send(to, { type: "image", image: { link: imageUrl, ...(caption ? { caption: caption.slice(0, captionLimit) } : {}) } });
  }

  async sendDocument(to: string, documentUrl: string, filename: string, caption?: string): Promise<WaSendResult> {
    return this.send(to, { type: "document", document: { link: documentUrl, filename, ...(caption ? { caption: caption.slice(0, captionLimit) } : {}) } });
  }

  async markRead(messageId: string): Promise<void> {
    await this.post({ status: "read", message_id: messageId }, 1);
  }
}

function toSendError(status: number, text: string): WaSendError {
  try {
    const e = (JSON.parse(text) as { error?: { code?: number; message?: string } }).error;
    // Meta's message can echo the recipient; keep only the code and a short reason.
    return new WaSendError(status, e?.code ?? null, `WhatsApp error ${e?.code ?? status}`);
  } catch {
    return new WaSendError(status, null, `WhatsApp HTTP ${status}`);
  }
}
