import { useCallback, useEffect, useState } from "react";
import { api, ApiError, parseRands, rands, type Business as BusinessT, type Me, type StaffMember } from "../api";
import { Button, ErrorNote, Field, Screen } from "../ui";

/** SPEC 16 for managers: business and VAT details, services and prices, staff. */

interface ServiceRow {
  id: string;
  name: string;
  priceCents: number;
  active: boolean;
}

export function Business({ me, go }: { me: Me; go: (path: string) => void }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const act = async (fn: () => Promise<string>) => {
    setError("");
    setNote("");
    try {
      setNote(await fn());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong.");
    }
  };

  return (
    <Screen title="Business" back={() => go("/")}>
      {note && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {note}
        </p>
      )}
      <ErrorNote>{error}</ErrorNote>
      <Details act={act} />
      <Services act={act} />
      <Staff me={me} act={act} />
    </Screen>
  );
}

type Act = (fn: () => Promise<string>) => Promise<void>;

function Details({ act }: { act: Act }) {
  const [b, setB] = useState<BusinessT | null>(null);
  useEffect(() => {
    api<BusinessT>("/v1/merchant/business")
      .then(setB)
      .catch(() => undefined);
  }, []);
  if (!b) return null;
  const save = () =>
    act(async () => {
      await api("/v1/merchant/business", { method: "PATCH", body: JSON.stringify({ name: b.name, tradingName: b.tradingName || null, vatRegistered: b.vatRegistered, vatNumber: b.vatNumber || null, address: b.address || null }) });
      return "Business details saved.";
    });
  return (
    <section aria-label="Business details" className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Details on slips and invoices</h2>
      <Field label="Registered name" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} />
      <Field label="Trading name (optional)" value={b.tradingName ?? ""} onChange={(e) => setB({ ...b, tradingName: e.target.value })} />
      <label className="flex min-h-12 items-center justify-between gap-3">
        <span>Registered for VAT</span>
        <input type="checkbox" role="switch" checked={b.vatRegistered} onChange={(e) => setB({ ...b, vatRegistered: e.target.checked })} className="h-6 w-11 accent-teal-700" />
      </label>
      {b.vatRegistered && (
        <>
          <Field label="VAT number" inputMode="numeric" value={b.vatNumber ?? ""} onChange={(e) => setB({ ...b, vatNumber: e.target.value })} hint="10 digits, starts with 4. Shown on slips; customers can ask for a tax invoice." />
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-slate-700">Business address</span>
            <textarea rows={3} className="rounded-xl border border-slate-300 px-3 py-2 text-base" value={b.address ?? ""} onChange={(e) => setB({ ...b, address: e.target.value })} />
          </label>
        </>
      )}
      <Button onClick={() => void save()}>Save details</Button>
    </section>
  );
}

function Services({ act }: { act: Act }) {
  const [items, setItems] = useState<ServiceRow[]>([]);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const load = useCallback(() => api<{ items: ServiceRow[] }>("/v1/merchant/services/all").then((r) => setItems(r.items)), []);
  useEffect(() => void load().catch(() => undefined), [load]);

  return (
    <section aria-label="Services" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Services and prices</h2>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {items.map((s) => (
          <ServiceItem key={s.id} s={s} act={act} reload={load} />
        ))}
      </ul>
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const cents = parseRands(price);
          void act(async () => {
            if (!name.trim() || cents === null) throw new ApiError(422, "invalid", "Enter a name and a price.");
            await api("/v1/merchant/services", { method: "POST", body: JSON.stringify({ name: name.trim(), priceCents: cents }) });
            setName("");
            setPrice("");
            await load();
            return `${name.trim()} added.`;
          });
        }}
      >
        <div className="min-w-0 flex-1">
          <Field label="New service" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="w-24 shrink-0">
          <Field label="Price (R)" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <Button type="submit" variant="secondary">
          Add
        </Button>
      </form>
    </section>
  );
}

