import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Screen(props: { title: string; back?: () => void; right?: ReactNode; children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col bg-white text-slate-900">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        {props.back && (
          <button onClick={props.back} aria-label="Back" className="-ml-2 rounded-lg px-2 py-1 text-xl text-slate-600">
            ‹
          </button>
        )}
        <h1 className="flex-1 truncate text-lg font-semibold">{props.title}</h1>
        {props.right}
      </header>
      <div className="flex flex-1 flex-col gap-4 p-4">{props.children}</div>
    </main>
  );
}

export function Button({ variant = "primary", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" }) {
  const styles = {
    primary: "bg-teal-700 text-white disabled:bg-teal-700/50",
    secondary: "bg-slate-100 text-slate-900 disabled:text-slate-400",
    danger: "bg-red-50 text-red-700 disabled:text-red-300",
  }[variant];
  return <button className={`min-h-12 rounded-xl px-4 text-base font-medium ${styles} ${className}`} {...p} />;
}

export function Field({ label, hint, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <input className="min-h-12 rounded-xl border border-slate-300 px-3 text-base outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20" {...p} />
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
      {children}
    </p>
  );
}

const STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: "Waiting", cls: "bg-amber-100 text-amber-800" },
  claimed: { label: "Customer viewing", cls: "bg-sky-100 text-sky-800" },
  paid: { label: "Paid", cls: "bg-emerald-100 text-emerald-800" },
  paid_other: { label: "Paid another way", cls: "bg-emerald-50 text-emerald-700" },
  cancelled: { label: "Cancelled", cls: "bg-slate-100 text-slate-600" },
  expired: { label: "Expired", cls: "bg-slate-100 text-slate-600" },
  abandoned: { label: "Not finished", cls: "bg-orange-100 text-orange-800" },
  needs_follow_up: { label: "Follow up", cls: "bg-orange-100 text-orange-800" },
  written_off: { label: "Written off", cls: "bg-slate-100 text-slate-600" },
};

const TAG_STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "Active", cls: "bg-emerald-100 text-emerald-800" },
  unassigned: { label: "Not set up", cls: "bg-slate-100 text-slate-600" },
  revoked: { label: "Revoked", cls: "bg-red-50 text-red-700" },
  lost: { label: "Lost", cls: "bg-red-50 text-red-700" },
};

export function TagBadge({ status }: { status: string }) {
  const s = TAG_STATUS[status] ?? { label: status, cls: "bg-slate-100 text-slate-700" };
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, cls: "bg-slate-100 text-slate-700" };
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`} data-status={status}>{s.label}</span>;
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-teal-700" aria-label="Loading" />;
}
