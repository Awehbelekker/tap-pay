import { useEffect, useState } from "react";
import { api, apiBlob, ApiError, rands, type Me, type ReportSummary } from "../api";
import { Button, ErrorNote, Screen } from "../ui";

/** SPEC 16 reports: totals for a period, by person, by service and by day; CSV for managers. */

const sast = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(d);
const DAY = 86_400_000;

function ranges(now = new Date()): { id: string; label: string; from: string; to: string }[] {
  const today = sast(now);
  return [
    { id: "today", label: "Today", from: today, to: today },
    { id: "yesterday", label: "Yesterday", from: sast(new Date(now.getTime() - DAY)), to: sast(new Date(now.getTime() - DAY)) },
    { id: "week", label: "7 days", from: sast(new Date(now.getTime() - 6 * DAY)), to: today },
    { id: "month", label: "This month", from: `${today.slice(0, 8)}01`, to: today },
  ];
}

export function Reports({ me, go }: { me: Me; go: (path: string) => void }) {
  const manager = me.user.role === "manager" || me.user.role === "owner";
  const options = ranges();
  const [pick, setPick] = useState("today");
  const [r, setR] = useState<ReportSummary | null>(null);
  const [error, setError] = useState("");
  const range = options.find((o) => o.id === pick)!;

  useEffect(() => {
    setR(null);
    api<ReportSummary>(`/v1/merchant/reports/summary?from=${range.from}&to=${range.to}`)
      .then(setR)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load the report."));
  }, [range.from, range.to]);

  const download = async () => {
    setError("");
    try {
      const blob = await apiBlob(`/v1/merchant/reports/export.csv?from=${range.from}&to=${range.to}`);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `payments-${range.from}-to-${range.to}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not download.");
    }
  };

  return (
    <Screen title="Reports" back={() => go("/")}>
      <div role="tablist" aria-label="Period" className="flex gap-2 overflow-x-auto">
        {options.map((o) => (
          <button key={o.id} role="tab" aria-selected={pick === o.id} onClick={() => setPick(o.id)} className={`whitespace-nowrap rounded-full px-3 py-2 text-sm ${pick === o.id ? "bg-teal-700 text-white" : "bg-slate-100"}`}>
            {o.label}
          </button>
        ))}
      </div>
      <ErrorNote>{error}</ErrorNote>
      {!r ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <>
          <section aria-label="Totals" className="grid grid-cols-2 gap-2">
            <Stat label={`Paid (${r.count})`} value={rands(r.grossCents)} />
            <Stat label="Tips" value={rands(r.tipCents)} />
            <Stat label={`Refunds (${r.refundCount})`} value={rands(r.refundCents)} />
            <Stat label="Card fees" value={rands(r.feeCents)} />
            <div className="col-span-2">
              <Stat label="Net after refunds and fees" value={rands(r.netCents)} />
            </div>
          </section>
          <p className={`text-xs ${r.reconciled ? "text-emerald-700" : "text-red-700"}`} data-testid="reconciled">
            {r.reconciled ? "Matches the ledger." : "Does not match the ledger. Please tell support."}
          </p>

          <Table
            title={manager ? "By person" : "Your earnings"}
            rows={r.byParty.map((p) => [p.name ?? "", rands(p.salesCents + p.tipCents), rands(p.netCents)])}
            head={["", "Earned", "Net"]}
            empty="No payments in this period."
          />
          <Table title="What sold" rows={r.byService.map((s) => [`${s.name} (${s.count})`, rands(s.amountCents)])} head={["", "Amount"]} empty="Nothing sold in this period." />
          {r.byDay.length > 1 && <Table title="By day" rows={r.byDay.map((d) => [d.date, String(d.count), rands(d.grossCents)])} head={["", "Payments", "Paid"]} empty="" />}

          {manager && (
            <Button variant="secondary" onClick={() => void download()}>
              Download CSV
            </Button>
          )}
        </>
      )}
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-3">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}

function Table({ title, head, rows, empty }: { title: string; head: string[]; rows: string[][]; empty: string }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{empty}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              {head.map((h, i) => (
                <th key={i} className={`py-1 font-medium ${i > 0 ? "text-right" : ""}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((c, j) => (
                  <td key={j} className={`py-2 ${j > 0 ? "text-right tabular-nums" : ""}`}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
