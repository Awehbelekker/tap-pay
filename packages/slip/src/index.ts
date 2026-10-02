import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { formatRands, type Cents } from "@tappay/core";

/**
 * Customer slip as a PNG (MESSAGES.md "Slip fields"; SPEC 14), rendered server-side with satori
 * (layout to SVG) and resvg (SVG to PNG). No browser, no network. Logo and VAT lines arrive with
 * receipt branding in M6. The split between parties is never shown to the customer.
 */

export interface SlipData {
  product: string;
  merchant: string;
  receiptNumber: string;
  reference: string;
  paidAt: Date;
  lines: { description: string; amount: Cents }[];
  base: Cents;
  tip: Cents;
  total: Cents;
  method: string;
  staff: string | null;
}

const require = createRequire(import.meta.url);
let fonts: Promise<{ name: string; data: Buffer; weight: 400 | 700; style: "normal" }[]> | null = null;

function loadFonts() {
  fonts ??= Promise.all([
    readFile(require.resolve("@fontsource/inter/files/inter-latin-400-normal.woff")),
    readFile(require.resolve("@fontsource/inter/files/inter-latin-700-normal.woff")),
  ]).then(([regular, bold]) => [
    { name: "Inter", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Inter", data: bold, weight: 700 as const, style: "normal" as const },
  ]);
  return fonts;
}

/** Date and time in South Africa, e.g. "02 Oct 2026, 14:05". */
export function formatSast(d: Date): string {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

type Node = { type: string; props: { style?: Record<string, unknown>; children?: unknown } };
const h = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({ type, props: { style, children } });

const row = (label: string, value: string, bold = false): Node =>
  h("div", { display: "flex", justifyContent: "space-between", fontSize: bold ? 30 : 24, fontWeight: bold ? 700 : 400, marginTop: 8 }, [
    h("span", { display: "flex" }, label),
    h("span", { display: "flex" }, value),
  ]);

const rule = (): Node => h("div", { display: "flex", borderTop: "2px dashed #9ca3af", marginTop: 16, marginBottom: 8 });

export const SLIP_WIDTH = 600;

export async function renderSlipPng(d: SlipData): Promise<Buffer> {
  const R = formatRands;
  const lineRows = d.lines.map((l) => row(l.description, R(l.amount)));
  const tree = h(
    "div",
    { display: "flex", flexDirection: "column", width: SLIP_WIDTH, padding: 40, background: "#ffffff", color: "#111827", fontFamily: "Inter" },
    [
      h("div", { display: "flex", fontSize: 34, fontWeight: 700 }, d.merchant),
      h("div", { display: "flex", fontSize: 20, color: "#4b5563", marginTop: 6 }, formatSast(d.paidAt)),
      rule(),
      ...lineRows,
      rule(),
      row("Bill", R(d.base)),
      row(d.staff ? `Tip for ${d.staff}` : "Tip", R(d.tip)),
      row("Total paid", R(d.total), true),
      rule(),
      h("div", { display: "flex", flexDirection: "column", fontSize: 20, color: "#4b5563" }, [
        h("div", { display: "flex" }, `Paid with ${d.method}`),
        h("div", { display: "flex", marginTop: 4 }, `Receipt ${d.receiptNumber}`),
        h("div", { display: "flex", marginTop: 4 }, `Ref ${d.reference}`),
      ]),
      h("div", { display: "flex", justifyContent: "center", fontSize: 18, color: "#6b7280", marginTop: 28 }, `Powered by ${d.product}`),
    ],
  );
  const svg = await satori(tree as never, { width: SLIP_WIDTH, fonts: await loadFonts() });
  return new Resvg(svg, { fitTo: { mode: "width", value: SLIP_WIDTH } }).render().asPng();
}

export function methodLabel(m: string | null | undefined): string {
  switch (m) {
    case "apple_pay":
      return "Apple Pay";
    case "google_pay":
      return "Google Pay";
    case "pay_by_bank":
      return "Pay by Bank";
    case "card":
      return "card";
    default:
      return "card or wallet";
  }
}
