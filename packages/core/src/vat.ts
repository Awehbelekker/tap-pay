import { cents, type Cents } from "./money.js";

/**
 * South African VAT (SPEC 14). Prices are VAT-inclusive, as customers see them. The VAT in an
 * inclusive amount is amount x rate / (1 + rate), rounded half up to the cent. Tips are not
 * part of the supply and carry no VAT (OPEN_QUESTIONS L4, I31) until an accountant confirms.
 */

/** Standard rate in basis points (15%). */
export const VAT_RATE_BP = 1500;

/** VAT contained in a VAT-inclusive amount, rounded half up. */
export function vatIncluded(inclusive: Cents, rateBp: number = VAT_RATE_BP): Cents {
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10000) throw new RangeError(`bad VAT rate ${rateBp}`);
  const num = BigInt(inclusive) * BigInt(rateBp);
  const den = BigInt(10000 + rateBp);
  return cents(Number((num * 2n + den) / (den * 2n)));
}

/** SARS VAT registration numbers are 10 digits starting with 4. */
export function normaliseVatNumber(input: string): string | null {
  const t = input.replace(/[\s-]/g, "");
  return /^4\d{9}$/.test(t) ? t : null;
}

/** Above this the buyer's name, address and VAT number must appear (full tax invoice). */
export const FULL_TAX_INVOICE_THRESHOLD_CENTS = 500_000;

/**
 * What the customer sends for a tax invoice: "Company name, VAT number[, address]".
 * Returns null unless there is a name and a valid VAT number.
 */
export function parseInvoiceDetails(text: string): { name: string; vat: string; address: string | null } | null {
  const parts = text.split(/[,;\n]/).map((p) => p.trim()).filter(Boolean);
  const vatIdx = parts.findIndex((p) => normaliseVatNumber(p) !== null);
  if (vatIdx < 1) return null;
  const name = parts.slice(0, vatIdx).join(", ").slice(0, 120);
  if (name.length < 2) return null;
  const address = parts.slice(vatIdx + 1).join(", ").slice(0, 200) || null;
  return { name, vat: normaliseVatNumber(parts[vatIdx]!)!, address };
}
