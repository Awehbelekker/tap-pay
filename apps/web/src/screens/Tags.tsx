import { useEffect, useState } from "react";
import { api, ApiError, type StaffMember, type Tag } from "../api";
import { Button, ErrorNote, Field, Screen, TagBadge } from "../ui";

/**
 * Manager: assign tags to a person, or to nobody for a till or table (SPEC 16). The tag code is
 * read with Web NFC where the browser has it (Chrome on Android; ARCHITECTURE T5), otherwise
 * typed from the sticker.
 */

interface NdefRecord {
  recordType: string;
  data?: DataView;
}
interface NdefReadingEvent extends Event {
  message: { records: NdefRecord[] };
}
interface NdefReaderLike extends EventTarget {
  scan(opts?: { signal?: AbortSignal }): Promise<void>;
}

export const webNfcAvailable = () => typeof window !== "undefined" && "NDEFReader" in window;

/** The tag code from a tag URL record ".../t/CODE?...". */
export function codeFromRecord(r: NdefRecord): string | null {
  if (r.recordType !== "url" || !r.data) return null;
  const url = new TextDecoder().decode(r.data);
  const m = /\/t\/([A-Za-z0-9-]{4,32})(?:[?#]|$)/.exec(url);
  return m ? m[1]!.toUpperCase() : null;
}

export function Tags({ go }: { go: (path: string) => void }) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [code, setCode] = useState("");
  const [assignee, setAssignee] = useState<string>("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [scanning, setScanning] = useState<AbortController | null>(null);

  const load = async () => {
    const [t, s] = await Promise.all([api<{ items: Tag[] }>("/v1/merchant/tags"), api<{ items: StaffMember[] }>("/v1/merchant/staff")]);
    setTags(t.items);
    setStaff(s.items.filter((x) => x.active));
  };
  useEffect(() => {
    void load().catch(() => setError("No connection."));
  }, []);

  const scan = async () => {
    setError("");
    const ctrl = new AbortController();
    setScanning(ctrl);
    try {
      const Reader = (window as unknown as { NDEFReader: new () => NdefReaderLike }).NDEFReader;
      const reader = new Reader();
      reader.addEventListener("reading", (ev) => {
        const found = (ev as NdefReadingEvent).message.records.map(codeFromRecord).find(Boolean);
        if (found) {
          setCode(found);
          ctrl.abort();
          setScanning(null);
        }
      });
      await reader.scan({ signal: ctrl.signal });
    } catch {
      setScanning(null);
      setError("Could not start the NFC reader. Type the code from the sticker instead.");
    }
  };

  const assign = async () => {
    setError("");
    setDone("");
    try {
      await api(`/v1/merchant/tags/${encodeURIComponent(code.trim().toUpperCase())}`, {
        method: "PUT",
        body: JSON.stringify({ assignedUserId: assignee || null, label: label.trim() || null }),
      });
      setDone(`Tag ${code.toUpperCase()} saved.`);
      setCode("");
      setLabel("");
      await load();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 404 ? "No tag with that code belongs to this business." : e instanceof ApiError ? e.message : "No connection.");
    }
  };

  return (
    <Screen title="Tags" back={() => go("/")}>
      <section className="flex flex-col gap-3 rounded-xl border border-slate-200 p-4" aria-label="Assign a tag">
        <h2 className="font-medium">Assign a tag</h2>
        {webNfcAvailable() && (
          <Button variant="secondary" onClick={() => (scanning ? (scanning.abort(), setScanning(null)) : void scan())}>
            {scanning ? "Hold the tag to the back of the phone… (tap to stop)" : "Scan tag with NFC"}
          </Button>
        )}
        <Field label="Tag code" name="code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Printed on the tag" autoCapitalize="characters" />
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">Give to</span>
          <select name="assignee" value={assignee} onChange={(e) => setAssignee(e.target.value)} className="min-h-12 rounded-xl border border-slate-300 px-3">
            <option value="">Nobody (till or table)</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <Field label="Label (optional)" name="label" placeholder="Front desk, Table 4, Sipho's band" value={label} onChange={(e) => setLabel(e.target.value)} />
        <ErrorNote>{error}</ErrorNote>
        {done && <p className="text-sm text-emerald-700">{done}</p>}
        <Button onClick={() => void assign()} disabled={code.trim().length < 4}>
          Save tag
        </Button>
      </section>

      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200" aria-label="All tags">
        {tags.map((t) => (
          <li key={t.code} className="flex items-center gap-3 px-3 py-3">
            <span className="flex-1">
              <span className="block font-mono text-sm">{t.code}</span>
              <span className="block text-xs text-slate-500">
                {t.label ?? "No label"} · {t.assignedName ?? "Nobody"}
                {t.kind === "static" ? " · unsigned tag" : ""}
              </span>
            </span>
            <TagBadge status={t.status} />
          </li>
        ))}
      </ul>
    </Screen>
  );
}