function ServiceItem({ s, act, reload }: { s: ServiceRow; act: Act; reload: () => Promise<void> }) {
  const [price, setPrice] = useState(rands(s.priceCents).slice(1));
  const patch = (body: object, msg: string) =>
    act(async () => {
      await api(`/v1/merchant/services/${s.id}`, { method: "PATCH", body: JSON.stringify(body) });
      await reload();
      return msg;
    });
  return (
    <li className={`flex items-center gap-2 px-3 py-2 ${s.active ? "" : "opacity-50"}`} data-service={s.name}>
      <span className="flex-1 truncate">{s.name}</span>
      <input aria-label={`Price of ${s.name}`} className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-right" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      <button
        className="rounded-lg bg-slate-100 px-2 py-1 text-sm"
        onClick={() => {
          const c = parseRands(price);
          if (c === null) return void act(async () => Promise.reject(new ApiError(422, "invalid", "That price is not a rand amount.")));
          void patch({ priceCents: c }, `${s.name} is now ${rands(c)}.`);
        }}
      >
        Save
      </button>
      <button className="rounded-lg px-2 py-1 text-sm text-slate-600" onClick={() => void patch({ active: !s.active }, s.active ? `${s.name} hidden.` : `${s.name} back on the list.`)}>
        {s.active ? "Hide" : "Show"}
      </button>
    </li>
  );
}

function Staff({ me, act }: { me: Me; act: Act }) {
  const [items, setItems] = useState<StaffMember[]>([]);
  const [name, setName] = useState("");
  const [msisdn, setMsisdn] = useState("");
  const [role, setRole] = useState("staff");
  const load = useCallback(() => api<{ items: StaffMember[] }>("/v1/merchant/staff").then((r) => setItems(r.items)), []);
  useEffect(() => void load().catch(() => undefined), [load]);

  const patch = (id: string, body: object, msg: string) =>
    act(async () => {
      await api(`/v1/merchant/staff/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      await load();
      return msg;
    });

  return (
    <section aria-label="Staff" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Staff</h2>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {items.map((u) => (
          <li key={u.id} className={`flex items-center gap-2 px-3 py-2 ${u.active ? "" : "opacity-50"}`} data-staff={u.name}>
            <span className="flex-1">
              <span className="block">{u.name}</span>
              <span className="block text-xs text-slate-500">
                {u.role} · {u.maskedNumber}
                {u.active ? "" : " · deactivated"}
              </span>
            </span>
            {u.id !== me.user.id && u.role !== "owner" && (
              <>
                <button className="rounded-lg bg-slate-100 px-2 py-1 text-sm" onClick={() => void patch(u.id, { role: u.role === "staff" ? "manager" : "staff" }, `${u.name} is now ${u.role === "staff" ? "a manager" : "staff"}.`)}>
                  {u.role === "staff" ? "Make manager" : "Make staff"}
                </button>
                <button className="rounded-lg px-2 py-1 text-sm text-red-700" onClick={() => void patch(u.id, { active: !u.active }, u.active ? `${u.name} can no longer sign in.` : `${u.name} can sign in again.`)}>
                  {u.active ? "Deactivate" : "Reactivate"}
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api("/v1/merchant/staff", { method: "POST", body: JSON.stringify({ name: name.trim(), msisdn, role }) });
            const who = name.trim();
            setName("");
            setMsisdn("");
            await load();
            return `${who} added. They sign in with a code sent to their WhatsApp.`;
          });
        }}
      >
        <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="Their WhatsApp number" inputMode="tel" value={msisdn} onChange={(e) => setMsisdn(e.target.value)} />
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Role</span>
          <select name="role" className="min-h-12 rounded-xl border border-slate-300 px-3" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="staff">Staff</option>
            <option value="manager">Manager</option>
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Add staff member
        </Button>
      </form>
    </section>
  );
}
