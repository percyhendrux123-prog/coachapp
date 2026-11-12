import { useCallback, useEffect, useRef, useState } from "react";
import { listMessages } from "../lib/client";
import ClientMessageComposer, { ClientMessageThread } from "./ClientMessageComposer";

// Lives above the keyed DayCard, not inside a conditional runner/dialog. Only
// memory holds the draft; closing or browsing days does not overwrite it.
export default function SubstituteRequest({ ctx, enabled, children }) {
  const [request, setRequest] = useState(null);
  const [candidate, setCandidate] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [workoutError, setWorkoutError] = useState(null);
  const revision = useRef(0);
  const trigger = useRef(null);
  const dialog = useRef(null);
  const [height, setHeight] = useState(null);
  const alive = useRef(true);
  const readVersion = useRef(0);
  const [thread, setThread] = useState({ rows: [], loadState: "idle", readError: null });

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; readVersion.current += 1; };
  }, []);

  const reload = useCallback(async () => {
    const version = ++readVersion.current;
    setThread((t) => ({ ...t, loadState: "loading", readError: null }));
    try {
      const rows = await listMessages();
      if (alive.current && version === readVersion.current) setThread({ rows, loadState: "ready", readError: null });
    } catch (error) {
      if (alive.current && version === readVersion.current) setThread({ rows: [], loadState: "failed", readError: error.message || String(error) });
      throw error;
    }
  }, []);

  useEffect(() => {
    if (enabled && open) reload().catch(() => {});
  }, [enabled, open, reload]);

  useEffect(() => {
    if (enabled) return;
    setOpen(false);
    setRequest(null);
    setCandidate(null);
    readVersion.current += 1;
    setThread({ rows: [], loadState: "idle", readError: null });
  }, [enabled]);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && enabled) {
      // Native modal dialog provides focus containment and makes the rest of the
      // page inert without unmounting workout inputs or their rest clock.
      node.showModal();
      const resize = () => setHeight(window.visualViewport?.height ?? window.innerHeight);
      resize();
      window.visualViewport?.addEventListener("resize", resize);
      return () => {
        window.visualViewport?.removeEventListener("resize", resize);
        node.close();
        if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
      };
    }
  }, [open, enabled]);

  function start(context) {
    setRequest({ ...context, revision: ++revision.current, sent: false,
      body: `I'd like a substitute for ${context.exercise}.\nDay: ${context.day}.\nAvailable equipment: ` });
    setCandidate(null);
  }

  function ask(context, button) {
    if (!enabled) return;
    trigger.current = button;
    if (!busy && (!request || request.sent || !request.body.trim())) start(context);
    else if (request.key !== context.key) setCandidate(context);
    setOpen(true);
  }

  function close() { setOpen(false); }

  return (
    <>
      {children(enabled ? ask : null, setWorkoutError)}
      {enabled && request && (
        <dialog ref={dialog} aria-labelledby="substitute-title" aria-describedby="substitute-description"
          onCancel={(e) => { e.preventDefault(); close(); }}
          className="fixed inset-x-0 bottom-0 top-auto m-0 mx-auto w-full max-w-lg rounded-t-2xl border border-ink/15 bg-paper p-0 text-ink shadow-xl backdrop:bg-ink/40 sm:bottom-4 sm:rounded-2xl"
          style={{ maxHeight: height ? `${Math.max(120, height - 24)}px` : "85dvh" }}>
          <div className="overflow-y-auto p-5" style={{ maxHeight: "inherit" }}>
            <div className="sticky top-0 z-10 flex items-start justify-between gap-2 bg-paper pb-2">
              <h2 id="substitute-title" className="display text-lg">Ask your coach</h2>
              <button type="button" onClick={close} className="min-h-[44px] shrink-0 px-2 text-sm underline">Close</button>
            </div>
            <p id="substitute-description" className="text-xs opacity-70">This sends a request, not a replacement. Your workout stays unchanged.</p>
            <p className="mt-3 break-words text-sm font-semibold">{request.exercise} · {request.day}</p>
            {workoutError && (
              <div role="alert" className="mt-3 rounded-xl border border-danger p-3 text-sm text-danger">
                <p>Workout input did not save. {workoutError.message}</p>
                <button type="button" disabled={workoutError.pending} onClick={workoutError.retry} className="min-h-[44px] underline disabled:opacity-50">{workoutError.pending ? "Saving workout input…" : "Retry workout save"}</button>
              </div>
            )}
            {candidate && (
              <div className="mt-3 rounded-xl border border-ink/20 p-3 text-sm" role="group" aria-label="Existing request draft">
                <p>{busy ? "A message is sending. Keep this request open until its result is known." : `You have a draft for ${request.exercise}. Keep it, or discard it to ask about ${candidate.exercise}.`}</p>
                <button type="button" onClick={() => setCandidate(null)} className="min-h-[44px] px-2 underline">Keep current request</button>
                <button type="button" disabled={busy} onClick={() => start(candidate)} className="min-h-[44px] px-2 underline disabled:opacity-50">Discard draft and switch</button>
              </div>
            )}
            <ClientMessageThread {...thread} reload={reload} />
            <ClientMessageComposer key={request.revision} ctx={ctx} body={request.body}
              setBody={(body) => setRequest((r) => ({ ...r, body, sent: false }))}
              loadState={thread.loadState} reload={reload} onBusyChange={setBusy}
              onSent={() => { setCandidate(null); setRequest((r) => ({ ...r, sent: true })); }} />
          </div>
        </dialog>
      )}
    </>
  );
}
