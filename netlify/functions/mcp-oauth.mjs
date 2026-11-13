// mcp-oauth — minimal OAuth 2.1 surface that lets Claude's remote MCP
// connector complete its handshake, then proxies MCP tool calls to the
// existing Supabase `mcp` edge function.
//
// WHY THIS EXISTS: Claude's connector performs OAuth discovery at the host
// ROOT (/.well-known/oauth-protected-resource + /.well-known/oauth-authorization-server).
// Supabase Edge Functions can only serve /functions/v1/<name>, so the root
// discovery 404s ("requested path is invalid"). Netlify CAN serve root paths,
// so the OAuth surface lives here on the app domain and forwards tool calls
// to Supabase. The Supabase `mcp` function is UNCHANGED — the token gate,
// coach/client + read/read_write scoping (DB-enforced), and the audit trail
// are all preserved exactly.
//
// SECURITY MODEL (unchanged from the manual-token model):
//   - The coach proves possession of a valid connector token by pasting it at
//     /oauth/authorize; it is validated against connector_tokens (service role).
//   - The OAuth access_token we vend IS that same connector token — so the
//     Supabase mcp function's existing authenticate() works with no change,
//     and access is exactly what that token already grants. No new privilege.
//   - PKCE (S256) is required; auth codes are single-use, 5-min TTL, stored
//     server-side (oauth_codes) and deleted on exchange.

// Fallbacks let a one-click deploy work with only the VITE_ values set: URL is the
// site address Netlify provides to functions at runtime.
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
const MCP_UPSTREAM =
  process.env.MCP_UPSTREAM || `${SUPABASE_URL}/functions/v1/mcp`;
const ISSUER = process.env.OAUTH_ISSUER || process.env.URL || "http://localhost:8888";

// Tool names with NO write flag in supabase/functions/mcp/index.ts — kept in sync by hand,
// used ONLY to decide whether a gateway failure is safe to retry (see GATEWAY_RETRY_STATUSES
// below). Deliberately an ALLOWLIST of known-read tools rather than a denylist of known-write
// ones: a tool this list has never heard of (a typo, or a new write tool added to index.ts
// and not mirrored here) must fail CLOSED — not retried — not fail open into "safe by
// default". Never touches auth or scoping; the mcp function's own DB-enforced checks are
// unchanged and are the real authority on what a token may do.
const READ_TOOLS = new Set([
  "get_business_snapshot", "list_clients", "get_client", "list_checkins", "get_client_workouts",
  "list_progress_photos", "list_programs", "get_program", "list_challenges", "list_messages",
  "search_clients", "list_inbox", "list_client_notes", "get_support_queue", "get_client_support_brief",
  "get_meal_plan", "list_meals", "get_promo_video",
  // Added 2026-08-26 with the endpoint expansion. Reads only — every one of these has no
  // `write` flag in index.ts, which is asserted by supabase/functions/mcp/toolSurface.test.ts.
  // No write tool from that batch (update_client_onboarding, create_client_note,
  // update_client_note, archive_client_note, log_workout_on_behalf, reply_to_checkin,
  // edit_meal_plan, create_custom_meal, send_bulk_message, post_to_community,
  // moderate_community_post, archive_program, delete_program, create_support_ticket,
  // save_message_template) appears here, and none ever should.
  // Added 2026-08-30: list_platform_tenants shipped 2026-08-29 (245f755) without this mirror
  // entry — caught by toolSurface.test.ts's allowlist-parity check. Read-only, owner-gated
  // inside the tool itself.
  "list_platform_tenants",
  // Added 2026-09-03 (Phase 4 part A): owner-gated read of SYSTEM buyers. No write flag.
  "list_system_buyers",
  "get_client_onboarding", "get_client_parq", "get_client_activity_log", "get_engagement_report",
  "get_client_program_history", "get_checkin_detail", "compare_progress_photos",
  // Added 2026-08-30 with get_client_schedule/get_client_progress (coach twin of
  // my_schedule/my_progress). Both are reads with no `write` flag in index.ts.
  "get_client_schedule", "get_client_progress",
  "get_nutrition_history", "list_community_posts", "get_community_post", "get_community_engagement",
  "get_compliance_status", "get_roster_state", "get_escalation_history", "get_message_templates",
  "my_profile", "my_program", "my_workouts", "my_checkins", "my_messages",
  // Added 2026-08-30 with my_schedule/my_progress (client calendar + progress trends).
  // Both are reads with no `write` flag in index.ts.
  "my_schedule", "my_progress",
  // Added 2026-08-26, second pass: client documents. list/get are reads; upload_client_document
  // is a write and must never appear here.
  "list_client_documents", "get_client_document",
  // Added 2026-08-30 with the Brief slide strip. Read only — add_brief_slide,
  // update_brief_slide, and remove_brief_slide are writes and must never appear here.
  "list_brief_slides",
]);
// Cloudflare/Supabase gateway-class failures (origin never produced a valid response) —
// distinct from a 4xx or a 200 carrying an application-level error, which are real answers
// and must never be retried.
const GATEWAY_RETRY_STATUSES = new Set([502, 503, 504]);

