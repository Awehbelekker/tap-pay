import { useCallback, useEffect, useState } from "react";
import { api, ApiError, parseRands, rands, type Balance, type Me, type MoneySettings, type Payment, type Payout, type SplitRule } from "../api";
import { Button, ErrorNote, Field, Screen } from "../ui";

/**
 * SPEC 8 to 10 in the PWA. Staff: what they are owed and their payouts. Managers also: the
 * split (serving staff's share of each sale, tip rule, who carries the card fee, payout
 * threshold), everyone's balance, payouts to mark paid, and refunds.
 */
export function Money({ me, go }: { me: Me; go: (path: string) => void }) {
  const manager = me.user.role === "manager" || me.user.role === "owner";
  const [balances, setBalances] = useState<Balance[] | null>(null);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [b, p, pay] = await Promise.all([
        api<{ items: Balance[] }>("/v1/merchant/balances"),
        api<{ items: Payout[] }>("/v1/merchant/payouts"),
        api<{ items: Payment[] }>("/v1/merchant/payments?limit=30"),
      ]);
      setBalances(b.items);
      setPayouts(p.items);
      setPayments(pay.items);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load.");
    }
  }, []);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<string>) => {
    setError("");
    setNote("");
    try {
      setNote(await fn());
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    }
  };

  const mine = balances?.find((b) => b.userId === me.user.id);
  const staff = (balances ?? []).filter((b) => b.partyKind !== "merchant" && b.userId !== null);
  const pool = balances?.find((b) => b.partyKind === "pool");

  return (
    <Screen title="Money" back={() => go("/")}>
      <section aria-label="My balance" className="rounded-xl bg-slate-50 p-4">
        <div className="text-sm text-slate-500">Owed to you</div>
        <div className="text-2xl font-semibold tabular-nums" data-testid="my-balance">
          {balances ? rands(mine?.balanceCents ?? 0) : "…"}
        </div>
        {mine && (
          <div className="mt-1 text-xs text-slate-500">
            Earned {rands(mine.earnedCents)} (tips {rands(mine.tipCents)}) · fees {rands(mine.feeCents)} · refunds {rands(mine.refundedCents)} · paid out {rands(-mine.paidOutCents)}
          </div>
        )}
      </section>

      {note && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {note}
        </p>
      )}
      <ErrorNote>{error}</ErrorNote>

      {manager && (
        <section aria-label="Staff balances">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Staff balances</h2>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {staff.map((b) => (
              <li key={b.userId} className="flex justify-between px-3 py-2">
                <span>{b.name}</span>
                <span className="tabular-nums">{rands(b.balanceCents)}</span>
              </li>
            ))}
            {pool && pool.balanceCents !== 0 && (
              <li className="flex justify-between px-3 py-2 text-slate-600">
                <span>Tips waiting (no shift running)</span>
                <span className="tabular-nums">{rands(pool.balanceCents)}</span>
              </li>
            )}
            {staff.length === 0 && <li className="px-3 py-2 text-sm text-slate-500">Nothing owed yet.</li>}
          </ul>
          <Button
            variant="secondary"
            className="mt-2 w-full"
            onClick={() =>
              void act(async () => {
                const r = await api<{ created: number }>("/v1/merchant/payouts/run", { method: "POST" });
                return r.created === 0 ? "No payouts due (below the minimum, or already done today)." : `${r.created} payout${r.created === 1 ? "" : "s"} created.`;
              })
            }
          >
            Create today's payouts
          </Button>
        </section>
      )}

      <section aria-label="Payouts">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Payouts</h2>
        {payouts.length === 0 ? (
          <p className="text-sm text-slate-500">No payouts yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {payouts.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2" data-payout={p.id}>
                <span className="flex-1">
                  <span className="block">{manager ? p.name : new Date(p.createdAt).toLocaleDateString("en-ZA")}</span>
                  <span className="block text-xs text-slate-500">{p.status === "pending" ? "To pay" : p.status === "sent" ? "Paid" : `Failed${p.failureReason ? ` (${p.failureReason.replaceAll("_", " ")})` : ""}`}</span>
                </span>
                <span className="tabular-nums">{rands(p.amountCents)}</span>
                {manager && p.status === "pending" && p.method === "manual" && (
                  <button className="rounded-lg bg-teal-700 px-3 py-2 text-sm text-white" onClick={() => void act(async () => (await api(`/v1/merchant/payouts/${p.id}/mark-paid`, { method: "POST" }), `Marked ${rands(p.amountCents)} to ${p.name} as paid.`))}>
                    Mark paid
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Payments">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Payments</h2>
        {payments.length === 0 ? (
          <p className="text-sm text-slate-500">No payments yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {payments.map((p) => (
              <PaymentRow key={p.id} p={p} manager={manager} act={act} />
            ))}
          </ul>
        )}
      </section>

      {manager && <SplitSettings act={act} />}
    </Screen>
  );
}

function PaymentRow({ p, manager, act }: { p: Payment; manager: boolean; act: (fn: () => Promise<string>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const left = p.amountCents - p.refundedCents;
  return (
    <li className="px-3 py-2" data-payment={p.id}>
      <div className="flex items-center gap-3">
        <span className="flex-1 truncate">
          <span className="block truncate">{p.description}</span>
          <span className="block text-xs text-slate-500">
            {p.maskedCustomer ?? ""}
            {p.refundedCents > 0 ? ` · refunded ${rands(p.refundedCents)}` : ""}
          </span>
        </span>
        <span className="tabular-nums">{rands(p.amountCents)}</span>
        {manager && left > 0 && (
          <button className="rounded-lg bg-slate-100 px-3 py-2 text-sm" onClick={() => setOpen(!open)}>
            Refund
          </button>
        )}
      </div>
      {open && (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const cents = amount.trim() ? parseRands(amount) : left;
            if (cents === null || cents <= 0 || cents > left) return void act(async () => Promise.reject(new ApiError(422, "bad_amount", `Enter an amount up to ${rands(left)}.`)));
            const key = crypto.randomUUID();
            void act(async () => {
              await api(`/v1/merchant/payments/${p.id}/refund`, { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify({ amountCents: cents, reason }) });
              setOpen(false);
              return `Refunded ${rands(cents)}. The customer has been told on WhatsApp.`;
            });
          }}
        >
          <Field label="Refund amount" inputMode="decimal" placeholder={rands(left)} value={amount} onChange={(e) => setAmount(e.target.value)} hint="Leave empty to refund everything left." />
          <Field label="Reason" value={reason} required minLength={3} onChange={(e) => setReason(e.target.value)} />
          <Button variant="danger" type="submit">
            Refund {amount.trim() ? "" : rands(left)}
          </Button>
        </form>
      )}
    </li>
  );
}

function SplitSettings({ act }: { act: (fn: () => Promise<string>) => Promise<void> }) {
  const [s, setS] = useState<MoneySettings | null>(null);
  const [share, setShare] = useState("0");
  const [cut, setCut] = useState("0");
  const [threshold, setThreshold] = useState("");

  useEffect(() => {
    void (async () => {
      const [settings, rules] = await Promise.all([api<MoneySettings>("/v1/merchant/settings"), api<{ items: SplitRule[] }>("/v1/merchant/split-rules")]);
      setS(settings);
      setCut(String(settings.tipHouseCutBp / 100));
      setThreshold(rands(settings.payoutThresholdCents).replace(/^R/, ""));
      const serving = rules.items.find((r) => r.serviceId === null && r.staffUserId === null);
      setShare(String((serving?.basisPoints ?? 0) / 100));
    })().catch(() => undefined);
  }, []);
  if (!s) return null;

  const save = () =>
    act(async () => {
      const pct = Number(share.replace(",", "."));
      const cutPct = Number(cut.replace(",", "."));
      const minCents = parseRands(threshold);
      if (!(pct >= 0 && pct <= 100) || !(cutPct >= 0 && cutPct <= 100) || minCents === null) throw new ApiError(422, "invalid", "Check the percentages and the minimum payout.");
      await api("/v1/merchant/split-rules", { method: "PUT", body: JSON.stringify({ rules: pct > 0 ? [{ serviceId: null, staffUserId: null, basisPoints: Math.round(pct * 100) }] : [] }) });
      await api("/v1/merchant/settings", { method: "PATCH", body: JSON.stringify({ tipRule: s.tipRule, tipHouseCutBp: Math.round(cutPct * 100), feePolicy: s.feePolicy, payoutThresholdCents: minCents }) });
      return "Split saved. It applies to payments from now on.";
    });

  return (
    <section aria-label="Split" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Split</h2>
      <Field label="Serving staff's share of each sale (%)" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} hint="The business keeps the rest. 0 = all to the business." />
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">Tips</span>
        <select name="tipRule" className="min-h-12 rounded-xl border border-slate-300 px-3" value={s.tipRule} onChange={(e) => setS({ ...s, tipRule: e.target.value as MoneySettings["tipRule"] })}>
          <option value="direct">To whoever served</option>
          <option value="pool">Shared by the shift</option>
          <option value="house_cut">To whoever served, less a house cut</option>
        </select>
      </label>
      {s.tipRule === "house_cut" && <Field label="House cut of tips (%)" inputMode="decimal" value={cut} onChange={(e) => setCut(e.target.value)} />}
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">Card fees</span>
        <select name="feePolicy" className="min-h-12 rounded-xl border border-slate-300 px-3" value={s.feePolicy} onChange={(e) => setS({ ...s, feePolicy: e.target.value as MoneySettings["feePolicy"] })}>
          <option value="proportional">Shared in proportion to each share</option>
          <option value="merchant_absorbs">The business pays them all</option>
        </select>
      </label>
      <Field label="Minimum payout (R)" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
      <Button onClick={() => void save()}>Save split</Button>
    </section>
  );
}
