import { describe, expect, it } from "vitest";
import { call, callJson, HttpError } from "../src/http.js";
import type { HttpFetch } from "../src/ports.js";

const answers = (...xs: (number | Error)[]): HttpFetch & { calls: number } => {
  const f = (async () => {
    const x = xs[Math.min(f.calls++, xs.length - 1)]!;
    if (x instanceof Error) throw x;
    return { status: x, ok: x < 300, text: async () => (x < 300 ? '{"ok":true}' : "nope") };
  }) as unknown as HttpFetch & { calls: number };
  f.calls = 0;
  return f;
};

describe("http", () => {
  it("retries 429, 5xx and network errors only as often as allowed", async () => {
    const f = answers(503, new Error("reset"), 200);
    expect((await call(f, "https://x", { retries: 2, backoffMs: () => 0 })).status).toBe(200);
    expect(f.calls).toBe(3);
    const g = answers(500);
    await expect(call(g, "https://x", { retries: 1, backoffMs: () => 0 })).rejects.toBeInstanceOf(HttpError);
    expect(g.calls).toBe(2);
  });

  it("does not retry by default, and never retries a 4xx", async () => {
    const f = answers(429, 200);
    await expect(call(f, "https://x")).rejects.toBeInstanceOf(HttpError);
    expect(f.calls).toBe(1);
    const g = answers(400, 200);
    await expect(callJson(g, "https://x", { retries: 3, backoffMs: () => 0 })).rejects.toMatchObject({ status: 400 });
    expect(g.calls).toBe(1);
  });

  it("times out", async () => {
    const slow: HttpFetch = (_u, init) => new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    await expect(call(slow, "https://x", { timeoutMs: 20 })).rejects.toThrow("aborted");
  });
});
