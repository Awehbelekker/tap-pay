import webpush from "web-push";
import type { PushClient, PushSubscriptionJson } from "@tappay/core";

/**
 * Web Push adapters. Real delivery uses VAPID (works on Android Chrome and on an iPhone with the
 * PWA installed to the home screen; ARCHITECTURE T6). Without VAPID keys push is off and alerts
 * fall through to WhatsApp.
 */

export class WebPushClient implements PushClient {
  constructor(vapid: { publicKey: string; privateKey: string; subject: string }) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  async send(sub: PushSubscriptionJson, payload: unknown): Promise<{ ok: boolean; gone: boolean }> {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600, urgency: "high" });
      return { ok: true, gone: false };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      // 404/410: the browser dropped the subscription; forget it.
      return { ok: false, gone: status === 404 || status === 410 };
    }
  }
}

export class DisabledPushClient implements PushClient {
  async send(): Promise<{ ok: boolean; gone: boolean }> {
    return { ok: false, gone: false };
  }
}

/** Test double: records what was pushed; endpoints listed in `failing` or `gone` fail. */
export class MemoryPushClient implements PushClient {
  readonly sent: { endpoint: string; payload: unknown }[] = [];
  readonly failing = new Set<string>();
  readonly gone = new Set<string>();

  async send(sub: PushSubscriptionJson, payload: unknown): Promise<{ ok: boolean; gone: boolean }> {
    if (this.gone.has(sub.endpoint)) return { ok: false, gone: true };
    if (this.failing.has(sub.endpoint)) return { ok: false, gone: false };
    this.sent.push({ endpoint: sub.endpoint, payload });
    return { ok: true, gone: false };
  }
}
