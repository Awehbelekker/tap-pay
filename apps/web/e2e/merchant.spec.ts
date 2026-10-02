import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { inboundPayload, sign, type Inbound } from "@tappay/wa-sim";
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
// seeded staff: the coach signs in twice and the manager twice.

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

test("the app shell opens offline", async ({ page, context }) => {
  await enrol(page, MANAGER, "5937");
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
