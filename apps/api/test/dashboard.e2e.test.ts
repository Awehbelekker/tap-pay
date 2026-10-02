/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@tappay/config";
import { cents, formatRands } from "@tappay/core";
import { Crypto, receiptView, SEED, type DbHandle } from "@tappay/db";
import { freshTestDb } from "@tappay/db/testing";
import { testEnv } from "@tappay/testkit";
import type { Tokens } from "../src/auth.js";
import type { Reports } from "../src/reports.js";
import { slipData } from "../src/routes.js";
import { Harness } from "./harness.js";

/**
 * M6 acceptance: reports whose totals reconcile with the ledger, CSV export, the web receipt
 * (print animation, sound toggle, PDF) behind an unguessable token that a manager can revoke or
 * reissue, VAT on slips, tax invoices on request over WhatsApp, business details, services and
 * staff management, and the end-of-day summary.
 */
const url = process.env.TEST_DATABASE_URL;
const COACH = "27600000002";
const MANAGER = "27600000001";

/** Text drawn in a pdf-lib PDF (Helvetica text is written as hex strings, maybe deflated). */
function pdfText(pdf: Buffer): string {
  const out: string[] = [];
  for (const m of pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
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

describe.skipIf(!url)("dashboard, receipts and tax invoices (e2e)", () => {
  let h: DbHandle;
  let t: Harness;
  let coach: Tokens;
  let manager: Tokens;
  let seq = 0;

  beforeAll(async () => {
    h = await freshTestDb(url!, Crypto.fromConfig(loadConfig(testEnv())));
    t = new Harness(h, url!);
    await t.reset();
    coach = await t.enrol(COACH);
    manager = await t.enrol(MANAGER, "5937");
  });
  afterAll(async () => {
    await t?.close();
    await h?.close();
  });
  beforeEach(async () => {
    await h.pool.query("update bills set status = 'cancelled' where status in ('open','claimed')");
    await h.pool.query("update merchants set vat_registered = false, vat_number = null, address = null, notify_managers = 'each_payment'");
    await h.pool.query("update split_rules set active = false");
    await t.reset();
  });

  const lessonId = async () => (await t.api(coach.accessToken, "GET", "/v1/merchant/services")).json().items.find((s: any) => s.name === "Beginner lesson").id as string;

  async function pay(opts: { lines?: { description: string; amountCents: number; serviceId?: string }[]; tip?: string; customer?: string } = {}) {
    await t.flow.createBill({ merchantId: SEED.merchantId, createdBy: SEED.coachId, tagCode: SEED.tags.coach, lines: opts.lines ?? [{ description: "Lesson", amountCents: 50000 }] });
    const customer = opts.customer ?? `2782600${String(++seq).padStart(4, "0")}`;
    await t.text(customer, await t.tap(SEED.tags.coach));
    await t.pick(customer, opts.tip ?? "tip_bp_1000");
    const ref = await t.payNow(customer);
    const p = await h.db.selectFrom("payments").selectAll().where("provider_ref", "=", ref).executeTakeFirstOrThrow();
    const r = await h.db.selectFrom("receipts").select(["receipt_token", "number"]).where("payment_id", "=", p.id).executeTakeFirstOrThrow();
    return { ...p, customer, token: r.receipt_token, receiptNumber: r.number };
  }

  const vatOn = () => t.api(manager.accessToken, "PATCH", "/v1/merchant/business", { vatRegistered: true, vatNumber: "4123 456 789", address: "1 Beach Rd, Muizenberg, 7945", tradingName: "Demo Surf School" });

  // ── Reports ────────────────────────────────────────────────────────────────

  describe("reports", () => {
    it("totals reconcile with the ledger, by day, by person and by service; staff see their own", async () => {
      await t.api(manager.accessToken, "PUT", "/v1/merchant/split-rules", { rules: [{ serviceId: null, staffUserId: null, basisPoints: 7000 }] });
      const svc = await lessonId();
      const before = (await t.api(manager.accessToken, "GET", "/v1/merchant/reports/summary")).json();
      const a = await pay({ lines: [{ description: "Beginner lesson", amountCents: 50000, serviceId: svc }] });
      await pay({ lines: [{ description: "Board hire", amountCents: 15000 }], tip: "tip_none" });
      const r = await t.api(manager.accessToken, "POST", `/v1/merchant/payments/${a.id}/refund`, { amountCents: 11000, reason: "short lesson" }, { "idempotency-key": randomUUID() });
      expect(r.statusCode).toBe(200);

      const s = (await t.api(manager.accessToken, "GET", "/v1/merchant/reports/summary")).json();
      expect(s.count - before.count).toBe(2);
      expect(s.grossCents - before.grossCents).toBe(55000 + 15000);
      expect(s.tipCents - before.tipCents).toBe(5000);
      expect(s.refundCents - before.refundCents).toBe(11000);
      expect(s.reconciled).toBe(true);
      expect(s.ledger).toEqual({ creditsCents: s.grossCents, feeCents: s.feeCents, refundCents: s.refundCents });
      expect(s.netCents).toBe(s.grossCents - s.refundCents - s.feeCents);
      expect(s.byDay.reduce((n: number, d: any) => n + d.grossCents, 0)).toBe(s.grossCents);
      // Every rand is someone's: the parties' nets add up to the money kept.
      expect(s.byParty.reduce((n: number, p: any) => n + p.netCents, 0)).toBe(s.grossCents - s.feeCents - s.refundCents);
      expect(s.byParty.find((p: any) => p.userId === SEED.coachId)).toMatchObject({ name: "Sipho", tipCents: expect.any(Number), refundCents: expect.any(Number) });
      expect(s.byService).toEqual(expect.arrayContaining([expect.objectContaining({ serviceId: svc, name: "Beginner lesson", amountCents: expect.any(Number) }), expect.objectContaining({ name: "Other items" })]));

      const mine = (await t.api(coach.accessToken, "GET", "/v1/merchant/reports/summary")).json();
      expect(mine.byParty.map((p: any) => p.userId)).toEqual([SEED.coachId]);
      expect(mine.reconciled).toBe(true);

      expect((await t.api(manager.accessToken, "GET", "/v1/merchant/reports/summary?from=2026-13-01")).statusCode).toBe(422);
      expect((await t.api(manager.accessToken, "GET", "/v1/merchant/reports/summary?from=2026-10-02&to=2026-10-01")).statusCode).toBe(422);
      expect((await t.api(manager.accessToken, "GET", "/v1/merchant/reports/summary?from=2024-01-01&to=2026-01-01")).statusCode).toBe(422);
    });

    it("CSV export: one row per payment, rand amounts, safe against spreadsheet formulas; managers only", async () => {
      const p = await pay({ lines: [{ description: "=HYPERLINK(\"http://evil\")", amountCents: 2000 }], tip: "tip_none" });
      expect((await t.api(coach.accessToken, "GET", "/v1/merchant/reports/export.csv")).statusCode).toBe(403);
      const r = await t.api(manager.accessToken, "GET", "/v1/merchant/reports/export.csv");
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toMatch(/^text\/csv/);
      expect(r.headers["content-disposition"]).toMatch(/attachment; filename="payments-\d{4}-\d{2}-\d{2}-to-/);
      const lines = r.body.replace(/^\ufeff/, "").trim().split("\r\n");
      expect(lines[0]).toBe("Date,Time,Receipt,Description,Staff,Customer,Bill,Tip,Total,Refunded,Card fee,Net,Method,Status,Payment ID");
      const row = lines.find((l) => l.endsWith(p.id))!;
      expect(row).toContain(`"'=HYPERLINK(""http://evil"")"`);
      expect(row).toContain(",20.00,0.00,20.00,0.00,");
      expect(row).toContain(p.receiptNumber);
      expect(row).toMatch(/\*\*\*\d{3}/); // masked customer only
    });
  });

  // ── Receipts ───────────────────────────────────────────────────────────────

  describe("receipts", () => {
    it("the token is unguessable; the page animates the slip, has a sound toggle and a PDF, and is private", async () => {
      const p = await pay();
      expect(p.token).toMatch(/^[A-Za-z0-9_-]{32}$/); // 24 random bytes = 192 bits
      const page = await t.app.inject({ url: `/r/${p.token}` });
      expect(page.statusCode).toBe(200);
      expect(page.headers["cache-control"]).toBe("private, no-store");
      expect(page.headers["referrer-policy"]).toBe("no-referrer");
      const csp = String(page.headers["content-security-policy"]);
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
      expect(csp).toContain("default-src 'none'");
      expect(page.body).toContain(`<script nonce="${nonce}">`);
      expect(page.body).toContain("@keyframes feed");
      expect(page.body).toContain("prefers-reduced-motion");
      expect(page.body).toContain('id="sound" type="button" aria-pressed="false">Sound off');
      expect(page.body).toContain(`href="/r/${p.token}/slip.pdf"`);
      expect(page.body).not.toContain("tax invoice"); // not VAT registered

      const png = await t.app.inject({ url: `/r/${p.token}/slip.png` });
      expect(png.headers["content-type"]).toBe("image/png");
      const pdf = await t.app.inject({ url: `/r/${p.token}/slip.pdf` });
      expect(pdf.headers["content-type"]).toBe("application/pdf");
      expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

      for (const bad of ["x", "A".repeat(32), p.token.slice(0, 31) + (p.token.endsWith("A") ? "B" : "A")]) {
        expect((await t.app.inject({ url: `/r/${bad}` })).statusCode).toBe(404);
      }
    });

    it("a manager revokes a receipt link, then reissues a new one; the old link never works again", async () => {
      const p = await pay();
      expect((await t.api(coach.accessToken, "POST", `/v1/merchant/payments/${p.id}/receipt`, { action: "revoke" })).statusCode).toBe(403);
      const rev = await t.api(manager.accessToken, "POST", `/v1/merchant/payments/${p.id}/receipt`, { action: "revoke" });
      expect(rev.json()).toEqual({ receiptUrl: null });
      for (const path of ["", "/slip.png", "/slip.pdf"]) expect((await t.app.inject({ url: `/r/${p.token}${path}` })).statusCode).toBe(404);
      expect((await t.api(manager.accessToken, "GET", "/v1/merchant/payments")).json().items.find((x: any) => x.id === p.id).receiptUrl).toBeNull();

      const re = (await t.api(manager.accessToken, "POST", `/v1/merchant/payments/${p.id}/receipt`, { action: "reissue" })).json();
      const fresh = /\/r\/([A-Za-z0-9_-]{32})$/.exec(re.receiptUrl)![1]!;
      expect(fresh).not.toBe(p.token);
      expect((await t.app.inject({ url: `/r/${fresh}` })).statusCode).toBe(200);
      expect((await t.app.inject({ url: `/r/${p.token}` })).statusCode).toBe(404);
      expect((await t.api(manager.accessToken, "GET", "/v1/merchant/payments")).json().items.find((x: any) => x.id === p.id).receiptUrl).toBe(re.receiptUrl);

      const other = await t.addMerchant({ name: "Elsewhere", mode: "counter", staff: "Eve", staffMsisdn: "27600000088", staffRole: "manager", tagCode: "ELSE-TILL-2" });
      const eve = await t.enrol("27600000088", "5937", other.merchantId);
      expect((await t.api(eve.accessToken, "POST", `/v1/merchant/payments/${p.id}/receipt`, { action: "revoke" })).statusCode).toBe(404);
    });

    it("a VAT-registered merchant's slip shows its VAT number and the VAT in the bill (not the tip)", async () => {
      expect((await vatOn()).statusCode).toBe(200);
      const p = await pay();
      const slip = slipData((await receiptView(h.db, p.token))!, "TestPay");
      expect(slip.vat).toEqual({ number: "4123456789", amount: 6522 }); // R500 x 15/115
      expect((await t.app.inject({ url: `/r/${p.token}` })).body).toContain("Need a tax invoice? Reply INVOICE");
    });
  });

  // ── Business details ───────────────────────────────────────────────────────

  it("business details: VAT registration needs a valid VAT number and an address", async () => {
    expect((await t.api(coach.accessToken, "GET", "/v1/merchant/business")).statusCode).toBe(403);
    expect((await t.api(manager.accessToken, "PATCH", "/v1/merchant/business", { vatRegistered: true })).json().code).toBe("vat_details_needed");
    expect((await t.api(manager.accessToken, "PATCH", "/v1/merchant/business", { vatNumber: "123" })).json().code).toBe("bad_vat_number");
    expect((await vatOn()).statusCode).toBe(200);
    expect((await t.api(manager.accessToken, "GET", "/v1/merchant/business")).json()).toEqual({ name: "Demo Surf School", tradingName: "Demo Surf School", vatRegistered: true, vatNumber: "4123456789", address: "1 Beach Rd, Muizenberg, 7945" });
  });

  // ── Tax invoices ───────────────────────────────────────────────────────────

  describe("tax invoices over WhatsApp", () => {
    it("INVOICE, then company name and VAT number: a numbered PDF with the SARS fields; asking again resends it", async () => {
      await vatOn();
      const p = await pay();
      await t.text(p.customer, "invoice");
      expect(t.lastBody(p.customer)).toMatch(/^Tax invoice for your payment of R550,00 to Demo Surf School on \d{2} \w{3} \d{4}\. Reply with your company name and VAT number/);
      await t.text(p.customer, "Acme");
      expect(t.lastBody(p.customer)).toMatch(/^I need a company name and a 10-digit VAT number/);
      await t.text(p.customer, "Acme (Pty) Ltd, 4987654321, 5 Long St, Cape Town");
      const doc = t.last(p.customer) as any;
      expect(doc.kind).toBe("document");
      const number = /Tax invoice (INV-\d{6}) from Demo Surf School\./.exec(doc.caption)![1]!;
      const token = /\/i\/([A-Za-z0-9_-]{32})$/.exec(doc.documentUrl)![1]!;

      const r = await t.app.inject({ url: `/i/${token}` });
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toBe("application/pdf");
      expect(r.headers["cache-control"]).toBe("private, no-store");
      const text = pdfText(r.rawPayload);
      for (const want of ["TAX INVOICE", number, "Demo Surf School", "VAT no. 4123456789", "1 Beach Rd", "Acme (Pty) Ltd", "VAT no. 4987654321", "5 Long St", "Lesson", "R434,78", "R65,22", "Gratuity (no VAT)", "R550,00", p.receiptNumber]) {
        expect(text, want).toContain(want);
      }

      await t.text(p.customer, "INVOICE");
      expect((t.last(p.customer) as any).documentUrl).toBe(doc.documentUrl);
      expect((await t.app.inject({ url: `/i/${"A".repeat(32)}` })).statusCode).toBe(404);

      // The next invoice gets the next number.
      const q = await pay();
      await t.text(q.customer, "INVOICE");
      await t.text(q.customer, "Beta CC, 4111111111");
      const next = /Tax invoice (INV-\d{6})/.exec((t.last(q.customer) as any).caption)![1]!;
      expect(Number(next.slice(4))).toBe(Number(number.slice(4)) + 1);
    });

    it("explains when there is no invoice to give", async () => {
      const fresh = "27826999001";
      await t.text(fresh, "INVOICE");
      expect(t.lastBody(fresh)).toBe("I can make a tax invoice for a payment from this number in the last 30 days, and I could not find one.");

      const p = await pay(); // not VAT registered
      await t.text(p.customer, "INVOICE");
      expect(t.lastBody(p.customer)).toBe("Demo Surf School is not registered for VAT, so they cannot issue a tax invoice. Your slip is your receipt.");
    });

    it("over R5 000 the buyer's address is required", async () => {
      await vatOn();
      const p = await pay({ lines: [{ description: "Course", amountCents: 600000 }], tip: "tip_none" });
      await t.text(p.customer, "INVOICE");
      await t.text(p.customer, "Acme (Pty) Ltd, 4987654321");
      expect(t.lastBody(p.customer)).toMatch(/^Over R5 000 the invoice must show your address too/);
      await t.text(p.customer, "Acme (Pty) Ltd, 4987654321, 5 Long St, Cape Town");
      expect(t.last(p.customer).kind).toBe("document");
    });
  });

  // ── Services and staff ─────────────────────────────────────────────────────

  it("managers add services and change prices; new bills use the new price", async () => {
    expect((await t.api(coach.accessToken, "POST", "/v1/merchant/services", { name: "Wetsuit", priceCents: 5000 })).statusCode).toBe(403);
    const c = await t.api(manager.accessToken, "POST", "/v1/merchant/services", { name: "Wetsuit", priceCents: 5000 });
    expect(c.statusCode).toBe(201);
    const id = c.json().id;
    expect((await t.api(manager.accessToken, "PATCH", `/v1/merchant/services/${id}`, { priceCents: 6000 })).statusCode).toBe(200);
    const b = await t.api(coach.accessToken, "POST", "/v1/merchant/bills", { serviceId: id, tagCode: SEED.tags.coach });
    expect(b.json().subtotalCents).toBe(6000);
    await t.api(coach.accessToken, "POST", `/v1/merchant/bills/${b.json().id}/cancel`);
    expect((await t.api(manager.accessToken, "PATCH", `/v1/merchant/services/${id}`, { active: false })).statusCode).toBe(200);
    expect((await t.api(coach.accessToken, "GET", "/v1/merchant/services")).json().items.map((s: any) => s.id)).not.toContain(id);
    expect((await t.api(manager.accessToken, "GET", "/v1/merchant/services/all")).json().items.find((s: any) => s.id === id)).toMatchObject({ active: false, priceCents: 6000 });
    expect((await t.api(manager.accessToken, "PATCH", `/v1/merchant/services/${randomUUID()}`, { active: false })).statusCode).toBe(404);
  });

  it("managers add staff by number (who then sign in), change roles and deactivate, within limits", async () => {
    const add = await t.api(manager.accessToken, "POST", "/v1/merchant/staff", { name: "Thandi", msisdn: "060 000 0031" });
    expect(add.statusCode).toBe(201);
    expect((await t.api(manager.accessToken, "POST", "/v1/merchant/staff", { name: "Again", msisdn: "27600000031" })).statusCode).toBe(409);
    expect((await t.api(manager.accessToken, "POST", "/v1/merchant/staff", { name: "Boss", msisdn: "0600000032", role: "owner" })).statusCode).toBe(403);
    expect((await t.api(manager.accessToken, "POST", "/v1/merchant/staff", { name: "X", msisdn: "12345" })).statusCode).toBe(422);
    const thandi = await t.enrol("27600000031");
    expect((await t.api(thandi.accessToken, "GET", "/v1/merchant/me")).json().user).toMatchObject({ name: "Thandi", role: "staff" });

    expect((await t.api(manager.accessToken, "PATCH", `/v1/merchant/staff/${SEED.managerId}`, { active: false })).json().code).toBe("self");
    expect((await t.api(manager.accessToken, "PATCH", `/v1/merchant/staff/${add.json().id}`, { role: "manager" })).statusCode).toBe(200);
    expect((await t.api(manager.accessToken, "PATCH", `/v1/merchant/staff/${add.json().id}`, { active: false })).statusCode).toBe(200);
    expect((await t.api(thandi.accessToken, "GET", "/v1/merchant/me")).statusCode).toBe(401);
  });

  // ── End-of-day summary ─────────────────────────────────────────────────────

  it("managers who chose a daily summary get yesterday's totals once, next morning", async () => {
    await h.pool.query("update merchants set notify_managers = 'daily_summary' where id = $1", [SEED.merchantId]);
    await pay({ lines: [{ description: "Lesson", amountCents: 20000 }], tip: "tip_none" });
    const reports = (t.app as any).reports as Reports;
    // No per-payment alert to the manager.
    expect(t.wa.messagesTo(MANAGER).filter((m) => m.kind === "template" && m.template === "merchant_paid_alert")).toHaveLength(0);
    const today = (await t.api(manager.accessToken, "GET", "/v1/merchant/reports/summary")).json();

    t.clock.set(new Date(t.clock.now().getTime() + 86_400_000));
    expect(await reports.sendDailySummaries()).toMatchObject({ sent: 1 });
    expect(await reports.sendDailySummaries()).toMatchObject({ sent: 0 });
    const sent = t.wa.messagesTo(MANAGER).filter((m) => m.kind === "template" && m.template === "merchant_daily_summary") as any[];
    expect(sent).toHaveLength(1);
    const [merchant, , count, total] = sent[0].params;
    expect(merchant).toBe("Demo Surf School");
    expect(Number(count)).toBe(today.count);
    expect(total).toBe(formatRands(cents(today.grossCents)));
    // Coach (staff) gets no summary.
    expect(t.wa.messagesTo(COACH).filter((m) => m.kind === "template" && m.template === "merchant_daily_summary")).toHaveLength(0);
  });
});
