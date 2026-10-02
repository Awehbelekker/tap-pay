import { useEffect, useMemo, useState } from "react";
import { api, ApiError, parseRands, rands, serviceCache, type Bill, type Me, type Service, type Tag } from "../api";
import { Button, ErrorNote, Field, Screen } from "../ui";

/**
 * SPEC 15 "New bill": pick a service or type an amount, optionally add the customer's
 * WhatsApp number, choose the tag (default: my own). Creating needs a connection; the service
 * list is cached so the screen opens on a weak signal.
 */
export function NewBill({ me, go }: { me: Me; go: (path: string) => void }) {
  const [services, setServices] = useState<Service[]>(serviceCache.get());
  const [tags, setTags] = useState<Tag[]>([]);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [customer, setCustomer] = useState("");
  const [tagCode, setTagCode] = useState<string>(me.myTags[0]?.code ?? "");
  const [shares, setShares] = useState(1);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per form, so a double tap or a retry on a bad signal never makes two bills.
  const idemKey = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    api<{ items: Service[] }>("/v1/merchant/services")
      .then((r) => {
        setServices(r.items);
        serviceCache.set(r.items);
      })
      .catch(() => undefined);
    api<{ items: Tag[] }>("/v1/merchant/tags")
      .then((r) => setTags(r.items.filter((t) => t.status === "active")))
      .catch(() => undefined);
  }, []);

  const typed = parseRands(amount);
  const ready = serviceId !== null || (typed !== null && typed > 0);

  const create = async () => {
    if (!navigator.onLine) return setError("Creating a bill needs a connection.");
    setBusy(true);
    setError("");
    try {
      const body = {
        ...(serviceId ? { serviceId } : { lines: [{ description: description.trim() || "Amount", amountCents: typed! }] }),
        tagCode: tagCode || null,
        customerMsisdn: customer.trim() || null,
        ...(shares > 1 ? { shares: { equal: shares } } : {}),
      };
      const bill = await api<Bill>("/v1/merchant/bills", { method: "POST", body: JSON.stringify(body), headers: { "idempotency-key": idemKey } });
      go(`/bill/${bill.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? (e.code === "tag_busy" ? "That tag already has an open bill. Finish or cancel it first." : e.message) : "No connection. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen title="New bill" back={() => go("/")}>
      {services.length > 0 && (
        <section aria-label="Services" className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-slate-700">Service</h2>
          <div className="grid grid-cols-2 gap-2">
            {services.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setServiceId(serviceId === s.id ? null : s.id);
                  setAmount("");
                }}
                aria-pressed={serviceId === s.id}
                className={`rounded-xl border px-3 py-3 text-left ${serviceId === s.id ? "border-teal-700 bg-teal-50" : "border-slate-200"}`}
              >
                <span className="block font-medium">{s.name}</span>
                <span className="block text-sm text-slate-600">{rands(s.priceCents)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {serviceId === null && (
        <>
          <Field label="Or type an amount (rand)" name="amount" inputMode="decimal" placeholder="350" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Field label="What for (optional)" name="description" maxLength={80} value={description} onChange={(e) => setDescription(e.target.value)} />
        </>
      )}

      <Field
        label="Customer's WhatsApp number (optional)"
        name="customer"
        inputMode="tel"
        placeholder="082 123 4567"
        hint="With a number, only that phone can claim it by tapping; anyone else needs the 4-digit code."
        value={customer}
        onChange={(e) => setCustomer(e.target.value)}
      />

      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium text-slate-700">Tag</span>
        <select name="tag" value={tagCode} onChange={(e) => setTagCode(e.target.value)} className="min-h-12 rounded-xl border border-slate-300 px-3">
          <option value="">No tag (send a link)</option>
          {tags.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label ? `${t.label} (${t.code})` : t.code}
              {t.assignedName ? ` · ${t.assignedName}` : ""}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-slate-700">Split between</span>
        <select name="shares" value={shares} onChange={(e) => setShares(Number(e.target.value))} className="min-h-12 rounded-xl border border-slate-300 px-3">
          {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
            <option key={n} value={n}>
              {n === 1 ? "One payer" : `${n} people`}
            </option>
          ))}
        </select>
      </label>

      <ErrorNote>{error}</ErrorNote>
      <Button onClick={() => void create()} disabled={!ready || busy}>
        {busy ? "Creating…" : "Create bill"}
      </Button>
    </Screen>
  );
}
