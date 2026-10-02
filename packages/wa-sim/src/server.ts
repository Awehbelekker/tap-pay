import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { inboundPayload, sign } from "./payload.js";

/**
 * Local WhatsApp simulator shell (MILESTONES M0). Serves a phone-like chat page and forwards
 * what you type to the API's WhatsApp webhook as a signed Cloud-API-shaped request. M1 adds the
 * API side (/webhooks/whatsapp and the simulator outbox) so replies render in the chat.
 */

const port = Number(process.env.WA_SIM_PORT ?? 4000);
const apiUrl = process.env.PUBLIC_API_URL ?? "http://localhost:3000";
const appSecret = process.env.WA_APP_SECRET ?? "";
const waNumber = process.env.WA_PHONE_NUMBER ?? "27600000000";
const page = new URL("../public/index.html", import.meta.url);

if (!appSecret) {
  process.stderr.write("wa-sim: WA_APP_SECRET is not set; the API will reject simulated messages\n");
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(page));
      return;
    }
    if (req.method === "POST" && req.url === "/send") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { from: string; name: string; text: string };
      const raw = Buffer.from(
        JSON.stringify(
          inboundPayload({
            from: body.from,
            profileName: body.name,
            phoneNumberId: "sim-phone-number-id",
            displayNumber: waNumber,
            message: { kind: "text", text: body.text },
          }),
        ),
      );
      const r = await fetch(`${apiUrl}/webhooks/whatsapp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": sign(appSecret, raw) },
        body: raw,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ apiStatus: r.status }));
      return;
    }
    res.writeHead(404).end();
  } catch {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "could not reach the API" }));
  }
});

server.listen(port, () => process.stdout.write(`wa-sim on http://localhost:${port} -> ${apiUrl}\n`));