// A JSON-RPC call is safe to retry only when we can positively identify it as read-only:
// initialize/ping/tools/list (no side effects), or tools/call naming a tool in READ_TOOLS.
// Anything unparseable, unrecognized, or a write is treated as unsafe — retrying one we
// can't clear that bar for risks doing it twice (e.g. a message sent, a set logged) if the
// origin actually completed the request before the gateway dropped its response.
function isSafeToRetry(bodyText) {
  let msg;
  try { msg = JSON.parse(bodyText); } catch { return false; }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  if (msg.method === "initialize" || msg.method === "ping" || msg.method === "tools/list") return true;
  if (msg.method === "tools/call") return READ_TOOLS.has(msg.params?.name);
  return false;
}
const RESOURCE_METADATA = `${ISSUER}/.well-known/oauth-protected-resource`;
const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_SECONDS = 60 * 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, x-api-key",
};
const json = (b, status = 200, extra = {}) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", ...extra },
  });

async function sha256(buf) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}
const enc = (s) => new TextEncoder().encode(s);
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (u8) =>
  btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256hex(s) { return hex(await sha256(enc(s))); }
async function pkceChallenge(verifier) { return b64url(await sha256(enc(verifier))); }
function randToken() {
  const u = new Uint8Array(32); crypto.getRandomValues(u); return b64url(u);
}

// --- Supabase REST (service role) -------------------------------------------
async function sb(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}
// A connector token is valid if its SHA-256 hash matches a non-revoked row.
async function tokenIsValid(rawToken) {
  const h = await sha256hex(rawToken.trim());
  const r = await sb(`connector_tokens?select=id,revoked_at&token_hash=eq.${h}&limit=1`);
  if (!r.ok) return false;
  const rows = await r.json();
  return rows.length === 1 && !rows[0].revoked_at;
}

// --- endpoints ---------------------------------------------------------------
// --- Connect-your-AI sign-in (2026-09-03) -------------------------------------
// The authorize page IS the connect screen: email → one-time code (Supabase Auth's own
// OTP, the same one the app uses) → pick read / full → a connector token is minted
// server-side and handed to the AI app as the OAuth access token. The buyer never sees
// a token string. Pasting a connector code still works (coaches, and anyone who prefers
// it). Every DB rule is unchanged: the connector_tokens trigger refuses owner on a coached
// tenant and comms on a self-serve one; authenticate() in the mcp function is untouched.
const OAUTH_FIELDS = ["client_id", "redirect_uri", "state", "code_challenge",
  "code_challenge_method", "response_type", "scope"];

