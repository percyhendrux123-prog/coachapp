import { useEffect, useState, useCallback, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { CoachTabs } from "../components/CoachTabs";
import AppGate from "../components/AppGate";
import {
  getCoachInbox, markThreadRead, getClientMessages, sendCoachMessage,
} from "../lib/coachClients";

// Wave 2 #1 — Unified inbox. One place to triage and reply to every client
// thread without drilling into each client's Messages tab. Master–detail:
// thread list + conversation side by side on md+, drill-down on mobile —
// same responsive pattern as the Clients page.
export default function CoachInbox() {
  const { user, role, profile } = useAuth();
  const [threads, setThreads] = useState([]);
  const [selId, setSelId] = useState(null);
  const [err, setErr] = useState(null);
  const [loadState, setLoadState] = useState("loading"); // loading | ready | failed

  const load = useCallback(async () => {
    setLoadState("loading");
    setErr(null);
    try {
      setThreads(await getCoachInbox());
      setLoadState("ready");
    } catch (e) {
      setErr(e.message || String(e));
      setThreads([]);
      setLoadState("failed");
    }
  }, []);
  useEffect(() => { if (role === "coach") load(); }, [role, load]);

  // Deep link: /coach/inbox?client=<id> opens that thread. Coach Home Attention
  // routes message / draft_message here with a named person — landing on the full
  // list and making the coach find them again is a broken action, not a signpost.
  // Same consume-once pattern as Clients (useSearchParams + drop after apply).
  const [searchParams, setSearchParams] = useSearchParams();
  const wantedClient = searchParams.get("client");
  // Stub when Home deep-links a client who is not yet in the inbox list (no prior
  // messages). Thread still loads by client_id; display name is filled after send/list.
  const [orphanStub, setOrphanStub] = useState(null);
  useEffect(() => {
    if (!wantedClient || loadState !== "ready") return;
    const existing = threads.find((t) => t.client_id === wantedClient);
    if (existing) {
      setSelId(wantedClient);
      setOrphanStub(null);
      if (existing.unread_count > 0) {
        // A badge only clears after the server confirms the read pointer. Otherwise a
        // transient failure can make an unread client message look handled until reload.
        markThreadRead(wantedClient)
          .then(() => setThreads((ts) => ts.map((x) => (x.client_id === wantedClient ? { ...x, unread_count: 0 } : x))))
          .catch((e) => setErr(e.message || "Could not mark this thread as read."));
      }
    } else {
      setSelId(wantedClient);
      setOrphanStub({
        client_id: wantedClient,
        display_name: "Client",
        unread_count: 0,
        last_body: "",
        last_sent_at: null,
        last_sender_role: null,
      });
    }
    setSearchParams((p) => { p.delete("client"); return p; }, { replace: true });
    // Intentionally depend on wantedClient + loadState only: do not re-run when
    // threads refresh after send (param is already consumed).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consume-once deep link
  }, [wantedClient, loadState, setSearchParams]);

  if (!user) {
    return (
      <AppGate title="Sign in to open inbox" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        Client threads and replies live here for coaches.
      </AppGate>
    );
  }
  if (role !== "coach") {
    return (
      <AppGate title="Coach area only" actionTo="/client" actionLabel="Client home" secondaryTo="/" secondaryLabel="Home">
        Inbox is for coaches.
      </AppGate>
    );
  }

  const selected =
    threads.find((t) => t.client_id === selId)
    ?? (orphanStub && orphanStub.client_id === selId ? orphanStub : null);

  // Opening a thread stamps the server read pointer before clearing the local badge.
  async function openThread(t) {
    setSelId(t.client_id);
    setOrphanStub(null);
    if (t.unread_count > 0) {
      try {
        await markThreadRead(t.client_id);
        setThreads((ts) => ts.map((x) => (x.client_id === t.client_id ? { ...x, unread_count: 0 } : x)));
      } catch (e) {
        setErr(e.message || "Could not mark this thread as read.");
      }
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <CoachTabs active="inbox" />
      <div className={`mt-6 flex items-center justify-between ${selected ? "hidden md:flex" : "flex"}`}>
        <h1 className="display text-3xl">Inbox</h1>
      </div>
      {err && loadState === "failed" && (
        <div className="mt-2 rounded-xl border border-dashed border-ink/20 bg-ink/[0.03] p-3 text-sm text-danger" role="alert">
          <p>Inbox could not load. {err}</p>
          <button type="button" onClick={load} className="btn-ghost mt-3 px-4 text-sm">Retry inbox</button>
        </div>
      )}
      {err && loadState === "ready" && (
        <p className="mt-2 text-sm text-danger">{err}</p>
      )}

      {/* Master–detail: two panes on md+, drill-down on mobile. */}
      <div className="mt-5 md:flex md:items-start md:gap-6">
        {/* Thread list (master). */}
        <div className={`${selected ? "hidden md:block" : "block"} md:w-80 md:shrink-0 md:sticky md:top-6 md:max-h-[calc(100vh-2.5rem)] md:overflow-y-auto`}>
          <ul className="glass divide-y divide-ink/10 overflow-hidden">
            {loadState === "loading" && (
              <li className="p-4 text-sm opacity-60">Loading conversations…</li>
            )}
            {loadState === "failed" && (
              <li className="p-4 text-sm opacity-60">Cannot show threads until the feed loads.</li>
            )}
            {loadState === "ready" && threads.length === 0 && (
              <li className="p-4 text-sm opacity-60">No messages yet.</li>
            )}
            {loadState === "ready" && threads.map((t) => (
              <li key={t.client_id}>
                <button type="button" onClick={() => openThread(t)}
                  className={`flex w-full items-start gap-2 px-4 py-3 text-left transition hover:bg-ink/[0.03] min-h-[44px] ${t.client_id === selId ? "bg-ink/[0.05]" : ""}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className={`truncate ${t.unread_count > 0 ? "font-bold" : "font-medium"}`}>
                        {t.display_name}
                      </span>
                      <span className="shrink-0 text-xs opacity-50">{relTime(t.last_sent_at)}</span>
                    </div>
                    <p className={`truncate text-xs ${t.unread_count > 0 ? "opacity-90" : "opacity-55"}`}>
                      {t.last_sender_role === "coach" && <span className="opacity-60">You: </span>}
                      {t.last_body}
                    </p>
                  </div>
                  {t.unread_count > 0 && (
                    <span className="mt-0.5 shrink-0 rounded-full bg-brand px-2 py-0.5 text-xs font-medium text-brand-text">
                      {t.unread_count}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Conversation (detail). */}
        <div className={`${selected ? "block" : "hidden md:block"} md:min-w-0 md:flex-1`}>
          {selected ? (
            <>
              <button type="button" onClick={() => setSelId(null)}
                className="mb-3 inline-flex min-h-[44px] items-center gap-1 text-sm opacity-70 hover:opacity-100 md:hidden">
                ← Back to inbox
              </button>
              <Thread key={selected.client_id} client={selected} tenantId={profile?.tenant_id} onSent={load} />
            </>
          ) : (
            <div className="hidden min-h-[300px] items-center justify-center rounded-2xl border border-dashed border-ink/15 text-sm opacity-50 md:flex">
              Select a conversation to read and reply.
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

// A single client conversation with an inline reply box. Bubble styling matches
// the per-client Messages tab: coach right/dark, client left/light.
function Thread({ client, tenantId, onSent }) {
  const [rows, setRows] = useState([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [loadState, setLoadState] = useState("loading"); // loading | ready | failed
  const endRef = useRef(null);

  const load = useCallback(async () => {
    setLoadState("loading");
    setErr(null);
    try {
      const data = await getClientMessages(client.client_id);
      setRows(data);
      setLoadState("ready");
    } catch (e) {
      setRows([]);
      setLoadState("failed");
      setErr(e.message || String(e));
    }
  }, [client.client_id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [rows]);

  async function send(e) {
    e.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await sendCoachMessage({ clientId: client.client_id, tenantId, body: body.trim() });
      setBody("");
      await load();
      onSent?.(); // refresh inbox preview/order
    } catch (e2) {
      // Keep the draft so a network blip does not erase the coach's reply.
      setErr(e2.message || String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass p-5">
      <div className="flex items-center justify-between">
        <h2 className="display text-xl">{client.display_name}</h2>
        <Link to={`/coach/clients?client=${client.client_id}`} className="text-xs opacity-60 hover:underline">Open client →</Link>
      </div>
      <div className="mt-4 max-h-[55vh] space-y-2 overflow-y-auto pr-1">
        {loadState === "loading" && <p className="text-sm opacity-50">Loading thread…</p>}
        {loadState === "failed" && (
          <div className="rounded-xl border border-dashed border-ink/20 p-3 text-sm text-danger" role="alert">
            <p>Could not load this conversation. {err}</p>
            <button type="button" onClick={load} className="btn-ghost mt-3 px-4 text-sm">Retry conversation</button>
          </div>
        )}
        {loadState === "ready" && rows.length === 0 && (
          <p className="text-sm opacity-50">No messages in this thread yet.</p>
        )}
        {loadState === "ready" && rows.map((m) => (
          <div key={m.id} className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${m.sender_role === "coach" ? "ml-auto bg-ink text-paper" : "bg-ink/5"}`}>
            {m.body}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {err && loadState === "ready" && (
        <p className="mt-2 text-sm text-danger" role="alert">{err}</p>
      )}
      <form onSubmit={send} className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
        <label className="min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide opacity-60">
          Message
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Reply to ${client.display_name}…`}
            aria-label={`Reply to ${client.display_name}`}
            disabled={busy || loadState === "failed"}
            className="mt-1 w-full rounded-xl border border-ink/15 px-3 py-2 text-sm font-normal normal-case tracking-normal opacity-100 disabled:opacity-50"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !body.trim() || loadState === "failed"}
          className="btn-primary min-h-[44px] px-4 disabled:opacity-50"
        >
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
    </section>
  );
}

// Compact relative time for thread timestamps (e.g. "3h", "2d", "Jul 12").
function relTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}


