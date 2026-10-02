import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { WaButton, WaListRow, WaSendResult, WhatsAppClient } from "@tappay/core";

/**
 * WhatsApp adapters. M0 ships the simulator client (WA_MODE=sim) and the webhook signature
 * check; the Cloud API client arrives in M8 from Meta's current docs.
 *
 * Limits are the conservative design values from MESSAGES.md; verify against Meta in M8 (T3).
 */
export const WA_LIMITS = {
  replyButtons: 3,
  buttonTitle: 20,
  listRows: 10,
  rowTitle: 24,
  body: 1024,
} as const;

export class WaLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WaLimitError";
  }
}

export function assertBody(body: string): void {
  if (body.length === 0 || body.length > WA_LIMITS.body) throw new WaLimitError(`body length ${body.length} outside 1..${WA_LIMITS.body}`);
}

export function assertButtons(buttons: WaButton[]): void {
  if (buttons.length < 1 || buttons.length > WA_LIMITS.replyButtons) throw new WaLimitError(`need 1..${WA_LIMITS.replyButtons} buttons`);
  for (const b of buttons) {
    if (b.title.length > WA_LIMITS.buttonTitle) throw new WaLimitError(`button title too long: ${b.title}`);
  }
}

export function assertRows(rows: WaListRow[]): void {
  if (rows.length < 1 || rows.length > WA_LIMITS.listRows) throw new WaLimitError(`need 1..${WA_LIMITS.listRows} rows`);
  for (const r of rows) {
    if (r.title.length > WA_LIMITS.rowTitle) throw new WaLimitError(`row title too long: ${r.title}`);
  }
}

/**
 * Verify Meta's X-Hub-Signature-256 header ("sha256=<hex>") over the raw request body with the
 * app secret. Constant-time comparison; false on any malformed input.
 */
export function verifyMetaSignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const got = Buffer.from(header.slice("sha256=".length), "hex");
  const want = createHmac("sha256", appSecret).update(rawBody).digest();
  return got.length === want.length && timingSafeEqual(got, want);
}

export type SimMessage =
  | { kind: "text"; to: string; id: string; body: string }
  | { kind: "buttons"; to: string; id: string; body: string; buttons: WaButton[] }
  | { kind: "list"; to: string; id: string; body: string; buttonLabel: string; rows: WaListRow[] }
  | { kind: "template"; to: string; id: string; template: string; lang: string; params: string[] }
  | { kind: "image"; to: string; id: string; imageUrl: string; caption?: string }
  | { kind: "document"; to: string; id: string; documentUrl: string; filename: string; caption?: string };

/**
 * In-memory simulator client. Enforces the same limits the Cloud client will, so a message that
 * passes in the simulator will not be rejected by Meta for size. `packages/wa-sim` reads the
 * outbox to render a phone-like chat.
 */
export class SimWhatsAppClient implements WhatsAppClient {
  readonly outbox: SimMessage[] = [];
  readonly read = new Set<string>();

  private push(m: SimMessage): WaSendResult {
    this.outbox.push(m);
    return { messageId: m.id };
  }

  private id(): string {
    return `wamid.sim.${randomUUID()}`;
  }

  async sendText(to: string, body: string): Promise<WaSendResult> {
    assertBody(body);
    return this.push({ kind: "text", to, id: this.id(), body });
  }

  async sendButtons(to: string, body: string, buttons: WaButton[]): Promise<WaSendResult> {
    assertBody(body);
    assertButtons(buttons);
    return this.push({ kind: "buttons", to, id: this.id(), body, buttons });
  }

  async sendList(to: string, body: string, buttonLabel: string, rows: WaListRow[]): Promise<WaSendResult> {
    assertBody(body);
    assertRows(rows);
    return this.push({ kind: "list", to, id: this.id(), body, buttonLabel, rows });
  }

  async sendTemplate(to: string, template: string, lang: string, params: string[]): Promise<WaSendResult> {
    return this.push({ kind: "template", to, id: this.id(), template, lang, params });
  }

  async sendImage(to: string, imageUrl: string, caption?: string): Promise<WaSendResult> {
    const m: SimMessage = caption === undefined
      ? { kind: "image", to, id: this.id(), imageUrl }
      : { kind: "image", to, id: this.id(), imageUrl, caption };
    return this.push(m);
  }

  async sendDocument(to: string, documentUrl: string, filename: string, caption?: string): Promise<WaSendResult> {
    if (caption !== undefined) assertBody(caption);
    const m: SimMessage = caption === undefined ? { kind: "document", to, id: this.id(), documentUrl, filename } : { kind: "document", to, id: this.id(), documentUrl, filename, caption };
    return this.push(m);
  }

  async markRead(messageId: string): Promise<void> {
    this.read.add(messageId);
  }

  messagesTo(to: string): SimMessage[] {
    return this.outbox.filter((m) => m.to === to);
  }
}

export * from "./catalogue.js";
export * from "./inbound.js";
