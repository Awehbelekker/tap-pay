import { useCallback, useEffect, useState } from "react";
import { api, refresh, session, type Me } from "./api";
import { BillDetail } from "./screens/BillDetail";
import { Business } from "./screens/Business";
import { Money } from "./screens/Money";
import { NewBill } from "./screens/NewBill";
import { Reports } from "./screens/Reports";
import { Settings } from "./screens/Settings";
import { SignIn } from "./screens/SignIn";
import { Tags } from "./screens/Tags";
import { Today } from "./screens/Today";
import { Screen, Spinner } from "./ui";

/** Hash routes keep the PWA a single cached page that works offline. */
function useRoute(): [string, (p: string) => void] {
  const read = () => window.location.hash.replace(/^#/, "") || "/";
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [route, (p: string) => (window.location.hash = p)];
}

export function App() {
  const [route, go] = useRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<"loading" | "signed_out" | "ready" | "offline">("loading");

  const start = useCallback(async () => {
    setState("loading");
    if (!session.access && !(await refresh())) return setState(navigator.onLine || !session.hasRefresh() ? "signed_out" : "offline");
    try {
      setMe(await api<Me>("/v1/merchant/me"));
      setState("ready");
    } catch {
      setState(session.access ? "offline" : "signed_out");
    }
  }, []);

  useEffect(() => {
    session.onSignedOut(() => {
      setMe(null);
      setState("signed_out");
    });
    void start();
  }, [start]);

  if (state === "loading") {
    return (
      <Screen title="">
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </Screen>
    );
  }
  if (state === "offline") {
    return (
      <Screen title="Offline">
        <p className="text-slate-600">No connection. Your bills will show as soon as the signal is back.</p>
        <button className="rounded-xl bg-slate-100 px-4 py-3" onClick={() => void start()}>
          Try again
        </button>
      </Screen>
    );
  }
  if (state === "signed_out" || !me) {
    return (
      <SignIn
        onSignedIn={() => {
          go("/"); // always land on Today, not wherever the last session was
          void start();
        }}
      />
    );
  }

  const bill = /^\/bill\/([0-9a-f-]{36})$/.exec(route);
  if (bill) return <BillDetail id={bill[1]!} go={go} />;
  if (route === "/new") return <NewBill me={me} go={go} />;
  if (route === "/money") return <Money me={me} go={go} />;
  if (route === "/reports") return <Reports me={me} go={go} />;
  if (route === "/business" && (me.user.role === "manager" || me.user.role === "owner")) return <Business me={me} go={go} />;
  if (route === "/settings") return <Settings me={me} go={go} />;
  if (route === "/tags" && (me.user.role === "manager" || me.user.role === "owner")) return <Tags go={go} />;
  return <Today me={me} go={go} />;
}
