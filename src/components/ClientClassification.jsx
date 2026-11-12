import { useState, useMemo } from "react";
import {
  CLIENT_TYPES, classificationOf, classificationLabel, daysOutLabel,
  prepMissingShowDate, isTestClient, classificationCounts,
} from "../lib/clientType";
import { setClientClassification } from "../lib/coachClients";

// Client classification UI — lifestyle vs prep, and the show date that makes a
// prep client legible.
//
// Built on the app's existing tokens (Archivo via font-sans, the ink/paper/brand
// theme variables, the glass card, rounded-2xl, Tailwind's 4px scale) rather than
// a parallel set, so it inherits the light/dark flip for free.
//
// THE ONE RULE THIS FILE ENFORCES VISUALLY: unclassified is not lifestyle. It
// renders as a dashed, empty-looking slot — a question the eye wants answered —
// never as a filled pill that reads like a value someone chose.

const FIELD = "mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 bg-transparent";

/** Roster pill. Three states, three looks. */
export function TypeBadge({ client, showGap = true }) {
  const state = classificationOf(client);

  if (state === "unclassified") {
    return (
      <span
        title="Not classified — your coach has not said whether this is a lifestyle or prep client"
        className="rounded-full border border-dashed border-ink/40 px-2 py-0.5 text-ink/70"
      >
        unclassified
      </span>
    );
  }

  const gap = showGap && prepMissingShowDate(client);
  const days = daysOutLabel(client.show_date);

  return (
    <span className="inline-flex items-center gap-1">
      <span className="rounded-full bg-ink/5 px-2 py-0.5 capitalize">{state}</span>
      {state === "prep" && (
        gap
          // A prep client with no show date cannot be reasoned about: no days-out,
          // no peak window, and no way to tell late-prep physiology from avoidance.
          // That is a real gap and it reads like one.
          ? <span title="Prep client with no show date recorded" className="text-danger">no show date</span>
          : <span className="opacity-60">{days}</span>
      )}
    </span>
  );
}

/**
 * The type + show-date fields. Used by the add-client form and the profile
 * editor so both surfaces behave identically.
 *
 * Show date and show name are revealed only when prep is selected — a show date
 * on a lifestyle client is noise, and hiding them keeps the common case short.
 */
export function ClassificationFields({ value, onChange, idPrefix = "cls" }) {
  const { clientType = "", showDate = "", showName = "" } = value;
  const set = (patch) => onChange({ ...value, ...patch });
  const isPrep = clientType === "prep";

  return (
    <div className="rounded-lg border border-ink/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">Client type</span>
        {!clientType && (
          <span className="text-xs text-ink/60">
            Unset stays unclassified — it is not treated as lifestyle.
          </span>
        )}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="opacity-60">Type</span>
          <select
            id={`${idPrefix}-type`}
            value={clientType}
            onChange={(e) => set({ clientType: e.target.value })}
            className={FIELD}
          >
            <option value="">— Not classified</option>
            {CLIENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </label>

        {isPrep && (
          <>
            <label className="text-sm">
              <span className="opacity-60">Show date</span>
              <input
                id={`${idPrefix}-show-date`}
                type="date"
                value={showDate || ""}
                onChange={(e) => set({ showDate: e.target.value })}
                className={FIELD}
              />
              {!showDate && (
                <span className="mt-1 block text-xs text-danger">
                  Without this there is no days-out, and late-prep physiology
                  cannot be told apart from an avoidance signal.
                </span>
              )}
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="opacity-60">Show name (optional)</span>
              <input
                id={`${idPrefix}-show-name`}
                value={showName || ""}
                onChange={(e) => set({ showName: e.target.value })}
                placeholder="e.g. NPC Capital Grand Prix"
                className={FIELD}
              />
            </label>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Bulk classifier: show unclassified clients until each is classified.
 * Test clients are excluded from both the list and the counts.
 *
 * Prep needs a date, so choosing Prep here opens the date inline rather than
 * sending the coach to the profile tab. Saving prep without a date is allowed — a
 * known-prep client with an unknown date is more useful than no classification —
 * and the roster then carries the "no show date" gap marker until it is filled.
 */
export function BulkClassify({ clients, onChanged }) {
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState(null);
  const [drafts, setDrafts] = useState({}); // clientId -> { showDate, showName }
  const [open, setOpen] = useState(true);

  const counts = useMemo(() => classificationCounts(clients), [clients]);
  const pending = useMemo(
    () => clients.filter((c) => !isTestClient(c) && classificationOf(c) === "unclassified"),
    [clients],
  );

  if (!pending.length) return null;

  async function apply(client, clientType) {
    setBusyId(client.id); setErr(null);
    try {
      const d = drafts[client.id] ?? {};
      await setClientClassification(client.id, {
        clientType,
        showDate: d.showDate,
        showName: d.showName,
      });
      await onChanged?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="glass mt-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="display text-lg">Classify clients</h2>
          <p className="mt-0.5 text-sm opacity-70">
            {counts.unclassified} of {counts.total} not classified.
            {" "}Until a client is classified, check-in loop tagging is held back for
            them rather than guessed.
          </p>
        </div>
        <button onClick={() => setOpen((v) => !v)} className="text-sm underline opacity-70 hover:opacity-100">
          {open ? "Hide" : `Show ${pending.length}`}
        </button>
      </div>

      {err && <p className="mt-2 text-sm text-danger">{err}</p>}

      {open && (
        <ul className="mt-3 divide-y divide-ink/10">
          {pending.map((c) => {
            const d = drafts[c.id] ?? {};
            const busy = busyId === c.id;
            return (
              <li key={c.id} className="py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold">{c.display_name}</span>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={busy}
                      onClick={() => apply(c, "lifestyle")}
                      className="rounded-lg border border-ink/15 px-3 py-1 text-sm transition hover:bg-ink/[0.04] disabled:opacity-50"
                    >
                      Lifestyle
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => apply(c, "prep")}
                      className="rounded-lg border border-ink/15 px-3 py-1 text-sm transition hover:bg-ink/[0.04] disabled:opacity-50"
                    >
                      Prep
                    </button>
                  </div>
                </div>

                {/* Show date offered inline so marking someone prep does not mean
                    a second trip through the profile tab to make them legible. */}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="opacity-60">Show date (prep only)</span>
                  <input
                    type="date"
                    value={d.showDate || ""}
                    onChange={(e) => setDrafts({ ...drafts, [c.id]: { ...d, showDate: e.target.value } })}
                    className="rounded-lg border border-ink/15 bg-transparent px-2 py-1"
                  />
                  <input
                    value={d.showName || ""}
                    onChange={(e) => setDrafts({ ...drafts, [c.id]: { ...d, showName: e.target.value } })}
                    placeholder="Show name"
                    className="min-w-0 flex-1 rounded-lg border border-ink/15 bg-transparent px-2 py-1"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Small summary line for the roster header. */
export function ClassificationSummary({ clients }) {
  const c = useMemo(() => classificationCounts(clients), [clients]);
  if (!c.total) return null;
  return (
    <p className="mt-1 text-xs opacity-60">
      {c.lifestyle} lifestyle · {c.prep} prep
      {c.unclassified > 0 && <> · <span className="text-ink/80">{c.unclassified} unclassified</span></>}
      {c.prepNoShowDate > 0 && <> · <span className="text-danger">{c.prepNoShowDate} prep with no show date</span></>}
    </p>
  );
}

export { classificationLabel };
