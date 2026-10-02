import { useEffect, useState } from "react";
import { api, session, type Me } from "../api";
import { Button, ErrorNote, Screen } from "../ui";

/** SPEC 15 "Settings": sound, vibration, alerts on this phone, sign out. */

function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export function Settings({ me, go }: { me: Me; go: (path: string) => void }) {
  const [sound, setSound] = useState(localStorage.getItem("tp.sound") !== "off");
  const [vibrate, setVibrate] = useState(localStorage.getItem("tp.vibrate") !== "off");
  const [muted, setMuted] = useState(me.user.muted);
  const [pushOn, setPushOn] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!pushSupported()) return;
    void navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => setPushOn(Boolean(s)));
  }, []);

  const togglePush = async () => {
    setError("");
    try {
      const reg = await navigator.serviceWorker.ready;
      if (pushOn) {
        await (await reg.pushManager.getSubscription())?.unsubscribe();
        await api("/v1/merchant/devices/current/push", { method: "PUT", body: JSON.stringify({ subscription: null }) });
        setPushOn(false);
        return;
      }
      if ((await Notification.requestPermission()) !== "granted") return setError("Notifications are blocked for this site in your browser settings.");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(me.vapidPublicKey!) });
      await api("/v1/merchant/devices/current/push", { method: "PUT", body: JSON.stringify({ subscription: sub.toJSON() }) });
      setPushOn(true);
    } catch {
      setError("Could not turn on alerts on this phone. On iPhone, add the app to the home screen first.");
    }
  };

  const toggle = (key: string, on: boolean, set: (v: boolean) => void) => {
    localStorage.setItem(key, on ? "on" : "off");
    set(on);
  };

  return (
    <Screen title="Settings" back={() => go("/")}>
      <p className="text-sm text-slate-600">
        {me.user.name} · {me.merchant.name} · {me.user.role}
      </p>

      <Row label="Sound when paid" on={sound} onChange={(v) => toggle("tp.sound", v, setSound)} />
      <Row label="Vibrate when paid" on={vibrate} onChange={(v) => toggle("tp.vibrate", v, setVibrate)} />
      <Row
        label="Payment alerts for me"
        on={!muted}
        onChange={async (v) => {
          await api("/v1/merchant/me/settings", { method: "PUT", body: JSON.stringify({ muted: !v }) });
          setMuted(!v);
        }}
      />
      {me.vapidPublicKey && pushSupported() ? (
        <Row label="Alerts on this phone when the app is closed" on={pushOn} onChange={() => void togglePush()} />
      ) : (
        <p className="text-sm text-slate-500">Alerts when the app is closed come by WhatsApp.</p>
      )}
      <ErrorNote>{error}</ErrorNote>

      <Button variant="secondary" onClick={() => session.signOut()}>
        Sign out
      </Button>
      <Button variant="danger" onClick={() => session.forgetDevice()}>
        Sign out and forget this phone
      </Button>
    </Screen>
  );
}

function Row({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-12 items-center justify-between gap-3">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} className="h-6 w-11 accent-teal-700" />
    </label>
  );
}
