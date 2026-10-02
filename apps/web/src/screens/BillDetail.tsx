import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, ApiError, parseRands, rands, type Bill } from "../api";
import { paidSignal, useLiveEvents } from "../live";
import { Button, ErrorNote, Field, Screen, StatusBadge } from "../ui";

/**
 * SPEC 15 "Bill detail": live status, how the customer gets to it (tap the tag, scan the QR,
 * or a WhatsApp link), the bill code for a different phone, and the actions.
 */
export function BillDetail({ id, go }: { id: string; go: (path: string) => void }) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [qr, setQr] = useState<string>("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [newAmount, setNewAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setBill(await api<Bill>(`/v1/merchant/bills/${id}`));
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? "Bill not found." : "No connection.");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const link = bill?.link;
  useEffect(() => {
    if (link) void QRCode.toDataURL(link, { margin: 1, width: 240 }).then(setQr);
  }, [link]);

  useLiveEvents((e) => {
    if (e.billId !== id) return;
    if (e.name === "bill.paid") paidSignal();
    void load();
  }, true);

  const act = async (path: string, init: RequestInit = { method: "POST" }) => {
    setBusy(true);
    setError("");
    try {
      setBill(await api<Bill>(path, init));
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "No connection.");
    } finally {
      setBusy(false);
    }
  };

  if (!bill) {
    return (
      <Screen title="Bill" back={() => go("/")}>
        <ErrorNote>{error}</ErrorNote>
      </Screen>
    );
  }

  const live = bill.status === "open" || bill.status === "claimed";
  const description = bill.type === "quick_tip" ? "Quick tip" : bill.lines.map((l) => l.description).join(", ") || "Amount";
  const shareText = `Pay ${rands(bill.subtotalCents)} here: ${bill.link}`;

  return (
    <Screen title={description} back={() => go("/")}>
      <section className="flex items-center justify-between">
        <div>
          <div className="text-3xl font-semibold tabular-nums" data-testid="bill-total">
            {rands(bill.subtotalCents + bill.tipCents)}
          </div>
          {bill.tipCents > 0 && <div className="text-sm text-slate-600">includes {rands(bill.tipCents)} tip</div>}
        </div>
        <StatusBadge status={bill.status} />
      </section>

      {bill.maskedCustomer && (
        <p className="text-sm text-slate-600">
          Customer: {bill.customerName ?? ""} {bill.maskedCustomer}
        </p>
      )}

      {live && (
        <section className="flex flex-col items-center gap-3 rounded-xl border border-slate-200 p-4" aria-label="How to pay">
          <p className="text-center text-sm text-slate-600">{bill.tagCode ? `Customer taps tag ${bill.tagCode}, or scans:` : "Customer scans, or you send the link:"}</p>
          {qr && <img src={qr} alt="QR code for this bill" width={240} height={240} />}
          {bill.billCode && (
            <p className="text-center text-sm">
              Paying from another phone? Bill code <strong className="font-mono text-lg tracking-widest">{bill.billCode}</strong>
            </p>
          )}
          <a className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-center font-medium text-white" href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer">
            Send via WhatsApp
          </a>
        </section>
      )}

      <ErrorNote>{error}</ErrorNote>

      {live && !editing && (
        <div className="grid grid-cols-2 gap-2">
          {!bill.hasShares && (
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy}>
              Change amount
            </Button>
          )}
          {bill.status === "claimed" && (
            <Button variant="secondary" onClick={() => void act(`/v1/merchant/bills/${id}/release`)} disabled={busy}>
              Release
            </Button>
          )}
          <Button
            variant="danger"
            onClick={() => {
              if (confirm("Cancel this bill? The customer will be told.")) void act(`/v1/merchant/bills/${id}/cancel`);
            }}
            disabled={busy}
          >
            Cancel bill
          </Button>
        </div>
      )}

      {editing && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const c = parseRands(newAmount);
            if (!c) return setError("Type an amount like 350 or 350,50.");
            void act(`/v1/merchant/bills/${id}`, { method: "PATCH", body: JSON.stringify({ lines: [{ description: bill.lines[0]?.description ?? "Amount", amountCents: c }] }) });
          }}
        >
          <Field label="New amount (rand)" name="newAmount" inputMode="decimal" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} autoFocus />
          <p className="text-xs text-slate-500">If a customer is already paying, they get the new amount to confirm.</p>
          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="secondary" onClick={() => setEditing(false)}>
              Keep
            </Button>
            <Button disabled={busy}>Save</Button>
          </div>
        </form>
      )}
    </Screen>
  );
}
