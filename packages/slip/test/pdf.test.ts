import { inflateSync } from "node:zlib";
import { cents } from "@tappay/core";
import { describe, expect, it } from "vitest";
import { pdfSafe, renderSlipPdf, renderSlipPng, renderTaxInvoicePdf, type TaxInvoiceData } from "../src/index.js";

/** The text drawn on the pages (pdf-lib writes Helvetica text as hex strings, maybe deflated). */
export function pdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let body = Buffer.from(m[1]!, "latin1");
    try {
      body = inflateSync(body);
    } catch {
      /* not compressed */
    }
    for (const t of body.toString("latin1").matchAll(/<([0-9A-Fa-f]*)> Tj/g)) out.push(Buffer.from(t[1]!, "hex").toString("latin1"));
  }
  return out.join("\n");
}

const invoice: TaxInvoiceData = {
  number: "INV-000001",
  issuedAt: new Date("2026-10-02T12:30:00Z"),
  supplyDate: new Date("2026-10-02T12:05:00Z"),
  seller: { name: "Demo Surf School (Pty) Ltd", tradingName: "Demo Surf School", vatNumber: "4123456789", address: "1 Beach Rd, Muizenberg, 7945" },
  buyer: { name: "Acme (Pty) Ltd", vatNumber: "4987654321", address: null },
  lines: [{ description: "Beginner lesson", amount: cents(50000) }],
  inclusive: cents(50000),
  vat: cents(6522),
  tip: cents(5000),
  total: cents(55000),
  receiptNumber: "R-20261002-ABC123",
  refunded: cents(0),
  product: "TestPay",
};

describe("PDFs", () => {
  it("tax invoice carries the fields SARS asks for", async () => {
    const pdf = await renderTaxInvoicePdf(invoice);
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const text = pdfText(pdf);
    for (const want of ["TAX INVOICE", "INV-000001", "Demo Surf School (Pty) Ltd t/a Demo Surf School", "VAT no. 4123456789", "Acme (Pty) Ltd", "VAT no. 4987654321", "1 Beach Rd", "Beginner lesson", "Total excl. VAT", "VAT at 15%", "Gratuity (no VAT)", "Amount paid"]) {
      expect(text, want).toContain(want);
    }
    expect(text).toContain("R434,78"); // 50000 - 6522 = 43478 cents
    expect(text).toContain("R65,22");
  });

  it("slip PDF wraps the PNG", async () => {
    const png = await renderSlipPng({ product: "TestPay", merchant: "Shop", receiptNumber: "R-1", reference: "abc", paidAt: new Date(), lines: [], base: cents(0), tip: cents(1000), total: cents(1000), method: "card", staff: null, vat: { number: "4123456789", amount: cents(0) } });
    const pdf = await renderSlipPdf(png, "Receipt R-1");
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(png.length / 2);
  });

  it("only draws characters Helvetica has", () => {
    expect(pdfSafe("R1 234,50 — Zoë’s 🌊")).toBe("R1 234,50 - Zoë's ?");
  });
});
