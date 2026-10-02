import { useCallback, useEffect, useState } from "react";
import { api, rands, type Bill, type Me, type Today as TodayT } from "../api";
import { paidSignal, useLiveEvents } from "../live";
import { Button, Screen, StatusBadge } from "../ui";

/** SPEC 15 "Today": totals, tips, recent bills, live status. */
export function Today({ me, go }: { me: Me; go: (path: string) => void }) {
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [today, setToday] = useState<TodayT | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [offline, setOffline] = useState(!navigator.onLine);

  const load = useCallback(async () => {
    try {
      const [b, t] = await Promise.all([api<{ items: Bill[] }>("/v1/merchant/bills?limit=30"), api<TodayT>("/v1/merchant/reports/today")]);
      setBills(b.items);
      setToday(t);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const on = () => (setOffline(false), void load());
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [load]);

  useLiveEvents((e) => {
    if (e.name === "bill.paid") {
      paidSignal();
      setFlash(`Paid ${rands(Number(e.data.totalCents ?? 0))}`);
      setTimeout(() => setFlash(null), 4000);
    }
    void load();
  }, true);

  const live = (bills ?? []).filter((b) => b.status === "open" || b.status === "claimed");
  const recent = (bills ?? []).filter((b) => b.status !== "open" && b.status !== "claimed").slice(0, 15);

  return (
    <Screen
      title={me.merchant.name}
      right={
        <button onClick={() => go("/settings")} className="rounded-lg px-2 py-1 text-sm text-slate-600" aria-label="Settings">
          {me.user.name}
        </button>
      }
    >
      {offline && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Offline. Bills update when the signal returns.</p>}
      {flash && (
        <p role="status" className="rounded-xl bg-emerald-600 px-4 py-3 text-center text-lg font-semibold text-white">
          {flash}
        </p>
      )}

      <section className="grid grid-cols-3 gap-2 text-center" aria-label="Today">
        <Stat label="Paid today" value={today ? rands(today.totalCents) : "…"} />
        <Stat label="Tips" value={today ? rands(today.tipCents) : "…"} />
        <Stat label="Payments" value={today ? String(today.count) : "…"} />
      </section>

      <Button onClick={() => go("/new")}>New bill</Button>

      <BillList title="Waiting" bills={live} go={go} empty="No open bills." />
      <BillList title="Recent" bills={recent} go={go} empty="Nothing yet today." />

      <nav aria-label="More" className="grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={() => go("/money")}>
          Money
        </Button>
        <Button variant="secondary" onClick={() => go("/reports")}>
          Reports
        </Button>
        <Button variant="secondary" onClick={() => go("/unpaid")}>
          Unpaid
        </Button>
        {(me.user.role === "manager" || me.user.role === "owner") && (
          <>
            <Button variant="secondary" onClick={() => go("/tags")}>
              Tags
            </Button>
            <Button variant="secondary" onClick={() => go("/business")}>
              Business
            </Button>
          </>
        )}
      </nav>
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-2 py-3">
      <div className="text-base font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function BillList({ title, bills, go, empty }: { title: string; bills: Bill[]; go: (p: string) => void; empty: string }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {bills.length === 0 ? (
        <p className="text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {bills.map((b) => (
            <li key={b.id}>
              <button onClick={() => go(`/bill/${b.id}`)} className="flex w-full items-center gap-3 px-3 py-3 text-left" data-bill={b.id}>
                <span className="flex-1 truncate">
                  <span className="block truncate font-medium">{b.type === "quick_tip" ? "Quick tip" : b.lines.map((l) => l.description).join(", ") || "Amount"}</span>
                  <span className="block text-xs text-slate-500">
                    {b.tagCode ?? "Link"}
                    {b.maskedCustomer ? ` · ${b.customerName ?? ""} ${b.maskedCustomer}` : ""}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block font-semibold tabular-nums">{rands(b.subtotalCents + b.tipCents)}</span>
                  <StatusBadge status={b.status} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