export function normalizeEmail(v) { return String(v || "").trim().toLowerCase(); }
export function otpCodeFrom(v) { return String(v || "").replace(/\D/g, "").slice(0, 10); }
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// What the two cards say, per tenant mode. The self-serve plan has no coach, so its
// second option is owner (full control); a coached tenant's second option is comms
// (read + relay). Mirrors src/pages/Client.jsx AIOptIn and the DB trigger.
export function scopeOptionsFor(mode) {
  const read = { value: "read", label: "Read-only", detail: "Your AI can see your program, history and check-ins. It cannot change anything." };
  if (mode === "self_serve") {
    return [read, { value: "owner", label: "Full control",
      detail: "Also logs sets, finishes your day, rewrites your week, sets your targets, swaps meals, adds your own meals, and rebuilds your plan from new numbers. It is your plan." }];
  }
  return [read, { value: "comms", label: "Read + relay",
    detail: "Also logs sets, finishes your day, and messages your coach as you. Your program and nutrition stay your coach's." }];
}
export function scopeAllowed(mode, scope) {
  return scopeOptionsFor(mode).some((o) => o.value === scope);
}

const CSS = `body{font-family:system-ui,-apple-system,sans-serif;max-width:440px;margin:6vh auto;padding:0 20px;color:#111;background:#fff;line-height:1.45}
@media(prefers-color-scheme:dark){body{color:#eee;background:#111}.card{border-color:#333}.muted{color:#aaa}input{background:#1a1a1a;color:#eee;border-color:#444}button.secondary{color:#eee;border-color:#444}}
h1{font-size:22px;margin:0 0 6px}.muted{color:#555;font-size:14px;margin:0 0 16px}.err{color:#c00;font-size:14px}
input{width:100%;padding:12px;font-size:16px;border:1px solid #bbb;border-radius:10px;box-sizing:border-box}
button{margin-top:12px;width:100%;padding:13px;font-size:15px;border:0;border-radius:10px;background:#111;color:#fff;cursor:pointer}
@media(prefers-color-scheme:dark){button{background:#eee;color:#111}}
button.secondary{background:transparent;border:1px solid #bbb;color:#111}
.card{display:block;border:1px solid #ddd;border-radius:12px;padding:12px 14px;margin-top:10px;cursor:pointer}
.card input{width:auto;margin-right:8px}.card b{font-size:15px}.card span{display:block;font-size:13px;margin-top:4px}
details{margin-top:22px;font-size:13px}summary{cursor:pointer}code{font-size:13px}`;

function hiddenFields(q) {
  return OAUTH_FIELDS.map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(q.get(k) || "")}">`).join("");
}
function page(title, inner) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${CSS}</style><body>${inner}</body>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
function pasteFallback(q, errorMsg = "") {
  return `<details${errorMsg ? " open" : ""}><summary>Have a connector code from the app? Paste it here.</summary>
<form method="POST" action="/oauth/authorize" style="margin-top:10px">${hiddenFields(q)}<input type="hidden" name="step" value="paste">
${errorMsg ? `<p class="err">${escapeHtml(errorMsg)}</p>` : ""}
<input name="connector_token" autocomplete="off" placeholder="Connector code"><button class="secondary">Authorize with this code</button></form></details>`;
}

// Step 1 — email.
function emailForm(q, errorMsg = "", pasteError = "") {
  return page("Connect your AI", `<h1>Connect your AI</h1>
<p class="muted">Enter the email you use for the app. We email you a code. No password, no token to copy.</p>
${errorMsg ? `<p class="err">${escapeHtml(errorMsg)}</p>` : ""}
<form method="POST" action="/oauth/authorize">${hiddenFields(q)}<input type="hidden" name="step" value="send">
<input name="email" type="email" inputmode="email" autocomplete="email" autofocus placeholder="you@example.com" value="${escapeHtml(q.get("email") || "")}">
<button>Send code</button></form>${pasteFallback(q, pasteError)}`);
}

