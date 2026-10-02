import { useEffect, useRef } from "react";
import { API, refresh, session } from "./api";

/**
 * Live bill events over SSE (GET /v1/merchant/events). EventSource cannot set headers, so the
 * short-lived access token goes in the query; Last-Event-ID resume is automatic on reconnects,
 * and we keep the last id ourselves when we have to reopen with a fresh token.
 */
export interface LiveEvent {
  id: number;
  name: string;
  billId: string | null;
  data: Record<string, unknown>;
}

const NAMES = ["bill.created", "bill.claimed", "share.claimed", "bill.updated", "bill.released", "bill.cancelled", "bill.paid", "bill.failed"];

export function useLiveEvents(onEvent: (e: LiveEvent) => void, enabled: boolean): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let lastId: number | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const open = () => {
      if (stopped || !session.access) return;
      const q = new URLSearchParams({ access_token: session.access });
      if (lastId !== null) q.set("lastEventId", String(lastId));
      es = new EventSource(`${API}/v1/merchant/events?${q}`);
      for (const name of NAMES) {
        es.addEventListener(name, (m) => {
          const msg = m as MessageEvent<string>;
          lastId = Number(msg.lastEventId);
          const data = JSON.parse(msg.data) as Record<string, unknown>;
          handler.current({ id: lastId, name, billId: (data.billId as string | null) ?? null, data });
        });
      }
      es.onerror = () => {
        // The token may have expired: refresh, then reopen from the last event we saw.
        es?.close();
        retry = setTimeout(async () => {
          await refresh();
          open();
        }, 2000);
      };
    };
    open();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [enabled]);
}

/** A short two-tone chime and a buzz when a bill is paid (SPEC 15). */
export function paidSignal(): void {
  try {
    if (localStorage.getItem("tp.sound") !== "off") {
      const ctx = new AudioContext();
      [880, 1320].forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.2, ctx.currentTime + i * 0.15);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.15);
        o.stop(ctx.currentTime + i * 0.15 + 0.3);
      });
    }
  } catch {
    /* no audio */
  }
  if (localStorage.getItem("tp.vibrate") !== "off") navigator.vibrate?.([120, 60, 120]);
}
