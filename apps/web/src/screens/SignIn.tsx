import { useState, type FormEvent } from "react";
import { ApiError, authCall, session, type Tokens } from "../api";
import { Button, ErrorNote, Field, Screen } from "../ui";

/**
 * SPEC 15 sign-in: a new phone gets a one-time code by WhatsApp (and sets a PIN the first time);
 * an enrolled phone signs in with the PIN.
 */
type Step = "number" | "code" | "choose_pin" | "choose_merchant" | "pin";

const PRODUCT = (import.meta.env.VITE_PRODUCT_NAME as string | undefined) ?? "Tap to pay";

function explain(e: unknown): string {
  if (!(e instanceof ApiError)) return "No connection. Check your signal and try again.";
  switch (e.code) {
    case "invalid_code":
      return "That code is wrong or has expired. Ask for a new one.";
    case "weak_pin":
      return (e.details as { message?: string } | undefined)?.message ?? "Choose a less obvious PIN.";
    case "invalid_login":
      return "Wrong PIN.";
    case "pin_locked":
      return "Too many wrong PINs. Try again in 15 minutes, or sign in with a WhatsApp code.";
    case "unknown_device":
      return "This phone is not signed up yet. Use a WhatsApp code.";
    default:
      return e.message;
  }
}

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const known = session.deviceId && session.msisdn;
  const [step, setStep] = useState<Step>(known ? "pin" : "number");
  const [msisdn, setMsisdn] = useState(session.msisdn ?? "");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [merchants, setMerchants] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };

  const requestCode = (e?: FormEvent) => {
    e?.preventDefault();
    return run(async () => {
      await authCall("/v1/auth/otp/request", { msisdn });
      setCode("");
      setStep("code");
    });
  };

  const verify = (merchantId?: string) =>
    run(async () => {
      try {
        const t = await authCall<Tokens>("/v1/auth/otp/verify", { msisdn, code, ...(pin ? { pin } : {}), ...(merchantId ? { merchantId } : {}), deviceLabel: navigator.userAgent.slice(0, 60) });
        session.store(t, msisdn);
        onSignedIn();
      } catch (e) {
        if (e instanceof ApiError && e.code === "pin_required") return setStep("choose_pin");
        if (e instanceof ApiError && e.code === "choose_merchant") {
          setMerchants((e.details as { merchants: { id: string; name: string }[] }).merchants);
          return setStep("choose_merchant");
        }
        throw e;
      }
    });

  const login = (e: FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const t = await authCall<Tokens>("/v1/auth/login", { msisdn: session.msisdn, pin, deviceId: session.deviceId });
      session.store(t, session.msisdn ?? "");
      onSignedIn();
    });
  };

  return (
    <Screen title={PRODUCT}>
      {step === "number" && (
        <form onSubmit={requestCode} className="flex flex-col gap-4">
          <p className="text-slate-600">Sign in with the WhatsApp number your manager added.</p>
          <Field label="WhatsApp number" name="msisdn" inputMode="tel" autoComplete="tel" placeholder="082 123 4567" value={msisdn} onChange={(e) => setMsisdn(e.target.value)} required />
          <ErrorNote>{error}</ErrorNote>
          <Button disabled={busy || msisdn.replace(/\D/g, "").length < 9}>Send me a code</Button>
        </form>
      )}

      {step === "code" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
          className="flex flex-col gap-4"
        >
          <p className="text-slate-600">We sent a 6-digit code to your WhatsApp.</p>
          <Field label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required autoFocus />
          <ErrorNote>{error}</ErrorNote>
          <Button disabled={busy || code.length !== 6}>Continue</Button>
          <Button type="button" variant="secondary" onClick={() => void requestCode()} disabled={busy}>
            Send a new code
          </Button>
        </form>
      )}

      {step === "choose_pin" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
          className="flex flex-col gap-4"
        >
          <p className="text-slate-600">Choose a PIN. You will use it to sign in on this phone.</p>
          <Field label="New PIN (4 to 6 digits)" name="pin" type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} required autoFocus />
          <ErrorNote>{error}</ErrorNote>
          <Button disabled={busy || pin.length < 4}>Save PIN</Button>
        </form>
      )}

      {step === "choose_merchant" && (
        <div className="flex flex-col gap-3">
          <p className="text-slate-600">Your number works at more than one business. Which one?</p>
          {merchants.map((m) => (
            <Button key={m.id} variant="secondary" onClick={() => void verify(m.id)} disabled={busy}>
              {m.name}
            </Button>
          ))}
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      {step === "pin" && (
        <form onSubmit={login} className="flex flex-col gap-4">
          <p className="text-slate-600">Welcome back. Enter your PIN.</p>
          <Field label="PIN" name="pin" type="password" inputMode="numeric" autoComplete="current-password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} required autoFocus />
          <ErrorNote>{error}</ErrorNote>
          <Button disabled={busy || pin.length < 4}>Sign in</Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setPin("");
              setStep("number");
            }}
          >
            Use a WhatsApp code instead
          </Button>
        </form>
      )}
    </Screen>
  );
}
