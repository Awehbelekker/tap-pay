import { useCallback, useEffect, useState } from "react";
import { api, ApiError, rands, type Me, type UnpaidBill } from "../api";
import { useLiveEvents } from "../live";
import { Button, ErrorNote, Field, Screen } from "../ui";

/** SPEC 11.4: bills customers left without paying, and what to do about them. */

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

function age(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

export function Unpaid({ me, go }: { me: Me; go: (path: string) => void }) {
  const manager = me.user.role === "manager" || me.user.role === "owner";
  const [items, setItems] = useState<UnpaidBill[] | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: UnpaidBill[] }>("/v1/merchant/unpaid")).items);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load.");
    }
  }, []);
  useEffect(() => void load(), [load]);
  useLiveEvents(() => void load(), true);

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

  return (
    <Screen title="Unpaid" back={() => go("/")}>
      {note && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {note}
        </p>
      )}
      <ErrorNote>{error}</ErrorNote>
      {items === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing unpaid. Bills appear here when a customer leaves without paying.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((b) => (
            <Item key={b.id} b={b} manager={manager} act={act} />
          ))}
        </ul>
      )}
    </Screen>
  );
}

function Item({ b, manager, act }: { b: UnpaidBill; manager: boolean; act: (fn: () => Promise<string>) => Promise<void> }) {
  const [closing, setClosing] = useState<null | "paid" | "write_off">(null);
  const [reason, setReason] = useState("");
  const who = [b.customer.name, b.customer.number ?? b.customer.maskedNumber].filter(Boolean).join(" ");
  const share = `https://wa.me/?text=${encodeURIComponent(`Your bill of ${rands(b.amountCents)} is still open. Pay here: ${b.link}`)}`;

  return (
    <li className="rounded-xl border border-slate-200 p-3" data-unpaid={b.id}>
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="font-medium">{b.description}</div>
          <div className="text-xs text-slate-500">
            {who || "Unknown customer"}
            {b.staffName ? ` · ${b.staffName}` : ""} · left {age(b.abandonedAt)}
          </div>
        </div>
        <div className="text-right">
          <div className="font-semibold tabular-nums">{rands(b.amountCents)}</div>
          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs ${b.status === "needs_follow_up" ? "bg-orange-100 text-orange-800" : "bg-amber-100 text-amber-800"}`}>
            {b.status === "needs_follow_up" ? "Follow up" : "Not paid"}
          </span>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-600" data-testid="reminders">
        {b.optedOut
          ? "Asked for no reminders. Follow up in person."
          : `${b.remindersSent} of ${b.reminderLimit} reminders sent${b.nextReminderAt ? `, next ${when(b.nextReminderAt)}` : ""}.`}
      </p>
      <div className="mt-2 flex flex-wrap gap-2 text-sm">
        {!b.optedOut && (
          <button
            className="rounded-lg bg-slate-100 px-3 py-2"
            onClick={() =>
              void act(async () => {
                const r = await api<{ status: "sent" | "queued"; dueAt: string }>(`/v1/merchant/bills/${b.id}/remind`, { method: "POST" });
                return r.status === "sent" ? "Reminder sent." : `Reminder queued for ${when(r.dueAt)} (reminders go 08:00 to 20:00, one a day).`;
              })
            }
          >
            Send reminder
          </button>
        )}
        <a className="rounded-lg bg-slate-100 px-3 py-2" href={share} target="_blank" rel="noreferrer">
          Resend link
        </a>
        <button className="rounded-lg bg-slate-100 px-3 py-2" onClick={() => setClosing(closing === "paid" ? null : "paid")}>
          Paid another way
        </button>
        {manager && (
          <button className="rounded-lg px-3 py-2 text-red-700" onClick={() => setClosing(closing === "write_off" ? null : "write_off")}>
            Write off
          </button>
        )}
      </div>
      {closing && (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api(`/v1/merchant/bills/${b.id}/${closing === "paid" ? "mark-paid-other" : "write-off"}`, { method: "POST", body: JSON.stringify({ reason }) });
              return closing === "paid" ? `Marked ${rands(b.amountCents)} as paid. Reminders stopped.` : `Wrote off ${rands(b.amountCents)}. Reminders stopped.`;
            });
          }}
        >
          <Field label={closing === "paid" ? "How was it paid?" : "Why write it off?"} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} placeholder={closing === "paid" ? "Cash at the counter" : ""} />
          <Button type="submit" variant={closing === "paid" ? "primary" : "danger"}>
            {closing === "paid" ? "Mark paid" : "Write off"}
          </Button>
        </form>
      )}
    </li>
  );
}
