import type { Cents } from "./money.js";

/**
 * Adapter interfaces (ARCHITECTURE: packages/core/ports). Every external system sits behind one
 * of these. Mock/sim implementations are the default in dev and tests; real adapters arrive in
 * M8, built from the providers' current official docs (never invented endpoints).
 */

// ── Time ─────────────────────────────────────────────────────────────────────

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

// ── Payments ─────────────────────────────────────────────────────────────────

export type PaymentMethod = "card" | "apple_pay" | "google_pay" | "pay_by_bank" | "unknown";

export interface ProviderCapabilities {
  nativeSplit: boolean;
  payouts: boolean;
  tokenization: boolean;
  methods: PaymentMethod[];
}

export interface SplitInstruction {
  /** Provider-side account of the recipient (e.g. a second PayFast merchant id). */
  destination: string;
  amount: Cents;
}

export interface CreateCheckoutInput {
  /** Our reference; equals the session id so webhooks match exactly one session. */
  reference: string;
  amount: Cents;
  description: string;
  customerRef?: string;
  splits?: SplitInstruction[];
  returnUrl: string;
  webhookUrl: string;
  idempotencyKey: string;
}

export interface CheckoutResult {
  providerRef: string;
  url: string;
  expiresAt: Date;
}

export type PaymentStatus = "pending" | "succeeded" | "failed" | "cancelled" | "refunded" | "partially_refunded";

export interface VerifiedEvent {
  /** Unique per provider event; stored in webhook_events(source, external_id) for idempotency. */
  eventId: string;
  type: "payment.succeeded" | "payment.failed" | "payment.cancelled" | "refund.succeeded" | "chargeback";
  reference: string;
  providerRef: string;
  amount: Cents;
  currency: "ZAR";
  method?: PaymentMethod;
  feeCents?: Cents;
  raw: unknown;
}

export interface RefundResult {
  providerRefundRef: string;
  status: "pending" | "succeeded" | "failed";
}

export interface PayoutDestination {
  /** Opaque provider/bank reference resolved by the adapter. Never log raw bank details. */
  ref: string;
}

export interface PayoutResult {
  providerRef: string;
  status: "pending" | "sent" | "failed";
}

export class WebhookSignatureError extends Error {
  constructor(message = "webhook signature invalid") {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

export interface PaymentProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  createCheckout(i: CreateCheckoutInput): Promise<CheckoutResult>;
  /** Throws WebhookSignatureError on a bad or missing signature. */
  verifyWebhook(i: { headers: Record<string, string | undefined>; rawBody: Buffer }): Promise<VerifiedEvent>;
  getPaymentStatus(providerRef: string): Promise<PaymentStatus>;
  refund(i: { providerRef: string; amount: Cents; reason: string; idempotencyKey: string }): Promise<RefundResult>;
  createPayout?(i: { to: PayoutDestination; amount: Cents; reference: string; idempotencyKey: string }): Promise<PayoutResult>;
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────

export interface WaButton {
  id: string;
  /** Meta limit (design value): 20 characters. */
  title: string;
}

export interface WaListRow {
  id: string;
  /** Meta limit (design value): 24 characters. */
  title: string;
  description?: string;
}

export interface WaSendResult {
  messageId: string;
}

export interface WhatsAppClient {
  sendText(to: string, body: string): Promise<WaSendResult>;
  /** Max 3 reply buttons. */
  sendButtons(to: string, body: string, buttons: WaButton[]): Promise<WaSendResult>;
  /** Max 10 rows. */
  sendList(to: string, body: string, buttonLabel: string, rows: WaListRow[]): Promise<WaSendResult>;
  sendTemplate(to: string, template: string, lang: string, params: string[]): Promise<WaSendResult>;
  sendImage(to: string, imageUrl: string, caption?: string): Promise<WaSendResult>;
  /** A file by public URL (tax invoice PDF). WhatsApp fetches it. */
  sendDocument(to: string, documentUrl: string, filename: string, caption?: string): Promise<WaSendResult>;
  markRead(messageId: string): Promise<void>;
}

// ── Notifications ────────────────────────────────────────────────────────────

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushClient {
  send(sub: PushSubscriptionJson, payload: unknown): Promise<{ ok: boolean; gone: boolean }>;
}

export type MerchantEventName = "bill.claimed" | "bill.paid" | "bill.failed" | "tip.received" | "bill.abandoned";

export interface MerchantEvent {
  name: MerchantEventName;
  /** Dedupe key: one notification per event per recipient per channel (SPEC 12). */
  dedupeKey: string;
  payload: Record<string, unknown>;
}

export interface Notifier {
  notify(merchantId: string, event: MerchantEvent): Promise<void>;
}
