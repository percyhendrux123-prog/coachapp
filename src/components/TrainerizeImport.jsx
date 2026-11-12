import { useState } from "react";
import { supabase } from "../lib/supabase";

// Import-from-Trainerize panel (coach). The flow is deliberately two-step: every
// payload runs as a dry-run preview first, and the real import button only unlocks
// after a preview of the EXACT same payload — editing the JSON re-locks it.
export default function TrainerizeImport({ onImported }) {
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState(null);   // dry-run result for current payload
  const [result, setResult] = useState(null);     // real-run result
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  function parsePayload() {
    const parsed = JSON.parse(raw);
    // Accept either the bare export or the full request wrapper.
    const exp = parsed.trainerize_export ?? parsed;
    const tzId = parsed.trainerize_client_id ?? exp?.client?.trainerize_id;
    if (!exp?.client?.email) throw new Error("Payload has no client.email — is this a Trainerize export?");
    return { trainerize_export: exp, trainerize_client_id: tzId };
  }

  async function run(dryRun) {
    setErr(null); setBusy(true);
    try {
      const body = { ...parsePayload(), dry_run: dryRun };
      const { data, error } = await supabase.functions.invoke("trainerize-import", { body });
      if (error) {
        let detail = error.message;
        try { detail = (await error.context?.json())?.error ?? detail; } catch { /* keep default */ }
        throw new Error(detail);
      }
      if (data?.error) throw new Error(data.error);
      if (dryRun) { setPreview(data); setResult(null); }
      else { setResult(data); setPreview(null); await onImported?.(); }
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    f.text().then((t) => { setRaw(t); setPreview(null); setResult(null); });
  }

  return (
    <details className="mt-8 rounded-xl border border-ink/10 p-4 text-sm">
      <summary className="cursor-pointer font-medium">Import from Trainerize</summary>
      <p className="mt-2 max-w-xl text-xs opacity-70">
        Paste or upload a Trainerize export (JSON, contract v1). You always get a preview
        first — nothing is written until you confirm. Imports never create logins, never
        overwrite your data, and are safe to re-run (already-imported rows are skipped).
      </p>

      <div className="mt-3 flex items-center gap-3 text-xs">
        <input type="file" accept=".json,application/json" onChange={onFile} />
      </div>
      <textarea value={raw}
        onChange={(e) => { setRaw(e.target.value); setPreview(null); setResult(null); }}
        rows={5} placeholder='{"trainerize_export": { "_schema_version": "1.0.0", "client": { ... } }, ...}'
        className="mt-2 w-full rounded-md border border-ink/15 px-2 py-1.5 font-mono text-xs" />

      {err && <p className="mt-2 text-sm text-danger">{err}</p>}

      <div className="mt-2 flex gap-2">
        <button onClick={() => run(true)} disabled={busy || !raw.trim()}
          className="rounded-md border border-ink/15 px-3 py-1.5 disabled:opacity-40">
          {busy && !preview ? "Previewing…" : "Preview (dry run)"}
        </button>
        <button onClick={() => run(false)} disabled={busy || !preview}
          title={preview ? "" : "Run the preview first"}
          className="rounded-md bg-brand px-3 py-1.5 text-brand-text disabled:opacity-40">
          {busy && preview ? "Importing…" : "Import for real"}
        </button>
      </div>

      {preview && <Report r={preview} heading="Preview — nothing has been written yet" />}
      {result && <Report r={result} heading={result.status === "ok" ? "Imported ✓" : `Imported with notes (${result.status})`} />}
    </details>
  );
}

function Report({ r, heading }) {
  const skips = Object.entries(r.skipped ?? {}).flatMap(([section, arr]) =>
    arr.map((s) => ({ section, ...s })));
  return (
    <div className="mt-3 rounded-lg border border-ink/10 bg-ink/[0.02] p-3 text-xs">
      <p className="font-medium">{heading}</p>
      <p className="mt-1">
        {Object.entries(r.imported ?? {}).filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}: ${v}`).join(" · ") || "nothing new to import"}
        {r.client_created && <span className="ml-2 rounded-full bg-ink/5 px-2 py-0.5">new client</span>}
      </p>
      {(r.warnings ?? []).map((w, i) => <p key={i} className="mt-1 opacity-70">⚠ {w}</p>)}
      {skips.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer opacity-60">{skips.length} skipped row{skips.length > 1 ? "s" : ""}</summary>
          <ul className="mt-1 space-y-0.5 opacity-70">
            {skips.map((s, i) => (
              <li key={i}>{s.section}: {s.trainerize_id ?? s.trainerize_meal_id ?? "(row)"} — {s.reason}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
