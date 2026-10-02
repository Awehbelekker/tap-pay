import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { inboundPayload, sign, type Inbound } from "@tappay/wa-sim";
import { createDb } from "@tappay/db";
import { E2E } from "./env";

/**
 * M4 acceptance (Playwright): a coach signs in with a WhatsApp code and PIN, creates a bill on
 * their tag, and sees it go to Paid live while a customer pays on WhatsApp; returning on the
 * same phone needs only the PIN; a manager assigns a tag by typing its code; the app shell
 * opens offline.
 */

const shot = async (page: Page, name: string) => {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}.png` });
};

const COACH = "0600000002";
const MANAGER = "0600000001";
const intl = (n: string) => `27${n.slice(1)}`;

async function otps(request: APIRequestContext, msisdn: string): Promise<string[]> {
  const r = await request.get(`${E2E.apiUrl}/sim/outbox?to=${intl(msisdn)}`);
  const items = (await r.json()).items as { kind: string; template?: string; params?: string[] }[];
  return items.filter((m) => m.kind === "template" && m.template === "otp").map((m) => m.params![0]!);
}

/** Wait for a code newer than the `seen` ones (earlier tests leave older codes in the outbox). */
async function nextOtp(request: APIRequestContext, msisdn: string, seen: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const all = await otps(request, msisdn);
    if (all.length > seen) return all.at(-1)!;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("no new OTP");
}

/** A customer on WhatsApp: signed exactly like Meta, so the API's real checks run. */
async function customerSays(request: APIRequestContext, from: string, message: Inbound) {
  const raw = Buffer.from(JSON.stringify(inboundPayload({ from, profileName: "Ann Customer", phoneNumberId: "p", displayNumber: "27600000000", message })));
  const r = await request.post(`${E2E.apiUrl}/webhooks/whatsapp`, { headers: { "content-type": "application/json", "x-hub-signature-256": sign(E2E.waAppSecret, raw) }, data: raw });
  expect(r.status()).toBe(200);
}

async function customerOutbox(request: APIRequestContext, to: string) {
  return (await (await request.get(`${E2E.apiUrl}/sim/outbox?to=${to}`)).json()).items as { kind: string; body?: string }[];
}

async function enrol(page: Page, msisdn: string, pin = "4826") {
  await page.goto("/");
  await page.getByLabel("WhatsApp number").fill(msisdn);
  const seen = (await otps(page.request, msisdn)).length;
  await page.getByRole("button", { name: "Send me a code" }).click();
  await page.getByLabel("Code").fill(await nextOtp(page.request, msisdn, seen));
  await page.getByRole("button", { name: "Continue" }).click();
  // First sign-in asks for a new PIN; a staff member who already has one goes straight in.
  const choose = page.getByLabel("New PIN (4 to 6 digits)");
  const home = page.getByRole("button", { name: "New bill" });
  await expect(choose.or(home)).toBeVisible();
  if (await choose.isVisible()) {
    await choose.fill(pin);
    await page.getByRole("button", { name: "Save PIN" }).click();
  }
  await expect(home).toBeVisible();
}

// Sign-in codes are limited to 3 per number per 15 minutes, so the tests share the two
// seeded staff: each signs in three times.

test("coach signs in, creates a bill and sees it paid live", async ({ page, request }) => {
  await enrol(page, COACH);
  await expect(page.getByRole("heading", { name: "Demo Surf School" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tags" })).toHaveCount(0); // staff: no Tags screen

  await page.getByRole("button", { name: "New bill" }).click();
  await page.getByRole("button", { name: /Beginner lesson/ }).click();
  await shot(page, "m4-1-new-bill");
  await expect(page.locator("select[name=tag]")).toHaveValue("DEMO-COACH-1");
  await page.getByRole("button", { name: "Create bill" }).click();

  await expect(page.getByTestId("bill-total")).toHaveText("R500,00");
  await expect(page.locator("[data-status]")).toHaveText("Waiting");
  await expect(page.getByAltText("QR code for this bill")).toBeVisible();
  await expect(page.getByRole("link", { name: "Send via WhatsApp" })).toHaveAttribute("href", /wa\.me\/\?text=Pay%20R500%2C00%20here/);
  await shot(page, "m4-2-bill-waiting");

  // The customer taps the tag and pays on WhatsApp.
  const ann = "27821119001";
  const tap = await request.get(`${E2E.apiUrl}/t/DEMO-COACH-1`, { maxRedirects: 0 });
  const prefilled = new URL(tap.headers().location!).searchParams.get("text")!;
  await customerSays(request, ann, { kind: "text", text: prefilled });
  await expect(page.locator("[data-status]")).toHaveText("Customer viewing");
  await customerSays(request, ann, { kind: "list_reply", id: "tip_bp_1000", title: "10%" });
  await customerSays(request, ann, { kind: "button_reply", id: "pay_now", title: "Pay now" });
  const link = (await customerOutbox(request, ann)).map((m) => m.body ?? "").find((b) => b.includes("/mock-checkout/"))!;
  const ref = /\/mock-checkout\/(\S+)/.exec(link)![1]!;

  const paidAt = Date.now();
  await request.post(`${E2E.apiUrl}/mock-checkout/${ref}`, { data: { outcome: "succeeded" } });
  await expect(page.locator("[data-status]")).toHaveText("Paid", { timeout: 5000 });
  expect(Date.now() - paidAt).toBeLessThan(5000); // SPEC 20: merchant sees paid within 5 s
  await expect(page.getByTestId("bill-total")).toHaveText("R550,00");
  await expect(page.getByText("includes R50,00 tip")).toBeVisible();
  await expect(page.getByText("Customer: Ann ***001")).toBeVisible();
  await shot(page, "m4-3-bill-paid");

  // Today shows it in the totals.
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByLabel("Today")).toContainText("R550,00");
  await expect(page.getByLabel("Today")).toContainText("R50,00");
  await shot(page, "m4-4-today");
});

test("returning on the same phone stays signed in, and signs back in with just the PIN", async ({ page }) => {
  await enrol(page, COACH);
  await page.reload();
  await expect(page.getByRole("button", { name: "New bill" })).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("Welcome back. Enter your PIN.")).toBeVisible();
  await page.getByLabel("PIN").fill("0000");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Wrong PIN.");
  await page.getByLabel("PIN").fill("4826");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "New bill" })).toBeVisible();
});

test("a manager assigns a tag by typing the code from the sticker", async ({ page }) => {
  await enrol(page, MANAGER, "5937");
  await page.getByRole("button", { name: "Tags" }).click();
  await page.getByLabel("Tag code").fill("demo-spare-1");
  await page.locator("select[name=assignee]").selectOption({ label: "Sipho" });
  await page.getByLabel("Label (optional)").fill("Spare band");
  await page.getByRole("button", { name: "Save tag" }).click();
  await expect(page.getByText("Tag DEMO-SPARE-1 saved.")).toBeVisible();
  await expect(page.getByLabel("All tags")).toContainText("Spare band · Sipho");

  await page.getByLabel("Tag code").fill("NOT-OURS-1");
  await page.getByRole("button", { name: "Save tag" }).click();
  await expect(page.getByRole("alert")).toHaveText("No tag with that code belongs to this business.");
});

test("a manager refunds part of a payment, sets the split and pays the coach's tips", async ({ page, request }) => {
  await enrol(page, MANAGER, "5937");
  await page.getByRole("button", { name: "Money" }).click();
  await expect(page.getByRole("heading", { name: "Money" })).toBeVisible();

  // The R550 payment from the first test: coach's R50 tip less their share of the card fee.
  const coachRow = page.getByLabel("Staff balances").getByRole("listitem").filter({ hasText: "Sipho" });
  await expect(coachRow).toContainText("R48,55");
  const payment = page.locator("[data-payment]").filter({ hasText: "Beginner lesson" });
  await expect(payment).toContainText("R550,00");
  await payment.getByRole("button", { name: "Refund" }).click();
  await payment.getByLabel("Refund amount").fill("110");
  await payment.getByLabel("Reason").fill("Lesson cut short");
  await payment.getByRole("button", { name: /^Refund/ }).last().click();
  await expect(page.getByRole("status")).toHaveText("Refunded R110,00. The customer has been told on WhatsApp.");
  await expect(payment).toContainText("refunded R110,00");
  // 20% refunded: the coach gives back 20% of their tip.
  await expect(coachRow).toContainText("R38,55");
  expect((await customerOutbox(request, "27821119001")).map((m) => m.body ?? "")).toContain("R110,00 was refunded by Demo Surf School. It can take a few days to show.");
  await shot(page, "m5-1-money");

  await page.getByLabel("Serving staff's share of each sale (%)").fill("70");
  await page.getByLabel("Minimum payout (R)").fill("10");
  await page.getByRole("button", { name: "Save split" }).click();
  await expect(page.getByRole("status")).toHaveText("Split saved. It applies to payments from now on.");

  await page.getByRole("button", { name: "Create today's payouts" }).click();
  await expect(page.getByRole("status")).toHaveText("1 payout created.");
  await expect(coachRow).toContainText("R0,00");
  await page.getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByRole("status")).toHaveText("Marked R38,55 to Sipho as paid.");
  await expect(page.getByLabel("Payouts")).toContainText("Paid");
  await shot(page, "m5-2-payouts");
  const coachMsgs = (await (await request.get(`${E2E.apiUrl}/sim/outbox?to=${intl(COACH)}`)).json()).items as { kind: string; template?: string }[];
  expect(coachMsgs.filter((m) => m.kind === "template" && m.template === "staff_tip_payout")).toHaveLength(1);

  // The split survives a reload.
  await page.reload();
  await expect(page.getByLabel("Serving staff's share of each sale (%)")).toHaveValue("70");
});

test("a manager sets VAT details, services and staff, reads the reports and opens a receipt", async ({ page, context }) => {
  await enrol(page, MANAGER, "5937");
  await page.getByRole("button", { name: "Business" }).click();
  const details = page.getByLabel("Business details");
  await details.getByRole("switch").check();
  await page.getByLabel("VAT number").fill("4123456789");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("alert")).toHaveText("a VAT-registered business needs its VAT number and address");
  await page.getByLabel("Business address").fill("1 Beach Rd, Muizenberg, 7945");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("status")).toHaveText("Business details saved.");

  await page.getByLabel("New service").fill("Wetsuit hire");
  await page.getByLabel("Price (R)").fill("60");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Wetsuit hire added.");
  await page.getByLabel("Price of Wetsuit hire").fill("75");
  await page.locator("[data-service='Wetsuit hire']").getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Wetsuit hire is now R75,00.");

  await page.getByLabel("Name", { exact: true }).fill("Thandi");
  await page.getByLabel("Their WhatsApp number").fill("060 000 0003");
  await page.locator("select[name=role]").selectOption("manager");
  await page.getByRole("button", { name: "Add staff member" }).click();
  await expect(page.getByRole("status")).toHaveText("Thandi added. They sign in with a code sent to their WhatsApp.");
  await expect(page.locator("[data-staff='Thandi']")).toContainText("manager · ***003");
  await shot(page, "m6-1-business");

  // Reports: the R550 payment, the R110 refund, and the ledger agrees.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Reports" }).click();
  const totals = page.getByLabel("Totals");
  await expect(totals).toContainText("R550,00");
  await expect(totals).toContainText("R110,00");
  await expect(page.getByTestId("reconciled")).toHaveText("Matches the ledger.");
  await expect(page.getByLabel("What sold")).toContainText("Beginner lesson");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^payments-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
  expect(csv).toContain("Beginner lesson");
  expect(csv).toContain(",500.00,50.00,550.00,110.00,");
  await shot(page, "m6-2-reports");

  // The customer's receipt: the slip feeds out of the printer; sound is off until turned on.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Money" }).click();
  const [receipt] = await Promise.all([context.waitForEvent("page"), page.locator("[data-payment]").filter({ hasText: "Beginner lesson" }).getByRole("link", { name: "Receipt" }).click()]);
  await expect(receipt.getByAltText(/Receipt R-\d{8}-/)).toBeVisible();
  const sound = receipt.getByRole("button", { name: /Sound/ });
  await expect(sound).toHaveAttribute("aria-pressed", "false");
  await sound.click();
  await expect(sound).toHaveText("Sound on");
  await expect(receipt.getByText("Need a tax invoice? Reply INVOICE to us on WhatsApp.")).toBeVisible();
  await expect(receipt.getByRole("link", { name: "Save PDF" })).toHaveAttribute("href", /\/slip\.pdf$/);
  await receipt.waitForTimeout(2600); // let the print animation finish for the screenshot
  await shot(receipt, "m6-3-receipt");
});

test("a customer leaves a bill unpaid; the new manager reminds them and marks it paid in cash", async ({ page, request }) => {
  // Thandi was added as a manager in the test above; this is her first sign-in.
  await enrol(page, "0600000003");
  await page.getByRole("button", { name: "New bill" }).click();
  await page.getByRole("button", { name: /Beginner lesson/ }).click();
  await page.getByLabel("Customer's WhatsApp number (optional)").fill("082 333 4444");
  await page.locator("select[name=tag]").selectOption("");
  await page.getByRole("button", { name: "Create bill" }).click();
  const share = await page.getByRole("link", { name: "Send via WhatsApp" }).getAttribute("href");
  const billPath = new URL(/https?:\/\/\S+\/b\/[A-Za-z0-9_-]+/.exec(decodeURIComponent(new URL(share!).searchParams.get("text")!))![0]).pathname;

  // The customer opens the link, sees the bill, and walks away without paying.
  const cust = "27823334444";
  const tap = await request.get(`${E2E.apiUrl}${billPath}`, { maxRedirects: 0 });
  await customerSays(request, cust, { kind: "text", text: new URL(tap.headers().location!).searchParams.get("text")! });
  await customerSays(request, cust, { kind: "list_reply", id: "tip_none", title: "No tip" });
  // Ten minutes pass (the session's time runs out), then they write again.
  const db = createDb(E2E.databaseUrl);
  await db.pool.query("update sessions set expires_at = now() - interval '1 minute' where closed_at is null and status = 'awaiting_confirm'");
  await db.close();
  await customerSays(request, cust, { kind: "text", text: "hi" });

  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Unpaid" }).click();
  const item = page.locator("[data-unpaid]").filter({ hasText: "Beginner lesson" });
  await expect(item).toContainText("R500,00");
  await expect(item).toContainText("4444"); // the merchant typed this number, so it shows in full
  await expect(item.getByTestId("reminders")).toContainText("0 of 3 reminders sent, next");
  await item.getByRole("button", { name: "Send reminder" }).click();
  // Sent now inside 08:00 to 20:00 SAST, otherwise queued for the morning.
  await expect(page.getByRole("status")).toHaveText(/^Reminder (sent\.|queued for .+)$/);
  await shot(page, "m7-1-unpaid");

  await item.getByRole("button", { name: "Paid another way" }).click();
  await item.getByLabel("How was it paid?").fill("Cash at the counter");
  await item.getByRole("button", { name: "Mark paid" }).click();
  await expect(page.getByRole("status")).toHaveText("Marked R500,00 as paid. Reminders stopped.");
  await expect(page.getByText("Nothing unpaid.")).toBeVisible();

  // Reminder settings live on the Business screen.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Business" }).click();
  await page.locator("select[name=reminderCount]").selectOption("2");
  await page.locator("select[name=reminderWindowStart]").selectOption("9");
  await page.getByRole("button", { name: "Save reminders" }).click();
  await expect(page.getByRole("status")).toHaveText("Reminder settings saved.");
});

test("the app shell opens offline", async ({ page, context }) => {
  await enrol(page, COACH);
  // Wait until the service worker controls the page, so the shell is precached.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.reload();
  // The page itself loads from the service worker, not the browser's offline error page.
  await expect(page.getByRole("heading", { name: "Offline" })).toBeVisible();
  await expect(page.getByText("No connection. Your bills will show as soon as the signal is back.")).toBeVisible();
  await context.setOffline(false);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: "New bill" })).toBeVisible();
});
