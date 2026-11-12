import { useRef, useState } from "react";
import { sendMessage } from "../lib/client";
import { recordActivity } from "../lib/activity";

// Shared by Messages and the in-workout request. Draft ownership stays with each
// caller: opening a request must never replace the general Messages draft.
export default function ClientMessageComposer({ ctx, body, setBody, loadState, reload, onSent, onBusyChange }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [sent, setSent] = useState(false);

  async function send(e) {
    e.preventDefault();
    if (!body.trim() || pending.current || loadState !== "ready") return;
    pending.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setSendError(null);
    setSent(false);
    const clean = body.trim();
    try {
      await sendMessage({ ...ctx, body: clean });
    } catch (error) {
      setSendError(error.message || String(error));
      pending.current = false;
      setBusy(false);
      onBusyChange?.(false);
      return;
    }

    // Only the insert determines send success. A failed read after it must not
    // retain the submitted draft or invite a duplicate resend.
    setBody("");
    setSent(true);
    onSent?.();
    recordActivity({
      tenantId: ctx.tenantId,
      clientId: ctx.clientId,
      template: "client_message_sent",
      detail: { summary: clean.slice(0, 120) },
    }).catch((error) => console.error("activity: client message was not recorded", error));
    try {
      await reload({ force: true });
    } catch (_error) {
      // The thread owns the read error and its scoped Retry.
    } finally {
      pending.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <div>
      {sendError && <p role="alert" className="mt-2 text-sm text-danger">Message not sent. {sendError}</p>}
      {sent && <p role="status" className="mt-2 text-sm font-semibold">Message sent. Your coach can read it in Messages.</p>}
      <form onSubmit={send} className="mt-4 flex flex-col gap-2">
        <label className="min-w-0 text-xs font-semibold uppercase tracking-wide opacity-60">
          Message
          <textarea
            value={body}
            onChange={(e) => { setBody(e.target.value); setSent(false); }}
            placeholder="Message your coach…"
            aria-label="Message your coach"
            rows={4}
            disabled={busy}
            className="mt-1 min-h-[44px] w-full resize-y rounded-xl border border-ink/15 px-3 py-2 text-base font-normal normal-case tracking-normal opacity-100 disabled:opacity-50"
          />
        </label>
        <button type="submit" disabled={busy || !body.trim() || loadState !== "ready"}
          className="btn-primary min-h-[44px] px-4 disabled:opacity-50">
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}

export function ClientMessageThread({ rows, loadState, readError, reload, renderBody = (body) => body }) {
  return (
    <div className="mt-4 space-y-2">
      {(loadState === "idle" || loadState === "loading") && <p className="text-sm opacity-60">Loading messages…</p>}
      {loadState === "failed" && (
        <div className="rounded-xl border border-dashed border-ink/20 p-3 text-sm text-danger" role="alert">
          <p>Could not load messages. {readError}</p>
          <button type="button" onClick={() => reload({ force: true }).catch(() => {})} className="btn-ghost mt-3 min-h-[44px] px-4 text-sm">
            Retry messages
          </button>
        </div>
      )}
      {loadState === "ready" && rows.length === 0 && (
        <div className="glass p-4">
          <p className="font-semibold">No messages yet</p>
          <p className="mt-2 text-xs opacity-60">Your coach sees this thread on their side.</p>
        </div>
      )}
      {loadState === "ready" && rows.map((m) => (
        <div key={m.id} className={`max-w-[90%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${m.sender_role === "client" ? "ml-auto bg-ink text-paper" : "bg-ink/5"}`}>
          {renderBody(m.body)}
        </div>
      ))}
    </div>
  );
}
