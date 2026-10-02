import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { inboundPayload, sign, type Inbound } from "./payload.js";

/**
 * Local WhatsApp simulator. Serves a phone-like chat page, forwards what you type or tap to the
 * API's WhatsApp webhook as a signed Cloud-API-shaped request, and shows the bot's replies from
 * the API's simulator outbox (/sim/outbox, only present when WA_MODE=sim).
 */

const port = Number(process.env.WA_SIM_PORT ?? 4000);
const apiUrl = process.env.PUBLIC_API_URL ?? "http://localhost:3000";
const appSecret = process.env.WA_APP_SECRET ?? "";
const waNumber = process.env.WA_PHONE_NUMBER ?? "27600000000";
const page = new URL("../public/index.html", import.meta.url);

if (!appSecret) {
  process.stderr.write("wa-sim: WA_APP_SECRET is not set; the API will reject simulated messages\n");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
}

const json = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(page));
      return;
    }

    // Bot replies for one number, proxied from the API so the page needs no CORS.
    if (req.method === "GET" && url.pathname === "/outbox") {
      const r = await fetch(`${apiUrl}/sim/outbox?${new URLSearchParams({ to: url.searchParams.get("to") ?? "", after: url.searchParams.get("after") ?? "0" })}`);
      return json(res, r.status, await r.json());
    }

    // Simulate a phone tapping a tag: follow the API's redirect and return the prefilled text.
    if (req.method === "GET" && url.pathname === "/tap") {
      const code = url.searchParams.get("code") ?? "";
      const r = await fetch(`${apiUrl}/t/${encodeURIComponent(code)}`, { redirect: "manual" });
      const loc = r.headers.get("location");
      const text = loc ? new URL(loc).searchParams.get("text") : null;
      return json(res, 200, text ? { text } : { error: "tag not verified" });
    }

    if (req.method === "POST" && url.pathname === "/send") {
      const b = await readJson(req);
      const from = String(b.from ?? "");
      const message: Inbound =
        typeof b.replyId === "string"
          ? { kind: b.list ? "list_reply" : "button_reply", id: b.replyId, title: String(b.title ?? b.replyId) }
          : { kind: "text", text: String(b.text ?? "") };
      const raw = Buffer.from(JSON.stringify(inboundPayload({ from, profileName: String(b.name ?? "Sim User"), phoneNumberId: "sim-phone-number-id", displayNumber: waNumber, message })));
      const r = await fetch(`${apiUrl}/webhooks/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": sign(appSecret, raw) },
        body: raw,
      });
      return json(res, 200, { apiStatus: r.status });
    }
    res.writeHead(404).end();
  } catch {
    json(res, 502, { error: "could not reach the API" });
  }
});

server.listen(port, () => process.stdout.write(`wa-sim on http://localhost:${port} -> ${apiUrl}\n`));
