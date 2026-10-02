import type { HttpFetch } from "./ports.js";

/**
 * Outbound HTTP for adapters: a timeout on every call, and retries only where repeating is
 * safe (the caller says so: reads, or writes the provider de-duplicates by an idempotency key).
 * Bodies are never logged here; adapters decide what is safe to keep.
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface CallOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Retries on network errors, 429 and 5xx. Only for calls that are safe to repeat. */
  retries?: number;
  /** Delay before retry n (0-based); injectable so tests do not wait. */
  backoffMs?: (n: number) => number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function call(fetchFn: HttpFetch, url: string, o: CallOptions = {}): Promise<{ status: number; text: string }> {
  const retries = o.retries ?? 0;
  const backoff = o.backoffMs ?? ((n: number) => 250 * 2 ** n);
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 10_000);
    try {
      const r = await fetchFn(url, { method: o.method ?? "GET", headers: o.headers ?? {}, ...(o.body !== undefined ? { body: o.body } : {}), signal: ctrl.signal });
      const text = await r.text();
      if (r.status === 429 || r.status >= 500) {
        last = new HttpError(r.status, text, `HTTP ${r.status}`);
        if (attempt < retries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw last;
      }
      return { status: r.status, text };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      last = e;
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/** JSON in, JSON out; throws HttpError on a non-2xx answer. */
export async function callJson<T>(fetchFn: HttpFetch, url: string, o: CallOptions & { json?: unknown } = {}): Promise<T> {
  const headers = { accept: "application/json", ...(o.json !== undefined ? { "content-type": "application/json" } : {}), ...o.headers };
  const r = await call(fetchFn, url, { ...o, headers, ...(o.json !== undefined ? { body: JSON.stringify(o.json) } : {}) });
  if (r.status < 200 || r.status >= 300) throw new HttpError(r.status, r.text, `HTTP ${r.status}`);
  return (r.text ? JSON.parse(r.text) : {}) as T;
}
