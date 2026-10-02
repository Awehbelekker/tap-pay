import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatRands, type Cents } from "@tappay/core";
import { formatSast } from "./index.js";

/**
 * PDFs for receipts and tax invoices (SPEC 14). pdf-lib with the standard Helvetica fonts, so no
 * font files ship and nothing is fetched. Helvetica only covers Latin-1: other characters are
 * replaced, which the tests pin down.
 */

/** Keep text within the WinAnsi set Helvetica can draw. */
export function pdfSafe(s: string): string {
  return s
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x20-\x7e\u00a1-\u00ff]/gu, "?");
}

const R = (c: number) => pdfSafe(formatRands(c as Cents));

/** The slip PNG on an A6-ish page, for printing or saving. */
export async function renderSlipPdf(png: Buffer, title: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(title));
  doc.setProducer("tap-pay");
  doc.setCreationDate(new Date(0)); // deterministic output
  doc.setModificationDate(new Date(0));
  const img = await doc.embedPng(png);
  const width = 300;
  const height = (img.height / img.width) * width;
  const page = doc.addPage([width + 40, height + 40]);
  page.drawImage(img, { x: 20, y: 20, width, height });
  return Buffer.from(await doc.save());
}

export interface TaxInvoiceData {
  number: string;
  issuedAt: Date;
  supplyDate: Date;
  seller: { name: string; tradingName: string | null; vatNumber: string; address: string };
  buyer: { name: string; vatNumber: string; address: string | null };
  /** VAT-inclusive line amounts (the bill as the customer paid it). */
  lines: { description: string; amount: Cents }[];
  /** Sum of lines: the taxable supply, VAT inclusive. */
  inclusive: Cents;
  vat: Cents;
  tip: Cents;
  total: Cents;
  receiptNumber: string;
  refunded: Cents;
  product: string;
}

class Writer {
  y: number;
  constructor(
    private readonly page: PDFPage,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
    top: number,
  ) {
    this.y = top;
  }
  text(s: string, o: { x?: number; size?: number; bold?: boolean; color?: [number, number, number] } = {}) {
    const size = o.size ?? 10;
    this.page.drawText(pdfSafe(s), { x: o.x ?? 50, y: this.y, size, font: o.bold ? this.bold : this.font, color: rgb(...(o.color ?? [0.07, 0.09, 0.15])) });
  }
  right(s: string, xRight: number, o: { size?: number; bold?: boolean } = {}) {
    const size = o.size ?? 10;
    const f = o.bold ? this.bold : this.font;
    const t = pdfSafe(s);
    this.page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y: this.y, size, font: f, color: rgb(0.07, 0.09, 0.15) });
  }
  down(n = 14) {
    this.y -= n;
  }
  rule() {
    this.page.drawLine({ start: { x: 50, y: this.y + 4 }, end: { x: 545, y: this.y + 4 }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
    this.down(10);
  }
}

/**
 * A tax invoice (VAT Act s20; format to be confirmed by an accountant, OPEN_QUESTIONS L4):
 * the words "Tax Invoice", seller name, address and VAT number, buyer name, address and VAT
 * number, serial number, date, description, the VAT-inclusive value and the VAT it contains.
 */
export async function renderTaxInvoicePdf(d: TaxInvoiceData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`Tax invoice ${d.number}`));
  doc.setAuthor(pdfSafe(d.seller.name));
  doc.setProducer("tap-pay");
  doc.setCreationDate(d.issuedAt);
  doc.setModificationDate(d.issuedAt);
  const page = doc.addPage([595, 842]); // A4
  const w = new Writer(page, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold), 780);
  const right = 545;

  w.text("TAX INVOICE", { size: 20, bold: true });
  w.right(d.number, right, { size: 12, bold: true });
  w.down(18);
  w.right(`Date: ${formatSast(d.issuedAt)}`, right);
  w.down(26);

  w.text("From", { bold: true });
  w.text("To", { x: 310, bold: true });
  w.down();
  const sellerLines = [d.seller.tradingName && d.seller.tradingName !== d.seller.name ? `${d.seller.name} t/a ${d.seller.tradingName}` : d.seller.name, ...d.seller.address.split(/\n|, /), `VAT no. ${d.seller.vatNumber}`];
  const buyerLines = [d.buyer.name, ...(d.buyer.address ? d.buyer.address.split(/\n|, /) : []), `VAT no. ${d.buyer.vatNumber}`];
  const top = w.y;
  for (const l of sellerLines) {
    w.text(l);
    w.down();
  }
  const afterSeller = w.y;
  w.y = top;
  for (const l of buyerLines) {
    w.text(l, { x: 310 });
    w.down();
  }
  w.y = Math.min(w.y, afterSeller) - 16;

  w.text(`Date of supply: ${formatSast(d.supplyDate)}    Receipt: ${d.receiptNumber}`, { size: 9, color: [0.3, 0.33, 0.38] });
  w.down(22);
  w.text("Description", { bold: true });
  w.right("Amount (incl. VAT)", right, { bold: true });
  w.down(6);
  w.rule();
  for (const l of d.lines) {
    w.text(l.description.slice(0, 80));
    w.right(R(l.amount), right);
    w.down();
  }
  w.down(4);
  w.rule();
  const sum = (label: string, value: string, bold = false) => {
    w.text(label, { x: 330, bold });
    w.right(value, right, { bold });
    w.down();
  };
  sum("Total excl. VAT", R(d.inclusive - d.vat));
  sum("VAT at 15%", R(d.vat));
  sum("Total incl. VAT", R(d.inclusive), true);
  if (d.tip > 0) sum("Gratuity (no VAT)", R(d.tip));
  sum("Amount paid", R(d.total), true);
  if (d.refunded > 0) sum("Refunded since", `-${R(d.refunded)}`);
  w.down(20);
  w.text(`Paid by card or wallet. Issued through ${d.product}.`, { size: 9, color: [0.42, 0.45, 0.5] });
  return Buffer.from(await doc.save());
}
