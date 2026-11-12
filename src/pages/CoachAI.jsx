import { useEffect, useState, useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { MCP_ENDPOINT, createToken, listTokens, revokeToken, listAudit } from "../lib/connector";
import { claudeInstallUrl } from "../lib/claudeInstall";

// Display name Claude shows for the coach's connector. Generic on purpose: this page is
// white-labelled per tenant and has no app_name in scope; the coach can rename it in Claude.
const COACH_CONNECTOR_NAME = "My coaching app";
import { CoachTabs } from "../components/CoachTabs";
import AppGate from "../components/AppGate";

// Connect-your-own-AI screen. The app hosts no model: the coach points their existing
// Claude/ChatGPT subscription at the MCP endpoint with a connection token. This screen
// is the entire AI surface of the app — no chat UI, fully optional.
export default function CoachAI() {
  const { user, role, profile } = useAuth();
  const [tokens, setTokens] = useState([]);
  const [audit, setAudit] = useState([]);
  const [reveal, setReveal] = useState(null); // one-time plaintext after create
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    try {
      const [t, a] = await Promise.all([listTokens(), listAudit()]);
      setTokens(t); setAudit(a); setErr(null);
    } catch (e) { setErr(e.message); setTokens(null); }
  }, []);
  useEffect(() => { if (role === "coach") load(); }, [role, load]);

  if (!user) {
    return (
      <AppGate title="Sign in to connect AI" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        Connect your own Claude or ChatGPT to your coaching data here.
      </AppGate>
    );
  }
  if (role !== "coach") {
    return (
      <AppGate title="Coach area only" actionTo="/client" actionLabel="Client home" secondaryTo="/" secondaryLabel="Home">
        Connecting an AI is a coach tool.
      </AppGate>
    );
  }

  const active = (tokens ?? []).filter((t) => !t.revoked_at);
  const failed = tokens === null;

  return (
    <main className="mx-auto max-w-3xl px-5 py-10">
      <CoachTabs active="ai" />
      <h1 className="display mt-6 text-3xl">Connect your AI</h1>
      <p className="mt-2 max-w-xl text-sm opacity-70">
        Let your own Claude or ChatGPT look up your clients, check-ins, programs, and workout logs
        for you and answer questions about them. This is optional — your app works exactly the same
        without it — and this platform never sees what you ask your AI or what it says back.
      </p>

      <div className="glass mt-4 space-y-3 p-4 text-sm">
        <p className="font-semibold">Recommended setup — Claude (2 minutes, no technical steps)</p>
        <ol className="list-decimal space-y-1.5 pl-5 opacity-90">
          <li>Below, name the connection and choose what your AI can do, then press <b>Create</b>.</li>
          <li>Copy the code you're shown.</li>
          <li>
            Press{" "}
            <a href={claudeInstallUrl({ name: COACH_CONNECTOR_NAME, endpoint: MCP_ENDPOINT }) || "https://claude.ai/customize/connectors"} target="_blank" rel="noreferrer" className="btn-primary inline-block px-2.5 py-1 text-xs">Connect to Claude</a>
            {" "}— Claude opens with the connector already filled in. Press <b>Continue</b> there.
            <span className="block opacity-70">No button? In Claude: Settings → Connectors → <b>Add custom connector</b>, address{" "}
              <code className="rounded bg-paper px-1.5 py-0.5 text-xs">{MCP_ENDPOINT}</code></span>
          </li>
          <li>Claude will ask you to authorize — paste the code from step 2 there. That's the whole setup.</li>
        </ol>
        <details className="text-xs opacity-70">
          <summary className="cursor-pointer font-medium opacity-90">Using ChatGPT or something else instead?</summary>
          <div className="mt-2 space-y-2 leading-relaxed">
            <p>
              <b>ChatGPT</b> needs its Developer mode / custom connector option with API-key
              authentication, pointed at the same address above. If ChatGPT&apos;s connector screen
              only offers a &quot;Log in&quot; button with no API-key field, it can&apos;t complete
              the connection yet — that&apos;s a current limit of ChatGPT&apos;s connector screen, not
              a missing step here.
            </p>
            <p>
              <b>Any other AI app</b> that can call an MCP server over HTTP can use this too — it needs
              the address above sent with the header <code className="rounded bg-paper px-1">Authorization: Bearer &lt;your code&gt;</code>.
            </p>
          </div>
        </details>
      </div>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}

      <NewConnection profile={profile} userId={user.id} onCreated={async (plaintext) => { setReveal(plaintext); await load(); }} />

      {reveal && <RevealCard token={reveal} onDismiss={() => setReveal(null)} />}

      <section className="mt-8">
        <h2 className="section-title">Connections</h2>
        <ul className="glass mt-2 divide-y divide-ink/10 overflow-hidden">
          {failed && <li className="p-4 text-sm text-danger">Could not read connections — this is a failed load, not a count of zero.</li>}
          {!failed && active.length === 0 && <li className="p-4 text-sm opacity-60">No AI connected. Your app works exactly the same either way.</li>}
          {active.map((t) => (
            <li key={t.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <span>
                <span className="font-medium">{t.label}</span>
                <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${t.scope === "read_write" ? "bg-brand/10 text-ink" : t.scope === "comms" ? "bg-ink/10 text-ink" : t.scope === "owner" ? "bg-brand/20 text-ink" : "bg-ink/5"}`}>
                  {t.scope === "read_write" ? "view & take actions" : t.scope === "comms" ? "view + relay" : t.scope === "owner" ? "full control (self-serve)" : "view only"}
                </span>
                {t.kind === "client" && <span className="ml-2 text-xs opacity-50">client</span>}
              </span>
              <span className="flex items-center gap-3 text-xs opacity-70">
                <span>{t.last_used_at ? `used ${new Date(t.last_used_at).toLocaleDateString()}` : "never used"}</span>
                <button onClick={async () => { if (confirm(`Revoke “${t.label}”? Its AI loses access immediately.`)) { await revokeToken(t.id); await load(); } }}
                  className="text-danger hover:underline">Revoke</button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="section-title">Recent AI activity</h2>
        {audit.length === 0 ? (
          <p className="mt-2 text-sm opacity-60">Every tool call your AI makes will be listed here.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {audit.map((a) => (
              <li key={a.id} className="flex justify-between rounded-md border border-ink/5 px-3 py-1.5 text-xs">
                <span className="font-mono">{a.tool}{a.summary?.ok === false && <span className="ml-2 text-danger">failed</span>}</span>
                <span className="opacity-50">{new Date(a.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function NewConnection({ profile, userId, onCreated }) {
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState("read");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function create(e) {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      onCreated(await createToken({ tenantId: profile?.tenant_id, userId, label, scope }));
      setLabel(""); setScope("read");
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={create} className="glass mt-6 p-4">
      <p className="text-sm font-bold">1. Start here</p>
      <p className="mt-1 text-xs opacity-60">Give this connection a name so you recognize it later, and choose what it's allowed to do.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. My Claude"
          className="w-56 rounded-md border border-ink/15 px-2 py-1.5 text-sm" />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="radio" checked={scope === "read"} onChange={() => setScope("read")} /> View only
        </label>
        <label className="flex items-center gap-1.5 text-sm">
          <input type="radio" checked={scope === "read_write"} onChange={() => setScope("read_write")} /> View &amp; take actions
        </label>
        <button disabled={busy} className="btn-primary px-3 py-1.5">{busy ? "Creating…" : "Create"}</button>
      </div>
      <p className="mt-2 text-xs opacity-60">
        {scope === "read_write"
          ? "“View & take actions” also lets your AI message clients and create, edit, and assign programs. Every action it takes is logged below so you can check it."
          : "“View only” lets your AI read your clients, check-ins, programs, and workout logs — it can't message anyone or change anything."}
      </p>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </form>
  );
}

function RevealCard({ token, onDismiss }) {
  const [copied, setCopied] = useState(false);
  const copy = (text) => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  const claudeSnippet = JSON.stringify(
    { mcpServers: { coaching: { type: "http", url: MCP_ENDPOINT, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);

  return (
    <div className="glass mt-4 border border-ink/15 p-4 text-sm">
      <p className="font-medium">2. Copy this code</p>
      <p className="mt-1 text-xs opacity-60">It won&apos;t be shown again — if you lose it, create a new connection.</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 overflow-x-auto rounded-xl bg-paper px-2 py-1.5 font-mono text-xs">{token}</code>
        <button type="button" onClick={() => copy(token)} className="btn-primary px-2.5 py-1.5 text-xs">{copied ? "Copied" : "Copy"}</button>
      </div>
      <p className="mt-3 text-sm">
        <span className="font-medium">3. Now press</span>{" "}
        <a href={claudeInstallUrl({ name: COACH_CONNECTOR_NAME, endpoint: MCP_ENDPOINT }) || "https://claude.ai/customize/connectors"} target="_blank" rel="noreferrer" className="btn-primary inline-block px-2.5 py-1 text-xs">Connect to Claude</a>
        {" "}— Claude opens with the connector filled in; press Continue, then paste the code above when it asks you to authorize.
      </p>
      <p className="mt-1 text-xs opacity-70">No button? Add a custom connector in Claude by hand with this address:{" "}
        <code className="rounded bg-paper px-1.5 py-0.5 text-xs">{MCP_ENDPOINT}</code></p>
      <details className="mt-3 text-xs opacity-70">
        <summary className="cursor-pointer font-medium opacity-90">ChatGPT, Claude Desktop/Code, or another AI app</summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p><span className="font-medium">Header:</span> <code className="rounded bg-paper px-1.5 py-0.5">Authorization: Bearer &lt;code above&gt;</code></p>
          <p><span className="font-medium">ChatGPT (Settings → Connectors → Developer mode):</span> add the address
            above and choose <b>API key</b> / bearer authentication with this code — not browser login alone.
            If the screen only offers a login button with no API-key field, ChatGPT can&apos;t finish the connection yet.</p>
          <p className="font-medium">Claude Desktop / Claude Code config file:</p>
          <pre className="overflow-x-auto rounded-xl bg-paper p-2">{claudeSnippet}</pre>
        </div>
      </details>
      <button type="button" onClick={onDismiss} className="btn-ghost mt-3 px-2.5 py-1 text-xs">Done — I saved it</button>
    </div>
  );
}