// Step 2 — code + what the AI may do. `accounts` = client rows found for the email.
function codeForm(q, email, accounts, errorMsg = "") {
  const multi = accounts.length > 1;
  const cards = accounts.map((a, i) => scopeOptionsFor(a.mode).map((o) => `
<label class="card"><input type="radio" name="choice" value="${escapeHtml(a.client_id)}:${o.value}"${i === 0 && o.value === "read" ? " checked" : ""}>
<b>${escapeHtml(o.label)}${multi ? ` — ${escapeHtml(a.app_name)}` : ""}</b><span>${escapeHtml(o.detail)}</span></label>`).join("")).join("");
  return page("Connect your AI", `<h1>Check your email</h1>
<p class="muted">Code sent to <b>${escapeHtml(email)}</b>. Enter it below, choose what your AI may do, and you are connected.</p>
${errorMsg ? `<p class="err">${escapeHtml(errorMsg)}</p>` : ""}
<form method="POST" action="/oauth/authorize">${hiddenFields(q)}<input type="hidden" name="step" value="verify"><input type="hidden" name="email" value="${escapeHtml(email)}">
<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="10" autofocus placeholder="Code from your email">
${cards}
<button>Connect</button></form>
<form method="POST" action="/oauth/authorize" style="margin-top:8px">${hiddenFields(q)}<input type="hidden" name="step" value="send"><input type="hidden" name="email" value="${escapeHtml(email)}"><button class="secondary">Send a new code</button></form>`);
}

// Client rows for an email, each with its tenant's mode and app name. Service role.
async function accountsForEmail(email) {
  const r = await sb(`clients?select=id,tenant_id,client_user_id,status&email=eq.${encodeURIComponent(email)}&status=neq.archived`);
  const rows = r.ok ? await r.json() : [];
  const out = [];
  for (const c of rows) {
    const t = await sb(`tenant_config?select=mode,app_name&tenant_id=eq.${c.tenant_id}&limit=1`);
    const cfg = t.ok ? (await t.json())[0] : null;
    out.push({ client_id: c.id, tenant_id: c.tenant_id, user_id: c.client_user_id, mode: cfg?.mode || "coached", app_name: cfg?.app_name || "Coaching app" });
  }
  return out;
}

// Supabase Auth's own OTP — the same code email the app sends.
async function sendOtp(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
    method: "POST", headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, create_user: false }),
  });
  return r.ok;
}
async function verifyOtp(email, code) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: "POST", headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "email", email, token: code }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j?.user?.id ? { id: j.user.id, email: normalizeEmail(j.user.email) } : null;
}

// Mint a client connector token exactly as the app does (src/lib/connector.js). The DB
// trigger is the authority on scope vs tenant mode; a refusal comes back as an error.
async function mintClientToken({ tenant_id, client_id, user_id, scope, label }) {
  const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
  const plaintext = "coach_mcp_" + hex(bytes);
  const r = await sb("connector_tokens", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ tenant_id, created_by: user_id, kind: "client", client_id, scope, label, token_hash: await sha256hex(plaintext) }),
  });
  if (!r.ok) { const detail = await r.text().catch(() => ""); throw new Error(detail.slice(0, 200)); }
  return plaintext;
}

