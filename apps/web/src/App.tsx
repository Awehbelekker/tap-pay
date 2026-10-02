import { useEffect, useState } from "react";

/**
 * Merchant PWA shell (M0). Sign-in, bills, live status and the Unpaid tab arrive in M4/M7.
 * Shows the API's readiness so a fresh clone can confirm the stack is wired end to end.
 */
const API = import.meta.env.VITE_PUBLIC_API_URL ?? "http://localhost:3000";
const PRODUCT = import.meta.env.VITE_PRODUCT_NAME ?? "Tap to pay";

type Status = "checking" | "ready" | "not ready" | "offline";

export function App() {
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/readyz`)
      .then((r) => !cancelled && setStatus(r.ok ? "ready" : "not ready"))
      .catch(() => !cancelled && setStatus("offline"));
    return () => {
      cancelled = true;
    };
  }, []);

  const colour = status === "ready" ? "bg-emerald-500" : status === "checking" ? "bg-slate-400" : "bg-red-500";

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-6 bg-white p-4 text-slate-900">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{PRODUCT}</h1>
        <span className="flex items-center gap-2 text-sm text-slate-600">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${colour}`} aria-hidden />
          API {status}
        </span>
      </header>
      <section className="rounded-xl border border-slate-200 p-4">
        <h2 className="font-medium">Merchant app</h2>
        <p className="mt-1 text-sm text-slate-600">
          Create bills, see payments live and follow up unpaid bills. Coming in milestone M4.
        </p>
      </section>
    </main>
  );
}