async function issueCodeAndRedirect(form, connectorToken) {
  const redirect_uri = form.get("redirect_uri") || "";
  const code_challenge = form.get("code_challenge") || "";
  const state = form.get("state") || "";
  const code = randToken();
  const expires_at = new Date(Date.now() + CODE_TTL_MS).toISOString();
  // opportunistic sweep + insert
  await sb(`oauth_codes?expires_at=lt.${new Date().toISOString()}`, { method: "DELETE" }).catch(() => {});
  const ins = await sb("oauth_codes", {
    method: "POST", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ code, connector_token: connectorToken, code_challenge, redirect_uri, expires_at }),
  });
  if (!ins.ok) return json({ error: "server_error", detail: "could not persist auth code" }, 500);
  const sep = redirect_uri.includes("?") ? "&" : "?";
  const loc = `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`;
  return new Response(null, { status: 302, headers: { Location: loc } });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  // Logical path comes from the _redirects ?fnpath hint (falls back to pathname).
  const p = url.searchParams.get("fnpath") || url.pathname;

  if (!SUPABASE_URL) return json({ error: "server_misconfig", detail: "SUPABASE_URL not set" }, 500);
  if (!SERVICE_KEY) return json({ error: "server_misconfig", detail: "SUPABASE_SERVICE_ROLE_KEY not set" }, 500);

  // --- Dynamic Client Registration (RFC 7591): public PKCE client ---
  if (p === "/oauth/register" && req.method === "POST") {
    let body = {};
    try { body = await req.json(); } catch { /* tolerate empty */ }
    return json({
      client_id: "coaching-mcp-" + randToken().slice(0, 16),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      redirect_uris: body.redirect_uris || [],
      scope: "mcp offline_access",
    }, 201);
  }

  // --- Authorization endpoint ---
  if (p === "/oauth/authorize" && req.method === "GET") {
    return emailForm(url.searchParams);
  }
  if (p === "/oauth/authorize" && req.method === "POST") {
    const form = new URLSearchParams(await req.text());
    const step = form.get("step") || "paste";
    if (!form.get("redirect_uri") || !form.get("code_challenge")) {
      return emailForm(form, "This link is missing information your AI app should have sent. Start the connection again from your AI app's settings.");
    }

    // Paste path — unchanged behaviour: a valid, unrevoked connector code authorizes at its own level.
    if (step === "paste") {
      const token = (form.get("connector_token") || "").trim();
      if (!token) return emailForm(form, "", "Paste the connector code first.");
      if (!(await tokenIsValid(token))) return emailForm(form, "", "That code isn't valid, or it's been revoked. Create a new one from your app's AI screen.");
      return issueCodeAndRedirect(form, token);
    }

    if (!SUPABASE_ANON_KEY) return json({ error: "server_misconfig", detail: "SUPABASE_ANON_KEY not set" }, 500);
    const email = normalizeEmail(form.get("email"));
    if (!EMAIL_RE.test(email)) return emailForm(form, "Enter the email you use for the app.");

    if (step === "send") {
      const accounts = await accountsForEmail(email);
      if (accounts.length === 0) return emailForm(form, "No client account uses that email. Check the address, or paste a connector code below.");
      if (accounts.every((a) => !a.user_id)) return emailForm(form, "Sign in to the app once with this email first, then come back and connect.");
      if (!(await sendOtp(email))) return emailForm(form, "Could not send a code right now. Wait a minute and try again.");
      return codeForm(form, email, accounts.filter((a) => a.user_id));
    }

    if (step === "verify") {
      const accounts = (await accountsForEmail(email)).filter((a) => a.user_id);
      if (accounts.length === 0) return emailForm(form, "No client account uses that email.");
      const code = otpCodeFrom(form.get("code"));
      if (code.length < 6 || code.length > 10) return codeForm(form, email, accounts, "Enter the whole code from your email (6 to 10 digits).");
      const [chosenClient, scope] = String(form.get("choice") || "").split(":");
      const account = accounts.find((a) => a.client_id === chosenClient);
      if (!account || !scopeAllowed(account.mode, scope)) return codeForm(form, email, accounts, "Choose what your AI may do.");
      const user = await verifyOtp(email, code);
      if (!user) return codeForm(form, email, accounts, "That code didn't work. Codes expire quickly — send a new one if needed.");
      if (user.id !== account.user_id) return emailForm(form, "This email is signed in to a different account than the one on file. Sign in to the app first, then connect.");
      let token;
      try {
        token = await mintClientToken({ tenant_id: account.tenant_id, client_id: account.client_id, user_id: user.id, scope,
          label: `My AI (${scope === "read" ? "read-only" : scope === "owner" ? "full control" : "read + relay"}, signed in)` });
      } catch (e) {
        return codeForm(form, email, accounts, `Could not create the connection: ${e.message}`);
      }
      return issueCodeAndRedirect(form, token);
    }
    return emailForm(form, "Start again from your AI app's settings.");
  }

  // --- Token endpoint: exchange code (+PKCE) for the connector token ---
  if (p === "/oauth/token" && req.method === "POST") {
    const ct = req.headers.get("content-type") || "";
    const form = ct.includes("application/json")
      ? new URLSearchParams(Object.entries(await req.json()))
      : new URLSearchParams(await req.text());
    const grantType = form.get("grant_type");
    if (grantType === "refresh_token") {
      const refreshToken = (form.get("refresh_token") || "").trim();
      if (!refreshToken || !(await tokenIsValid(refreshToken))) {
        return json({ error: "invalid_grant", detail: "refresh token invalid or revoked" }, 400);
      }
      return json({
        access_token: refreshToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: TOKEN_TTL_SECONDS,
        scope: "mcp offline_access",
      });
    }
    if (grantType !== "authorization_code")
      return json({ error: "unsupported_grant_type" }, 400);
    const code = form.get("code") || "";
    const verifier = form.get("code_verifier") || "";
    const redirect_uri = form.get("redirect_uri") || "";
    const r = await sb(`oauth_codes?select=*&code=eq.${encodeURIComponent(code)}&limit=1`);
    const rows = r.ok ? await r.json() : [];
    if (rows.length !== 1) return json({ error: "invalid_grant", detail: "unknown code" }, 400);
    const row = rows[0];
    // single-use: delete now regardless of outcome
    await sb(`oauth_codes?code=eq.${encodeURIComponent(code)}`, { method: "DELETE" }).catch(() => {});
    if (new Date(row.expires_at).getTime() < Date.now())
      return json({ error: "invalid_grant", detail: "code expired" }, 400);
    if (row.redirect_uri !== redirect_uri)
      return json({ error: "invalid_grant", detail: "redirect_uri mismatch" }, 400);
    if (!verifier || (await pkceChallenge(verifier)) !== row.code_challenge)
      return json({ error: "invalid_grant", detail: "PKCE verification failed" }, 400);
    // Vend the connector token itself as the access token → Supabase mcp
    // authenticate() consumes it unchanged.
    return json({
      access_token: row.connector_token,
      refresh_token: row.connector_token,
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      scope: "mcp offline_access",
    });
  }

  // --- MCP endpoint: proxy to Supabase, streamable-HTTP preserved ---
  if (p === "/mcp") {
    const auth = req.headers.get("authorization") || req.headers.get("x-api-key") || "";
    // No creds yet → 401 that points Claude at discovery (kicks off OAuth).
    if (!auth) {
      return new Response(JSON.stringify({ error: "valid connector token required" }), {
        status: 401,
        headers: {
          ...CORS, "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_METADATA}"`,
        },
      });
    }
    if (!SUPABASE_ANON_KEY) {
      return json({ error: "server_misconfig", detail: "SUPABASE_ANON_KEY or VITE_SUPABASE_ANON_KEY not set" }, 500);
    }
    const connectorToken = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    const bodyText = req.method === "POST" ? await req.text() : undefined;
    const upstreamHeaders = {
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      apikey: SUPABASE_ANON_KEY,
      "x-api-key": connectorToken,
      "Content-Type": req.headers.get("content-type") || "application/json",
      "mcp-protocol-version": req.headers.get("mcp-protocol-version") || "",
    };
    let upstream = await fetch(MCP_UPSTREAM, { method: req.method, headers: upstreamHeaders, body: bodyText });
    // One retry, only for a gateway-class failure (the origin never produced a valid
    // response — nothing to have executed twice) on a request we've positively identified
    // as read-only. A write we can't clear that bar for is never retried here.
    if (GATEWAY_RETRY_STATUSES.has(upstream.status) && bodyText && isSafeToRetry(bodyText)) {
      upstream = await fetch(MCP_UPSTREAM, { method: req.method, headers: upstreamHeaders, body: bodyText });
    }
    const text = await upstream.text();
    const headers = { ...CORS, "Content-Type": upstream.headers.get("content-type") || "application/json" };
    if (upstream.status === 401)
      headers["WWW-Authenticate"] = `Bearer resource_metadata="${RESOURCE_METADATA}"`;
    return new Response(text, { status: upstream.status, headers });
  }

  return json({ error: "not_found", path: p }, 404);
};
