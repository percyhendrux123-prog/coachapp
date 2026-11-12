// mcp — tenant-scoped MCP server (Streamable HTTP, stateless) over the coaching data.
// A coach connects their own AI product to this endpoint with a
// connector token; the app hosts no model and bills no inference.
//
// Security model:
// - Auth: `Authorization: Bearer coach_mcp_…` or `x-api-key`; SHA-256 looked up in
//   connector_tokens (hash at rest, revocable). No token → 401. No OAuth in v1.
// - Tenant scope resolves ONLY from the token row — never from tool arguments. Every
//   query goes through sel()/insTenant() which pin tenant_id; ids from another tenant
//   resolve to not-found. Client-kind tokens additionally pin client_id and get a
//   read-only own-data tool surface.
// - Writes are a curated allowlist gated by scope: coach tokens need scope=read_write;
//   client tokens need scope=comms and get COMMS/LOGGING writes only (message the coach,
//   flag an issue, log sets, complete the current day — the same mutations the app's own
//   buttons perform). A client token can NEVER write programming or nutrition data: the
//   client tool table contains no such tool, and the DB CHECK makes client+read_write
//   unrepresentable. Billing fields, invite tokens, and
//   contact/consent data are never serialized (field allowlists below).
// - Completed tool executions make a best-effort append to connector_audit (the
//   /coach/ai Activity view). Connection-level refusals and audit-write failures
//   are not represented as a complete security log.
//
// Protocol: JSON-RPC over POST (initialize / ping / tools/list / tools/call;
// notifications → 202). GET/DELETE → 405 (no SSE stream; stateless mode).
import { admin, CORS, SUPABASE_URL, SERVICE_KEY } from "../_shared/challenge.ts";
import { OWNER_TENANT_SLUG } from "../_shared/owner.ts";
import { closeDayCore } from "../_shared/workoutDay.ts";
import { resolveEffectiveDays } from "../_shared/effectiveDays.ts";
import { earnedDoneError } from "./workoutLogValidation.ts";
import { markThreadReadCore, MarkThreadReadError } from "./markThreadRead.ts";
import { generatePlan, missingBodyMetrics, missingParq } from "../intake-submit/generate.ts";
import { CALORIE_FLOOR_BY_SEX, PROTEIN_FLOOR_PER_KG, computeHealthFlags, proteinFloorG } from "../intake-submit/mealMacros.ts";
import { customMealRow, macroTargetsOrError } from "./ownerTools.ts";
import {
  canUseTool,
  hiddenWithoutCoach,
  NO_COACH_TEXT,
  mealLibraryVisibilityFilter,
  summarizeAuditArguments,
  type ToolScope,
  UUID_PATTERN,
  validateToolArguments,
} from "./safety.ts";
import {
  type ActivityEvent,
  buildSupportQueue,
  type EngagementSignals,
  mergeActivityLog,
  renderSection,
  type Section,
  sectionFailed,
  sectionOk,
  segmentEngagement,
  summariseEngagement,
  unavailableSections,
} from "./reports.ts";
import { personaliseMessage, PLACEHOLDERS, unknownPlaceholders } from "./messaging.ts";
import {
  intakeCompleteness,
  mergeIntakeAnswers,
  parqView,
  redactAnswers,
  validateIntakeAnswers,
  waiverView,
} from "./intakeView.ts";
import { DOCUMENT_KINDS, DOCUMENT_MIME_ALLOWLIST, documentStoragePath, validateDocumentUpload } from "./documents.ts";
import { MAX_SLIDES, SLIDE_MIME_ALLOWLIST, idsWithSlideAt, slideStoragePath, validateSlideUpload } from "./briefSlides.ts";
import { buildForwardSchedule, buildProgressTrends, checkinScheduleActions, computeConsistency } from "./scheduleView.ts";

function profileMetricsFromAnswers(incoming: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of ["sex", "age", "height_cm", "weight_kg", "goal_weight_kg", "unit_pref"] as const) {
    if (key in incoming) patch[key] = incoming[key] ?? null;
  }
  return patch;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "coachapp", version: "1.0.0" };
const INSTRUCTIONS =
  "Coaching-business data for the authenticated coach's tenant (or a client's own data " +
  "for client tokens). All reads/writes are automatically scoped — ids from outside the " +
  "tenant simply return not-found. Program structures use stable embedded uuids " +
  "(day_id/exercise_id) that anchor workout history: update_program preserves them and " +
  "will reject edits that drop ids while clients are mid-cycle. Client tokens are " +
  "comms-only by default: they can relay on the client's behalf (message the coach, flag " +
  "an issue, log workout sets, complete the current day) but cannot change the program or " +
  "nutrition plan — that is the coach's job. A self-serve buyer with no coach may instead " +
  "hold a full-control (owner) token, which additionally allows editing their own program, " +
  "macro targets, meal-plan slots, and custom meals, and regenerating their whole plan.";

const MCP_CORS = { ...CORS, "Access-Control-Allow-Headers": CORS["Access-Control-Allow-Headers"] + ", x-api-key, mcp-protocol-version" };
const jres = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...MCP_CORS, "Content-Type": "application/json" } });

// createdBy is the coach user who issued the connector token (connector_tokens.created_by).
// It is the reader identity for explicit thread acknowledgment — service-role code has no
// auth.uid(). Null only for defensive handling; the column is NOT NULL in the schema.
// selfServe: the tenant runs the Self-serve plan (tenant_config.mode = 'self_serve') — no coach exists,
// so coach-relay tools are hidden/refused. Read once per request for client tokens; coach
// tokens are always false (a self-serve tenant has no coach to hold one).
type Ctx = { tokenId: string; tenantId: string; kind: "coach" | "client"; clientId: string | null; scope: string; createdBy: string | null; selfServe: boolean };

// ---------- auth ----------
async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authenticate(req: Request): Promise<Ctx | null> {
  // x-api-key takes precedence: the Netlify OAuth proxy (netlify/functions/mcp-oauth.mjs)
  // always sends a Bearer-prefixed Authorization header carrying the Supabase anon key
  // (required by the platform's own function-invoke gate) and puts the real connector
  // token in x-api-key instead. Checking Authorization first meant every proxied call
  // authenticated against the anon key — never a valid connector token — and 401'd,
  // for every caller, unconditionally. Direct callers that only ever set Authorization
  // (no proxy in front of them) still work via the fallback below.
  const xApiKey = req.headers.get("x-api-key") || "";
  const authz = req.headers.get("Authorization") || "";
  const raw = xApiKey || (authz.startsWith("Bearer ") ? authz.slice(7) : "");
  if (!raw.trim().startsWith("coach_mcp_")) return null;
  const hash = await sha256hex(raw.trim());
  const { data: t } = await admin().from("connector_tokens")
    .select("id, tenant_id, kind, client_id, scope, revoked_at, created_by")
    .eq("token_hash", hash).maybeSingle();
  if (!t || t.revoked_at) return null;
  admin().from("connector_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", t.id)
    .then(() => {}, () => {});
  let selfServe = false;
  if (t.kind === "client") {
    const { data: cfg } = await admin().from("tenant_config").select("mode").eq("tenant_id", t.tenant_id).maybeSingle();
    selfServe = cfg?.mode === "self_serve";
  }
  return { tokenId: t.id, tenantId: t.tenant_id, kind: t.kind, clientId: t.client_id, scope: t.scope, createdBy: t.created_by ?? null, selfServe };
}

// ---------- OAuth 2.1 surface (sub-paths of this function) ----------
// The remote connector requires OAuth; it discovers metadata, does PKCE, and
// exchanges a code for an access token. We host that entirely on THIS function's
// sub-paths (Supabase routes them here) and make the access token BE the coach's
// existing connector token — so authenticate() above is the real authorizer and
// the DB-enforced coach/client + read/read_write scoping is unchanged. Auth codes
// are stateless: an AES-GCM sealed blob (key derived from SERVICE_KEY), 5-min TTL,
// PKCE-bound — no new table, no new secret.
const OAUTH_BASE = `${SUPABASE_URL}/functions/v1/mcp`;
const RESOURCE_METADATA_URL = `${OAUTH_BASE}/.well-known/oauth-protected-resource`;

const b64url = (u8: Uint8Array) =>
  btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  return Uint8Array.from(atob(s + pad), (c) => c.charCodeAt(0));
};
const te = (s: string) => new TextEncoder().encode(s);
const ojson = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...MCP_CORS, "Content-Type": "application/json" } });

async function codeKey(): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", te(SERVICE_KEY + "|mcp-oauth-code-v1"));
  return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function sealCode(obj: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await codeKey(), te(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0); out.set(ct, iv.length);
  return b64url(out);
}
async function openCode(code: string): Promise<any> {
  const data = unb64url(code);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, await codeKey(), data.slice(12));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(pt)));
}
async function pkceOk(verifier: string, challenge: string): Promise<boolean> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", te(verifier)));
  return b64url(h) === challenge;
}
async function connectorTokenValid(raw: string): Promise<boolean> {
  if (!raw.trim().startsWith("coach_mcp_")) return false;
  const h = await sha256hex(raw.trim());
  const { data } = await admin().from("connector_tokens").select("id, revoked_at").eq("token_hash", h).maybeSingle();
  return !!data && !data.revoked_at;
}
const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
function authorizeForm(q: URLSearchParams, err = ""): Response {
  const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope"]
    .map((k) => `<input type="hidden" name="${k}" value="${esc(q.get(k) ?? "")}">`).join("");
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your AI — Coaching app</title><body style="font-family:system-ui;max-width:420px;margin:8vh auto;padding:0 20px;color:#111"><h1 style="font-size:22px">Connect your AI to your coaching app</h1><p style="color:#555;font-size:14px">Paste the connector token from your app's <b>AI</b> screen. This authorizes your AI at the access level of that token.</p>${err ? `<p style="color:#c00;font-size:14px">${esc(err)}</p>` : ""}<form method="POST" action="${OAUTH_BASE}/authorize">${hidden}<input name="connector_token" autocomplete="off" autofocus placeholder="Connector code" style="width:100%;padding:12px;font-size:15px;border:1px solid #bbb;border-radius:10px;box-sizing:border-box"><button style="margin-top:12px;width:100%;padding:12px;font-size:15px;border:0;border-radius:10px;background:#111;color:#fff">Authorize</button></form></body>`,
    { status: 200, headers: { ...MCP_CORS, "Content-Type": "text/html; charset=utf-8" } });
}

// Returns a Response for any OAuth sub-path, else null (→ normal MCP handling).
async function handleOAuth(req: Request): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  const ends = (s: string) => path.endsWith(s);

  if (ends("/.well-known/oauth-protected-resource"))
    return ojson({ resource: OAUTH_BASE, authorization_servers: [OAUTH_BASE], bearer_methods_supported: ["header"], scopes_supported: ["mcp"] });

  if (ends("/.well-known/oauth-authorization-server"))
    return ojson({
      issuer: OAUTH_BASE,
      authorization_endpoint: `${OAUTH_BASE}/authorize`,
      token_endpoint: `${OAUTH_BASE}/token`,
      registration_endpoint: `${OAUTH_BASE}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });

  if (ends("/register") && req.method === "POST") {
    let body: any = {};
    try { body = await req.json(); } catch { /* tolerate empty */ }
    // RFC 7591 §3.2.1: echo the client's submitted metadata back, plus the
    // issued client_id and timestamps. client_id is not otherwise validated
    // (public PKCE client), so a static id pasted into the connector also works.
    const issued = Math.floor(Date.now() / 1000);
    return ojson({
      ...(body && typeof body === "object" ? body : {}),
      client_id: "coaching-mcp-" + b64url(crypto.getRandomValues(new Uint8Array(12))),
      client_id_issued_at: issued,
      client_id_expires_at: 0,
      token_endpoint_auth_method: body?.token_endpoint_auth_method ?? "none",
      grant_types: body?.grant_types ?? ["authorization_code"],
      response_types: body?.response_types ?? ["code"],
      redirect_uris: body?.redirect_uris ?? [],
    }, 201);
  }

  if (ends("/authorize")) {
    if (req.method === "GET") return authorizeForm(new URL(req.url).searchParams);
    if (req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const token = (form.get("connector_token") ?? "").trim();
      const redirect_uri = form.get("redirect_uri") ?? "";
      const code_challenge = form.get("code_challenge") ?? "";
      const state = form.get("state") ?? "";
      if (!token || !redirect_uri || !code_challenge) return authorizeForm(form, "Missing token or PKCE parameters.");
      if (!(await connectorTokenValid(token))) return authorizeForm(form, "That connector token isn't valid (or was revoked). Generate a fresh one on your AI screen.");
      const code = await sealCode({ t: token, c: code_challenge, r: redirect_uri, e: Date.now() + 5 * 60 * 1000 });
      const sep = redirect_uri.includes("?") ? "&" : "?";
      const loc = `${redirect_uri}${sep}code=${encodeURIComponent(code)}${state ? `&state=${encodeURIComponent(state)}` : ""}`;
      return new Response(null, { status: 302, headers: { ...MCP_CORS, Location: loc } });
    }
  }

  if (ends("/token") && req.method === "POST") {
    const ctHdr = req.headers.get("content-type") ?? "";
    const form = ctHdr.includes("application/json")
      ? new URLSearchParams(Object.entries(await req.json()).map(([k, v]) => [k, String(v)]))
      : new URLSearchParams(await req.text());
    if (form.get("grant_type") !== "authorization_code") return ojson({ error: "unsupported_grant_type" }, 400);
    const code = form.get("code") ?? "", verifier = form.get("code_verifier") ?? "", redirect_uri = form.get("redirect_uri") ?? "";
    let obj: any;
    try { obj = await openCode(code); } catch { return ojson({ error: "invalid_grant", error_description: "bad code" }, 400); }
    if (!obj || typeof obj.e !== "number" || obj.e < Date.now()) return ojson({ error: "invalid_grant", error_description: "code expired" }, 400);
    if (obj.r !== redirect_uri) return ojson({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
    if (!verifier || !(await pkceOk(verifier, obj.c))) return ojson({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
    return ojson({ access_token: obj.t, token_type: "Bearer", scope: "mcp" });
  }

  return null;
}

// ---------- scoped data access ----------
// The ONLY way tools touch tables: tenant pinned from ctx; client tokens also pin client_id.
const CLIENT_SCOPED_TABLES = new Set(["checkins", "messages", "workout_sessions", "workout_logs", "assignments", "progress_weights", "clients", "client_notes", "client_checkin_schedule"]);
function sel(ctx: Ctx, table: string, fields: string) {
  let q = admin().from(table).select(fields).eq("tenant_id", ctx.tenantId);
  if (ctx.kind === "client" && CLIENT_SCOPED_TABLES.has(table))
    q = q.eq(table === "clients" ? "id" : "client_id", ctx.clientId);
  return q;
}
function insTenant(ctx: Ctx, table: string, row: Record<string, unknown>) {
  return admin().from(table).insert({ ...row, tenant_id: ctx.tenantId });
}

// Field allowlists — nothing outside these ever serializes.
const F = {
  client: "id, display_name, status, coaching_tier, subscription_status, email, joined_at, show_date, show_name, client_type",
  checkin: "id, client_id, submitted_at, weight, photo_urls, answers, coach_seen",
  progressPhoto: "id, taken_at, photo_url, pose_tag, source_checkin_id",
  programList: "id, name, is_default, source_draft_id, created_at, structure",
  // day_order: nullable client schedule-adjustment override — see effectiveDays.ts.
  // current_day_index must always be resolved against it, never against a program's
  // raw structure.days directly.
  assignment: "id, client_id, program_id, active, current_day_index, assigned_at, day_order",
  session: "id, day_id, session_date, status, completed_at, assignment_id, workout_logs(exercise_id, set_index, weight, reps, duration_seconds, distance_meters, rpe, done)",
  challenge: "id, title, slug, status, duration_days, reward_type, created_at",
  message: "id, sender_role, body, sent_at",
  messageInbox: "id, client_id, sender_role, body, sent_at, read_at",
  note: "id, client_id, body, created_at, updated_at",
  sessionLite: "client_id, session_date, status",
  // computeConsistency needs to know whether each "complete" session actually
  // carries a done set — sessionLite alone can't distinguish a real
  // finish from an empty one.
  sessionConsistency: "client_id, session_date, status, workout_logs(done)",
  weight: "date, weight",
  mealPlan: "id, client_id, title, status, meals_per_day, target_calories, target_protein_g, target_fat_g, target_carb_g, notes, assigned_at, created_at",
  mealSlot: "id, plan_id, day_index, slot_index, slot_label, meal_id, servings, is_locked, note",
  meal: "id, name, summary, kcal, protein_g, fat_g, carb_g, category",
  // The coach app's Onboarding tab is intake_forms (src/pages/CoachClients.jsx -> Intake panel).
  // `token` is deliberately absent: it is a single-use client invite credential, never serialized.
  intake: "id, answers, health_flags, status, submitted_at, created_at",
  // Pipeline STATE, not answers — a different table and a different question.
  onboardingState: "stage, account_state, blockers, checkins_scheduled, notes, released_at, created_at, updated_at",
  // Body metrics live on clients but are outside F.client's thin allowlist on purpose.
  clientMetrics: "sex, age, height_cm, weight_kg, goal_weight_kg, unit_pref, activity_level, body_fat_pct, client_type, checkin_cadence, checkin_day_of_week",
  communityPost: "id, body, media_url, media_type, pinned, created_at",
  ticket: "id, client_id, title, detail, severity, status, resolution, opened_by, created_at, updated_at, resolved_at",
  template: "id, slug, title, body, category, created_at, updated_at",
  document: "id, client_id, kind, title, filename, storage_path, mime_type, size_bytes, uploaded_by, created_at",
  briefSlide: "id, position, image_path, caption, created_at, updated_at",
  // client_checkin_schedule rows for my_schedule/get_client_schedule (scheduleView.ts's
  // buildForwardSchedule). `checkin_id` and `id` deliberately excluded — nothing downstream
  // needs to link back to a specific schedule row, only the due date/cadence/status.
  checkinSchedule: "due_on, cadence, status",
  // Assignment fields my_schedule/get_client_schedule need beyond F.assignment: ends_on for
  // the program-block-end marker (already read this way, uninlined, by get_client_program_history).
  assignmentSchedule: "id, current_day_index, program_id, ends_on, day_order",
  // Trimmed projections for my_progress/get_client_progress (buildProgressTrends) — F.checkin
  // and F.session both carry fields this doesn't need (photo_urls, answers, per-set arrays).
  checkinWeight: "submitted_at, weight",
  workoutLogTrend: "session_id, exercise_id, weight, reps, done",
  sessionDateOnly: "id, session_date",
};

class ToolError extends Error {}
const notFound = (what: string) => new ToolError(`${what} not found in your workspace`);
async function must<T>(q: PromiseLike<{ data: T | null; error: { message: string } | null }>, label: string): Promise<T> {
  const { data, error } = await q;
  if (error) throw new ToolError(`${label}: ${error.message}`);
  if (data == null) throw new ToolError(`${label}: unavailable`);
  return data;
}
function daysBetween(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86400000);
}
// UTC calendar-day string — matches the DB's own convention for "today" (workout_sessions.
// session_date defaults to (now() AT TIME ZONE 'utc')::date). Used by my_schedule /
// get_client_schedule to bound the client_checkin_schedule read; there is no per-client
// timezone stored anywhere in this schema to do better than that.
function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// The non-throwing twin of must(): one failing source degrades that SECTION of a multi-source
// report into a named hole, instead of killing the whole call. Three quarters of a triage view
// with a labelled gap beats nothing at all — and the gap is stated, never silently omitted.
async function section<T>(
  q: PromiseLike<{ data: T | null; error: { message: string } | null }>,
  label: string,
): Promise<Section<T>> {
  try {
    const { data, error } = await q;
    if (error) return sectionFailed(`${label}: ${error.message}`);
    if (data == null) return sectionFailed(`${label}: unavailable`);
    return sectionOk(data);
  } catch (e) {
    return sectionFailed(`${label}: ${(e as Error).message}`);
  }
}
const sectionRows = <T>(s: Section<T[]>): T[] => (s.ok ? s.value : []);

// Last training date per client, read by paging newest-first until every client we care about
// is accounted for.
//
// WHY PAGING: the previous implementation read a single tenant-wide page of 400 sessions and
// derived every client's last training date from it. With a roster training most days that
// window is about three weeks, so a client who last trained a month ago fell outside it and was
// reported "not_tracked" — the system claiming it had never instrumented a person whose actual
// fact was that they had stopped training. That inverts the twin-facts rule and hides precisely
// the client this queue exists to surface.
//
// `complete` is false when the page cap is hit before the roster is covered. Callers must render
// that as its own state, never as "not tracked".
const SESSION_SCAN_PAGE = 1000;
const SESSION_SCAN_MAX_PAGES = 10;
async function lastSessionDates(
  ctx: Ctx,
  clientIds: string[],
  opts: { clientId?: string } = {},
): Promise<{ byClient: Map<string, string>; complete: boolean; reason: string | null }> {
  const wanted = new Set(clientIds);
  const byClient = new Map<string, string>();
  for (let page = 0; page < SESSION_SCAN_MAX_PAGES; page += 1) {
    let q = sel(ctx, "workout_sessions", "client_id, session_date")
      .order("session_date", { ascending: false })
      .range(page * SESSION_SCAN_PAGE, (page + 1) * SESSION_SCAN_PAGE - 1);
    if (opts.clientId) q = q.eq("client_id", opts.clientId);
    const { data, error } = await q;
    if (error) return { byClient, complete: false, reason: `session scan: ${error.message}` };
    const rows = (data ?? []) as unknown as Array<{ client_id: string; session_date: string | null }>;
    for (const row of rows) {
      if (row.session_date && !byClient.has(row.client_id)) byClient.set(row.client_id, row.session_date);
    }
    // Short page → the table is exhausted, so every client without an entry genuinely has none.
    if (rows.length < SESSION_SCAN_PAGE) return { byClient, complete: true, reason: null };
    if (wanted.size && [...wanted].every((id) => byClient.has(id))) {
      return { byClient, complete: true, reason: null };
    }
  }
  return {
    byClient,
    complete: false,
    reason: `session scan stopped after ${SESSION_SCAN_MAX_PAGES * SESSION_SCAN_PAGE} rows without covering the whole roster`,
  };
}

// ---------- media ----------
// progress_photos.photo_url and checkins.photo_urls hold STORAGE PATHS in a private bucket
// (src/lib/client.js:54 uploads to "progress-photos" and stores the path). Handing a raw path
// to an AI is handing it a dead string — it cannot fetch it and neither can anything else.
// Every photo returned by this surface is signed here, server-side, with the service-role key.
// The raw path is returned alongside so an expired link can be re-minted rather than lost.
const PHOTO_BUCKET = "progress-photos";
const SIGNED_URL_TTL_SECONDS = 3600;

export type SignedPhoto = { photo_path: string; url: string | null; url_error: string | null };

// Client documents (signed PAR-Q forms, waivers, IDs, medical notes) live in their own private
// bucket, never the photo one — a driver's licence has nothing to do with a physique photo, and
// mixing them would mean one bucket's RLS review has to reason about two unrelated risk levels.
// TTL is deliberately shorter than a progress photo's: a document link is more sensitive, and a
// coach requests one right when they need it rather than browsing a gallery of them.
const DOC_BUCKET = "client-documents";
const DOC_SIGNED_URL_TTL_SECONDS = 300;

async function signBucketPaths(bucket: string, ttlSeconds: number, paths: string[]): Promise<Map<string, SignedPhoto>> {
  const out = new Map<string, SignedPhoto>();
  const toSign: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    // Legacy rows may already hold a real URL; those pass through untouched.
    if (/^https?:\/\//i.test(p)) out.set(p, { photo_path: p, url: p, url_error: null });
    else if (!out.has(p)) toSign.push(p);
  }
  if (!toSign.length) return out;
  try {
    const { data, error } = await admin().storage.from(bucket).createSignedUrls(toSign, ttlSeconds);
    if (error) {
      for (const p of toSign) out.set(p, { photo_path: p, url: null, url_error: error.message });
      return out;
    }
    for (const row of (data ?? []) as Array<{ path?: string | null; signedUrl?: string | null; error?: string | null }>) {
      const path = row.path ?? "";
      if (!path) continue;
      // A photo whose link could not be minted says so, with a reason. It is not silently
      // omitted from the list — a missing photo reads as "they never sent one" — and it never
      // comes back as a bare null with no explanation, which reads as "there is no photo here".
      const url = row.error ? null : (row.signedUrl ?? null);
      out.set(path, {
        photo_path: path,
        url,
        url_error: row.error ?? (url ? null : "storage returned no signed url for this path (the file may be missing from the bucket)"),
      });
    }
    for (const p of toSign) if (!out.has(p)) out.set(p, { photo_path: p, url: null, url_error: "no signed url returned" });
  } catch (e) {
    for (const p of toSign) out.set(p, { photo_path: p, url: null, url_error: (e as Error).message });
  }
  return out;
}

async function signPhotoPaths(paths: string[]): Promise<Map<string, SignedPhoto>> {
  return signBucketPaths(PHOTO_BUCKET, SIGNED_URL_TTL_SECONDS, paths);
}
async function signDocumentPaths(paths: string[]): Promise<Map<string, SignedPhoto>> {
  return signBucketPaths(DOC_BUCKET, DOC_SIGNED_URL_TTL_SECONDS, paths);
}

async function ownedClient(ctx: Ctx, clientId: string) {
  const { data } = await sel(ctx, "clients", F.client).eq("id", clientId).maybeSingle();
  if (!data) throw notFound("client");
  return data;
}
// Move one Brief slide to a 1-based position by atomically renumbering the whole
// strip via set_brief_slide_order (migration 20260830190000) — the only sanctioned
// way to write positions; direct position writes would race the density invariant.
// Returns the slide's fresh row.
async function placeSlideAt(ctx: Ctx, slideId: string, position: number) {
  const rows = await must(
    sel(ctx, "brief_slides", "id, position, created_at")
      .order("position", { ascending: true }).order("created_at", { ascending: true }),
    "place_brief_slide",
  ) as any[];
  const ids = idsWithSlideAt(rows.map((r) => String(r.id)), slideId, position);
  if (!ids) throw notFound("slide");
  const { error } = await admin().rpc("set_brief_slide_order", { p_ids: ids, p_tenant: ctx.tenantId });
  if (error) throw new ToolError(error.message);
  const { data, error: readError } = await admin().from("brief_slides").select(F.briefSlide)
    .eq("id", slideId).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (readError) throw new ToolError(readError.message);
  if (!data) throw notFound("slide");
  return data;
}
// One named client's active assignment + its program, both tenant-pinned. The coach-side twin
// of myActiveAssignment(), which resolves the token's own client.
async function activeAssignmentFor(ctx: Ctx, clientId: string): Promise<{ assignment: any; program: any }> {
  const { data: assignment } = await sel(ctx, "assignments", "*")
    .eq("client_id", clientId).eq("active", true).maybeSingle() as { data: any };
  if (!assignment) throw new ToolError("this client has no active program assignment — assign one before logging against it");
  const { data: program } = await admin().from("programs").select("id, name, structure")
    .eq("id", assignment.program_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!program) throw new ToolError("their assigned program is no longer in the library");
  return { assignment, program };
}

async function ownedProgram(ctx: Ctx, programId: string) {
  const { data } = await sel(ctx, "programs", "id, name, structure, meal_plan, is_default, source_draft_id").eq("id", programId).maybeSingle();
  if (!data) throw notFound("program");
  return data;
}

// ---------- program structure validation ----------
const isUuid = (s: unknown) => typeof s === "string" && /^[0-9a-f-]{36}$/i.test(s);
const mint = () => crypto.randomUUID();

// A cardio exercise carries a prescription block instead of weight/rep sets — duration
// and/or distance, plus an RPE target. Requires at least one of duration or distance;
// a cardio finisher with neither is not a prescription, it's a name.
function normalizeCardio(c: any): Record<string, unknown> {
  const modality = String(c?.modality ?? "").trim();
  if (!modality) throw new ToolError("cardio exercise requires a modality");
  const target_duration_min = c?.target_duration_min == null ? null : Number(c.target_duration_min);
  const target_distance = c?.target_distance == null ? null : Number(c.target_distance);
  if (target_duration_min == null && target_distance == null)
    throw new ToolError(`cardio exercise "${modality}" requires target_duration_min and/or target_distance`);
  return {
    modality,
    target_duration_min,
    target_distance,
    target_distance_unit: target_distance == null ? null : (c?.target_distance_unit === "km" ? "km" : "mi"),
    target_intensity_rpe: c?.target_intensity_rpe == null ? null : Number(c.target_intensity_rpe),
  };
}

// Normalize + validate a structure; mints ids for nodes that lack them, never rewrites one.
function validateStructure(s: any): { days: any[] } {
  if (!s || !Array.isArray(s.days) || s.days.length === 0)
    throw new ToolError("structure must be { days: [...] } with at least one day");
  const days = s.days.map((d: any, i: number) => {
    if (d?.kind !== "training" && d?.kind !== "rest")
      throw new ToolError(`days[${i}].kind must be "training" or "rest"`);
    const groups = d.kind === "rest" ? [] : (Array.isArray(d.groups) ? d.groups : []);
    return {
      day_id: isUuid(d.day_id) ? d.day_id : mint(),
      kind: d.kind,
      label: String(d.label ?? "").trim() || (d.kind === "rest" ? "Rest" : `Day ${i + 1}`),
      groups: groups.map((g: any, gi: number) => ({
        group_id: isUuid(g?.group_id) ? g.group_id : mint(),
        type: typeof g?.type === "string" && g.type ? g.type : "straight",
        exercises: (Array.isArray(g?.exercises) ? g.exercises : []).map((ex: any, ei: number) => {
          const name = String(ex?.name ?? "").trim();
          if (!name) throw new ToolError(`days[${i}].groups[${gi}].exercises[${ei}].name is required`);
          const exercise_id = isUuid(ex?.exercise_id) ? ex.exercise_id : mint();
          if (ex?.type === "cardio") {
            // A single synthetic set (set_index 0) keeps this exercise walking through the
            // same exercise_id:set_index step iteration and workout_logs upsert key that
            // strength sets use — the session runner and history views don't need a second
            // code path for "how many steps does this exercise have".
            return {
              exercise_id, name, demo_media_url: ex?.demo_media_url || null,
              type: "cardio",
              cardio: normalizeCardio(ex.cardio),
              sets: [{ set_index: 0, target_reps: null, target_weight: null, notes: ex?.cardio?.notes || null }],
            };
          }
          const sets = Array.isArray(ex?.sets) && ex.sets.length ? ex.sets : [{}];
          return {
            exercise_id, name, demo_media_url: ex?.demo_media_url || null,
            type: "strength",
            sets: sets.map((st: any, si: number) => ({
              set_index: si,
              target_reps: String(st?.target_reps ?? "8-10"),
              target_weight: st?.target_weight == null ? null : Number(st.target_weight),
              notes: st?.notes || null,
            })),
          };
        }),
      })),
    };
  });
  return { days };
}

const structureIds = (s: any) => {
  const ids = new Set<string>();
  for (const d of s?.days ?? []) {
    if (d.day_id) ids.add(d.day_id);
    for (const g of d.groups ?? []) for (const ex of g.exercises ?? []) if (ex.exercise_id) ids.add(ex.exercise_id);
  }
  return ids;
};
const structureSummary = (s: any) => ({
  days: (s?.days ?? []).length,
  exercises: (s?.days ?? []).flatMap((d: any) => (d.groups ?? []).flatMap((g: any) => g.exercises ?? [])).length,
});
const programView = (p: any) => ({ id: p.id, name: p.name, is_default: p.is_default, origin: p.source_draft_id ? "ai_generated" : "hand_built", ...structureSummary(p.structure) });

// ---------- tools ----------
// needsCoach: the tool relays to a coach's inbox. Hidden and refused on self-serve tenants
// (see hiddenWithoutCoach in safety.ts).
type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; write?: boolean; scope?: ToolScope; needsCoach?: true; run: (ctx: Ctx, a: any) => Promise<unknown> };
const obj = (props: Record<string, unknown> = {}, required: string[] = []) =>
  ({ type: "object", properties: props, required, additionalProperties: false });
const S = {
  id: { type: "string", description: "uuid", pattern: UUID_PATTERN },
  limit: { type: "integer", minimum: 1, maximum: 100 },
};

// What a roster-wide view deliberately does NOT contain. Stated in the response rather than
// simply absent: an omission nobody is told about reads as "there was nothing there".
// Billing remains unavailable on this surface until the owner approves its readiness.
const NOT_INCLUDED = [
  {
    area: "billing",
    reason: "No billing data is exposed on this surface. Subscription status, payment-method health and revenue " +
      "are deliberately absent pending owner approval of billing readiness. Use Stripe directly for those.",
  },
  {
    area: "client documents",
    reason: "Signed forms, IDs and medical notes are not readable here. The storage backend, its access rules, " +
      "and whether raw PII documents should transit an AI tool call at all are unanswered questions.",
  },
];

// Cross-tenant tools are refused for every caller except the platform owner tenant itself —
// every other tool in this file scopes through sel(), which always filters by the
// caller's own tenant_id; a tool that lists ALL tenants has no tenant_id to filter by,
// so this check is the only thing standing between "the platform owner's own dashboard"
// and "any white-label coach can see every other coach's billing state."
async function requireOwnerTenant(ctx: Ctx) {
  const { data } = await admin().from("tenants").select("id, slug").eq("id", ctx.tenantId).maybeSingle();
  if (!data || data.slug !== OWNER_TENANT_SLUG) throw new ToolError("this tool is restricted to the platform owner");
}

// Trial/billing state, in plain language, from whichever of these fields is actually
// populated — never inferred from `plan` or `status`, which are "v1"/"active" for every
// tenant regardless of billing state and do not mean what their names suggest.
function tenantTierLabel(t: any, now: Date): string {
  if (t.comp_reason) return `Comped — ${t.comp_reason}`;
  if (t.subscription_status) return `Plan access — ${t.subscription_status}`;
  if (t.license_stripe_ref || t.licensed_at) return "License + hosting — active";
  if (t.trial_ends_at) {
    const daysLeft = Math.ceil((new Date(t.trial_ends_at).getTime() - now.getTime()) / 86_400_000);
    return daysLeft >= 0
      ? `14-day trial — ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`
      : `Trial expired ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago`;
  }
  return "No trial or billing record (pre-dates the trial field, or hand-provisioned)";
}

const COACH_TOOLS: Tool[] = [
  {
    name: "list_platform_tenants",
    description:
      "Every tenant on the platform (the platform owner plus every white-label coach) with its real billing/trial " +
      "state in plain language — trial days remaining or expired, subscription status, license " +
      "status, or comp reason. Restricted to the platform owner tenant; any other caller is refused.",
    inputSchema: obj(),
    run: async (ctx) => {
      await requireOwnerTenant(ctx);
      const { data, error } = await admin().from("tenants")
        .select("slug, created_at, trial_ends_at, subscription_status, license_stripe_ref, licensed_at, comp_reason")
        .order("created_at", { ascending: true });
      if (error) throw new ToolError(error.message);
      const now = new Date();
      return (data ?? []).map((t: any) => ({
        slug: t.slug,
        created_at: t.created_at,
        billing_state: tenantTierLabel(t, now),
      }));
    },
  },
  {
    name: "list_system_buyers",
    description:
      "Every Self-serve plan buyer (self-serve tenants) with intake / program / meal-plan / AI-connection state and a " +
      "masked email. Restricted to the platform owner tenant; any other caller is refused. Read-only; there is no " +
      "action on a buyer from here.",
    inputSchema: obj(),
    run: async (ctx) => {
      await requireOwnerTenant(ctx);
      const { data, error } = await admin().rpc("list_system_buyers");
      if (error) throw new ToolError(error.message);
      return { buyers: data ?? [], count: (data ?? []).length,
        not_included: ["app opens (not tracked)", "payments (Stripe is the record)"] };
    },
  },
  {
    name: "get_business_snapshot",
    description: "Roster and activity rollup for the coach's whole business: client counts by tier/status, unseen check-ins, programs, active challenge runs.",
    inputSchema: obj(),
    run: async (ctx) => {
      const [cl, ck, pr, runs] = await Promise.all([
        sel(ctx, "clients", "status, coaching_tier"),
        sel(ctx, "checkins", "id").eq("coach_seen", false),
        sel(ctx, "programs", "id, source_draft_id"),
        sel(ctx, "challenge_runs", "status"),
      ]);
      const byTier: Record<string, number> = {}, byStatus: Record<string, number> = {};
      for (const c of cl.data ?? []) {
        byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
        if (c.coaching_tier) byTier[c.coaching_tier] = (byTier[c.coaching_tier] ?? 0) + 1;
      }
      const runsByStatus: Record<string, number> = {};
      for (const r of runs.data ?? []) runsByStatus[r.status] = (runsByStatus[r.status] ?? 0) + 1;
      return {
        clients_by_status: byStatus, clients_by_tier: byTier,
        unseen_checkins: (ck.data ?? []).length,
        programs: { total: (pr.data ?? []).length, ai_generated: (pr.data ?? []).filter((p: any) => p.source_draft_id).length },
        challenge_runs_by_status: runsByStatus,
      };
    },
  },
  {
    name: "list_clients",
    description: "All clients in the coach's workspace with tier, status and subscription state.",
    inputSchema: obj(),
    run: async (ctx) => (await sel(ctx, "clients", F.client).order("display_name")).data ?? [],
  },
  {
    name: "get_client",
    description: "One client in depth: profile, latest check-ins, weight trend, and their active program with current day position.",
    inputSchema: obj({ client_id: S.id }, ["client_id"]),
    run: async (ctx, a) => {
      const client = await ownedClient(ctx, a.client_id);
      const [checkins, weights, assign] = await Promise.all([
        sel(ctx, "checkins", F.checkin).eq("client_id", a.client_id).order("submitted_at", { ascending: false }).limit(5),
        sel(ctx, "progress_weights", F.weight).eq("client_id", a.client_id).order("date", { ascending: false }).limit(12),
        sel(ctx, "assignments", F.assignment).eq("client_id", a.client_id).eq("active", true).maybeSingle(),
      ]);
      let program = null;
      if (assign.data) {
        const p = await ownedProgram(ctx, assign.data.program_id);
        // Resolved per assignment.day_order (client schedule adjustments) when set,
        // else the program's own order — see effectiveDays.ts. Never index
        // structure.days by current_day_index directly.
        const { days } = resolveEffectiveDays(p as any, assign.data as any);
        program = {
          ...programView(p),
          current_day_index: assign.data.current_day_index,
          current_day_label: days[assign.data.current_day_index]?.label ?? null,
        };
      }
      return { client, recent_checkins: checkins.data ?? [], weight_trend: weights.data ?? [], active_program: program };
    },
  },
  {
    name: "list_checkins",
    description: "Client check-ins (weight + answers), newest first. Filter to one client and/or to unseen only.",
    inputSchema: obj({ client_id: S.id, unseen_only: { type: "boolean" }, limit: S.limit }),
    run: async (ctx, a) => {
      let q = sel(ctx, "checkins", F.checkin).order("submitted_at", { ascending: false }).limit(a?.limit ?? 20);
      if (a?.client_id) q = q.eq("client_id", a.client_id);
      if (a?.unseen_only) q = q.eq("coach_seen", false);
      return (await q).data ?? [];
    },
  },
  {
    name: "get_client_workouts",
    description: "A client's workout sessions with per-set actuals — weight × reps for strength, duration/distance/rpe for cardio — newest first, across all program cycles.",
    inputSchema: obj({ client_id: S.id, limit: S.limit }, ["client_id"]),
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const s = await sel(ctx, "workout_sessions", F.session).eq("client_id", a.client_id)
        .order("session_date", { ascending: false }).limit(a?.limit ?? 15);
      return s.data ?? [];
    },
  },
  {
    name: "get_client_schedule",
    description:
      "A client's calendar view: planned program days projected forward (same projection as their app calendar), upcoming check-in due dates, program block end, and show-day countdown. days_ahead defaults to 14 (max 60). States are explicit: planned.state 'not_tracked' means no active program — not a rest week — and checkins.state 'not_scheduled' means the system has no schedule for this client, not that nothing is due.",
    inputSchema: obj({ client_id: S.id, days_ahead: { type: "integer", minimum: 1, maximum: 60 } }, ["client_id"]),
    run: async (ctx, a) => {
      const client = await ownedClient(ctx, a.client_id);
      const daysAhead = a?.days_ahead ?? 14;
      const today = new Date();
      const toDate = new Date(today);
      toDate.setDate(toDate.getDate() + daysAhead - 1);

      const assignment = (await sel(ctx, "assignments", F.assignmentSchedule).eq("client_id", a.client_id).eq("active", true).maybeSingle()).data;
      const program = assignment
        ? (await admin().from("programs").select("id, name, structure").eq("id", (assignment as any).program_id).eq("tenant_id", ctx.tenantId).maybeSingle()).data
        : null;
      const scheduleRows = (await sel(ctx, "client_checkin_schedule", F.checkinSchedule).eq("client_id", a.client_id)
        .gte("due_on", ymdUtc(today)).lte("due_on", ymdUtc(toDate)).order("due_on")).data ?? [];

      return {
        client_id: a.client_id,
        display_name: (client as any).display_name,
        ...buildForwardSchedule({ today, fromDate: today, toDate, program, assignment, scheduleRows, client }),
        as_of: ymdUtc(today),
      };
    },
  },
  {
    name: "get_client_progress",
    description:
      "A client's progress trends: weight series, best-set strength series per current-program exercise, and the promises-kept consistency metric (consecutive weeks meeting the program's training-day target). Fields with state 'not_tracked' were never instrumented for this client and must not be read as zeros.",
    inputSchema: obj({ client_id: S.id }, ["client_id"]),
    run: async (ctx, a) => {
      const client = await ownedClient(ctx, a.client_id);
      const [weightRows, checkinWeightRows, workoutLogRows, assignment] = await Promise.all([
        sel(ctx, "progress_weights", F.weight).eq("client_id", a.client_id).order("date", { ascending: true }).then((r) => r.data ?? []),
        sel(ctx, "checkins", F.checkinWeight).eq("client_id", a.client_id).not("weight", "is", null).then((r) => r.data ?? []),
        sel(ctx, "workout_logs", F.workoutLogTrend).eq("client_id", a.client_id).then((r) => r.data ?? []),
        sel(ctx, "assignments", F.assignment).eq("client_id", a.client_id).eq("active", true).maybeSingle().then((r) => r.data),
      ]);

      const sessionIds = [...new Set((workoutLogRows as any[]).map((l) => l.session_id))];
      const sessionDateById: Record<string, string> = {};
      if (sessionIds.length > 0) {
        const { data: sessions } = await sel(ctx, "workout_sessions", F.sessionDateOnly).eq("client_id", a.client_id).in("id", sessionIds);
        for (const s of (sessions ?? []) as any[]) sessionDateById[s.id] = s.session_date;
      }

      const program = assignment
        ? (await admin().from("programs").select("structure").eq("id", (assignment as any).program_id).eq("tenant_id", ctx.tenantId).maybeSingle()).data
        : null;
      const days = Array.isArray((program as any)?.structure?.days) ? (program as any).structure.days : [];
      const programExerciseNameById: Record<string, string> = {};
      for (const d of days as any[]) for (const g of d.groups ?? []) for (const ex of g.exercises ?? []) programExerciseNameById[ex.exercise_id] = ex.name;

      const sessionQuery = sel(ctx, "workout_sessions", F.sessionConsistency).eq("client_id", a.client_id);
      const assignedAt = (assignment as any)?.assigned_at ?? null;
      const { data: sessionsForConsistency } = assignedAt
        ? await sessionQuery.gte("session_date", String(assignedAt).slice(0, 10))
        : await sessionQuery;

      return {
        client_id: a.client_id,
        display_name: (client as any).display_name,
        ...buildProgressTrends({ weightRows: weightRows as any, checkinWeightRows: checkinWeightRows as any, workoutLogRows: workoutLogRows as any, sessionDateById, programExerciseNameById }),
        consistency: computeConsistency({ today: new Date(), sessions: (sessionsForConsistency ?? []) as any, programDays: days, assignedAt }),
      };
    },
  },
  {
    name: "list_progress_photos",
    description:
      "A client's physique progress photos, newest first, each with a fetchable signed URL (valid one hour) " +
      "alongside its storage path. Distinct from any photos attached to a single check-in submission — this is " +
      "the dedicated pose-tagged timeline. A photo whose link could not be minted is still listed, with the " +
      "reason, rather than dropped.",
    inputSchema: obj({ client_id: S.id, limit: S.limit }, ["client_id"]),
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const rows = await must(
        sel(ctx, "progress_photos", F.progressPhoto).eq("client_id", a.client_id)
          .order("taken_at", { ascending: false }).limit(a?.limit ?? 20),
        "list_progress_photos",
      ) as any[];
      const signed = await signPhotoPaths(rows.map((r) => r.photo_url));
      return rows.map((r) => ({
        ...r,
        ...(signed.get(r.photo_url) ?? { photo_path: r.photo_url, url: null, url_error: "not signed" }),
      }));
    },
  },
  {
    name: "get_checkin_detail",
    description:
      "One check-in in full: the client's written answers, weight, every attached photo as a fetchable signed " +
      "URL, whether the coach has marked it seen, and any AI assessment already recorded against it. " +
      "list_checkins gives you the summary; this is the whole submission.",
    inputSchema: obj({ checkin_id: S.id }, ["checkin_id"]),
    run: async (ctx, a) => {
      const { data: checkin } = await sel(ctx, "checkins", F.checkin).eq("id", a.checkin_id).maybeSingle() as { data: any };
      if (!checkin) throw notFound("check-in");
      const [assessS, photoS, clientS] = await Promise.all([
        section(sel(ctx, "checkin_assessments", "id, summary, proposed_tag, confirmed_tag, no_tag_reason, needs_review, excluded_fields, summary_generated_at")
          .eq("checkin_id", a.checkin_id).limit(1), "checkin_assessment"),
        section(sel(ctx, "progress_photos", F.progressPhoto).eq("source_checkin_id", a.checkin_id)
          .order("taken_at", { ascending: false }), "linked_progress_photos"),
        section(sel(ctx, "clients", F.client).eq("id", checkin.client_id).limit(1), "client"),
      ]);

      // Two photo sources, deliberately kept apart: the paths stored on the check-in row itself,
      // and the progress_photos rows created from it. They usually agree; when they do not, that
      // is a real fact about a failed write (src/lib/client.js records exactly that failure mode).
      const attachedPaths: string[] = Array.isArray(checkin.photo_urls) ? checkin.photo_urls.filter(Boolean) : [];
      const timelineRows = sectionRows(photoS as Section<any[]>);
      const signed = await signPhotoPaths([...attachedPaths, ...timelineRows.map((r) => r.photo_url)]);
      const blank = (p: string) => ({ photo_path: p, url: null, url_error: "not signed" });

      return {
        checkin: { ...checkin, photo_urls: undefined },
        client: clientS.ok ? ((clientS.value as any[])[0] ?? null) : renderSection(clientS),
        submitted_photos: attachedPaths.map((p) => signed.get(p) ?? blank(p)),
        timeline_photos: timelineRows.map((r) => ({ ...r, ...(signed.get(r.photo_url) ?? blank(r.photo_url)) })),
        photos_on_checkin_not_on_timeline: attachedPaths.filter((p) => !timelineRows.some((r) => r.photo_url === p)).length,
        assessment: assessS.ok ? ((assessS.value as any[])[0] ?? null) : renderSection(assessS),
        unavailable_sections: unavailableSections({ checkin_assessment: assessS, linked_progress_photos: photoS, client: clientS }).length
          ? unavailableSections({ checkin_assessment: assessS, linked_progress_photos: photoS, client: clientS })
          : null,
      };
    },
  },
  {
    name: "compare_progress_photos",
    description:
      "Two dated progress photos for one client, side by side, each as a fetchable signed URL, with the client's " +
      "weight on or nearest each date. Defaults to oldest vs newest; pass from_date/to_date to pick a window, and " +
      "pose_tag to compare the same pose. If the client has only one photo it returns one and says so — it never " +
      "returns the same photo twice to fill the shape.",
    inputSchema: obj({
      client_id: S.id,
      from_date: { type: "string", description: "ISO date; the earlier photo is the one nearest this date" },
      to_date: { type: "string", description: "ISO date; the later photo is the one nearest this date" },
      pose_tag: { type: "string", maxLength: 40 },
    }, ["client_id"]),
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      let q = sel(ctx, "progress_photos", F.progressPhoto).eq("client_id", a.client_id)
        .order("taken_at", { ascending: true }).limit(500);
      if (a?.pose_tag) q = q.eq("pose_tag", a.pose_tag);
      const photos = await must(q, "compare_progress_photos") as any[];

      if (!photos.length) {
        return {
          comparison_state: "no_photos",
          message: a?.pose_tag
            ? `This client has no progress photos tagged "${a.pose_tag}". They may have untagged photos — call without pose_tag to check.`
            : "This client has never uploaded a progress photo.",
          before: null, after: null,
        };
      }
      const nearest = (target: string | null, fallback: any) => {
        if (!target) return fallback;
        const t = Date.parse(target);
        if (!Number.isFinite(t)) return fallback;
        return photos.reduce((best, p) =>
          Math.abs(Date.parse(p.taken_at) - t) < Math.abs(Date.parse(best.taken_at) - t) ? p : best, photos[0]);
      };
      const before = nearest(a?.from_date ?? null, photos[0]);
      const after = nearest(a?.to_date ?? null, photos[photos.length - 1]);
      const sameShot = before.id === after.id;

      const weightsRows = await section(
        sel(ctx, "progress_weights", F.weight).eq("client_id", a.client_id).order("date", { ascending: true }).limit(500),
        "progress_weights",
      );
      const weights = sectionRows(weightsRows as Section<any[]>);
      const weightNear = (iso: string) => {
        if (!weights.length) return null;
        const t = Date.parse(iso);
        const best = weights.reduce((b, w) =>
          Math.abs(Date.parse(`${w.date}T00:00:00Z`) - t) < Math.abs(Date.parse(`${b.date}T00:00:00Z`) - t) ? w : b, weights[0]);
        return { date: best.date, weight: best.weight, days_from_photo: Math.round(Math.abs(Date.parse(`${best.date}T00:00:00Z`) - t) / 86400000) };
      };

      const signed = await signPhotoPaths([before.photo_url, after.photo_url]);
      const view = (p: any) => ({
        id: p.id, taken_at: p.taken_at, pose_tag: p.pose_tag, source_checkin_id: p.source_checkin_id,
        ...(signed.get(p.photo_url) ?? { photo_path: p.photo_url, url: null, url_error: "not signed" }),
        weight_nearest: weightNear(p.taken_at),
      });

      return {
        comparison_state: sameShot ? "only_one_photo" : "ok",
        ...(sameShot ? { message: "Only one photo matched — returning it once rather than comparing it to itself." } : {}),
        pose_tag: a?.pose_tag ?? null,
        photos_available: photos.length,
        days_between: sameShot ? 0 : Math.round((Date.parse(after.taken_at) - Date.parse(before.taken_at)) / 86400000),
        before: view(before),
        after: sameShot ? null : view(after),
        weights_unavailable: weightsRows.ok ? null : (weightsRows as { unavailable: string }).unavailable,
      };
    },
  },
  {
    name: "list_programs",
    description: "The program library: hand-built splits and AI-generated per-client plans, with day/exercise counts. Archived programs are excluded unless include_archived is true.",
    inputSchema: obj({ include_archived: { type: "boolean" } }),
    run: async (ctx, a) => {
      let q = sel(ctx, "programs", F.programList + ", archived_at");
      if (!a?.include_archived) q = q.is("archived_at", null);
      return ((await q.order("created_at", { ascending: false })).data ?? [])
        .map((p: any) => ({ ...programView(p), archived_at: p.archived_at ?? null }));
    },
  },
  {
    name: "get_program",
    description: "One program's full structure (days → groups → exercises → target sets). Structure uuids are stable linkage keys — reuse them verbatim when editing.",
    inputSchema: obj({ program_id: S.id }, ["program_id"]),
    run: async (ctx, a) => {
      const p = await ownedProgram(ctx, a.program_id);
      const active = await sel(ctx, "assignments", "id").eq("program_id", p.id).eq("active", true);
      return { ...p, active_assignments: (active.data ?? []).length };
    },
  },
  {
    name: "list_challenges",
    description: "Challenges with run counts by status (enrolled, completed, perfect week, rewarded).",
    inputSchema: obj(),
    run: async (ctx) => {
      const [ch, runs] = await Promise.all([
        sel(ctx, "challenges", F.challenge).order("created_at", { ascending: false }),
        sel(ctx, "challenge_runs", "challenge_id, status"),
      ]);
      return (ch.data ?? []).map((c: any) => {
        const rs = (runs.data ?? []).filter((r: any) => r.challenge_id === c.id);
        const by: Record<string, number> = {};
        for (const r of rs) by[r.status] = (by[r.status] ?? 0) + 1;
        return { ...c, runs_by_status: by, total_runs: rs.length };
      });
    },
  },
  {
    name: "list_messages",
    description: "The message thread with one client, oldest first.",
    inputSchema: obj({ client_id: S.id, limit: S.limit }, ["client_id"]),
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      return (await sel(ctx, "messages", F.message).eq("client_id", a.client_id)
        .order("sent_at", { ascending: true }).limit(a?.limit ?? 50)).data ?? [];
    },
  },
  {
    name: "search_clients",
    description: "Find clients by display name. Use this instead of listing the whole roster when you already know who you are looking for.",
    inputSchema: obj({ query: { type: "string", minLength: 1, maxLength: 80 }, limit: S.limit }, ["query"]),
    run: async (ctx, a) => {
      const q = String(a.query).trim();
      return await must(
        sel(ctx, "clients", F.client).ilike("display_name", `%${q}%`).order("display_name").limit(a?.limit ?? 20),
        "search_clients",
      );
    },
  },
  {
    name: "list_inbox",
    description: "Unread client messages grouped by thread. Preview only. Does not mark read and does not send.",
    inputSchema: obj({ limit: S.limit }),
    run: async (ctx, a) => {
      const rows = await must(
        sel(ctx, "messages", F.messageInbox)
          .eq("sender_role", "client")
          .is("read_at", null)
          .order("sent_at", { ascending: false })
          .limit(a?.limit ?? 50),
        "list_inbox",
      );
      const byClient = new Map<string, { client_id: string; unread: number; latest_at: string; preview: string }>();
      for (const row of rows as any[]) {
        const existing = byClient.get(row.client_id);
        if (!existing) {
          byClient.set(row.client_id, {
            client_id: row.client_id,
            unread: 1,
            latest_at: row.sent_at,
            preview: String(row.body ?? "").slice(0, 180),
          });
        } else {
          existing.unread += 1;
        }
      }
      return [...byClient.values()];
    },
  },
  {
    name: "list_client_notes",
    description: "Coach-private notes on one client, newest first. Clients cannot see these. Archived notes are excluded unless include_archived is true.",
    inputSchema: obj({ client_id: S.id, limit: S.limit, include_archived: { type: "boolean" } }, ["client_id"]),
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      let q = sel(ctx, "client_notes", F.note).eq("client_id", a.client_id);
      if (!a?.include_archived) q = q.is("archived_at", null);
      return await must(q.order("created_at", { ascending: false }).limit(a?.limit ?? 20), "list_client_notes");
    },
  },
  {
    name: "get_support_queue",
    description:
      "One-call coaching triage: unread threads, unseen check-ins, last training date, and last logged contact " +
      "for active clients, ordered by what most needs a human. Does not guess why a client is quiet. " +
      "training_state is one of: recent, stale (they trained but not lately), never_trained (they have a program " +
      "and have logged nothing — a real zero, not a gap), not_tracked (no active program, so there was never " +
      "anything to measure), or unknown_scan_incomplete (the history scan could not reach far enough back — not " +
      "an answer). Never 'missed'. Each roster entry's last_contact_at is the most recent coach note logged for " +
      "that client (null means no contact has ever been logged, not that logging is unavailable) — check it " +
      "before reaching out, so outreach already logged today doesn't get repeated. " +
      "If one source fails, that section is returned as an explicit {unavailable} marker and the rest still comes back.",
    inputSchema: obj({ stale_after_days: { type: "integer", minimum: 1, maximum: 365 } }),
    run: async (ctx, a) => {
      const staleAfter = a?.stale_after_days ?? 7;
      // Each source is independently degradable: one failure names its own hole rather than
      // taking the whole triage view down with it.
      const [clientsS, checkinsS, unreadS, assignS, notesS] = await Promise.all([
        section(sel(ctx, "clients", F.client).eq("status", "active").order("display_name"), "clients"),
        section(sel(ctx, "checkins", "id, client_id, submitted_at").eq("coach_seen", false)
          .order("submitted_at", { ascending: false }).limit(200), "unseen_checkins"),
        section(sel(ctx, "messages", "client_id").eq("sender_role", "client").is("read_at", null)
          .order("sent_at", { ascending: false }).limit(500), "unread_messages"),
        section(sel(ctx, "assignments", "client_id").eq("active", true), "assignments"),
        // Coach notes are the outreach record messages/check-ins don't capture (a text, a call).
        // Archived notes excluded, matching list_client_notes' default — an archived note is one
        // a coach set aside as no longer current, not evidence of live-standing recent contact.
        // Ordered newest-first so the first row seen per client below is their most recent.
        section(sel(ctx, "client_notes", "client_id, created_at").is("archived_at", null)
          .order("created_at", { ascending: false }).limit(2000), "client_notes"),
      ]);
      if (!clientsS.ok) throw new ToolError(clientsS.unavailable);

      const clients = clientsS.value as any[];
      const unreadByClient = new Map<string, number>();
      for (const row of sectionRows(unreadS as Section<any[]>)) {
        unreadByClient.set(row.client_id, (unreadByClient.get(row.client_id) ?? 0) + 1);
      }
      const withAssignment = new Set(sectionRows(assignS as Section<any[]>).map((r) => r.client_id));
      const lastContactByClient = new Map<string, string>();
      for (const row of sectionRows(notesS as Section<any[]>)) {
        if (!lastContactByClient.has(row.client_id)) lastContactByClient.set(row.client_id, row.created_at);
      }

      const scan = await lastSessionDates(ctx, clients.map((c) => c.id));

      const queue = buildSupportQueue({
        clients: clients.map((c) => ({ id: c.id, display_name: c.display_name, coaching_tier: c.coaching_tier })),
        unreadByClient,
        lastSessionByClient: scan.byClient,
        // A failed assignments read must not masquerade as "nobody has a program" — that would
        // turn every never-trained client into a false not_tracked. Treat the scan as incomplete.
        clientsWithActiveAssignment: withAssignment,
        sessionScanComplete: scan.complete && assignS.ok,
        unseenCheckins: sectionRows(checkinsS as Section<any[]>) as any,
        staleAfterDays: staleAfter,
        lastContactByClient,
      });

      const gaps = unavailableSections({ unseen_checkins: checkinsS, unread_messages: unreadS, assignments: assignS, client_notes: notesS });
      return {
        ...queue,
        ...(checkinsS.ok ? {} : { unseen_checkins: renderSection(checkinsS), unseen_checkin_ids: renderSection(checkinsS) }),
        ...(unreadS.ok ? {} : { unread_threads: renderSection(unreadS) }),
        session_scan_note: scan.reason,
        unavailable_sections: gaps.length ? gaps : null,
      };
    },
  },
  {
    name: "get_client_support_brief",
    description: "One-call support brief for a single client: profile, latest check-ins, latest messages, last training date, and coach notes. Use this instead of stacking get_client + list_messages + get_client_workouts. Does not send and does not mark read.",
    inputSchema: obj({ client_id: S.id }, ["client_id"]),
    run: async (ctx, a) => {
      const client = await ownedClient(ctx, a.client_id);
      const [checkins, messages, sessions, notes, weights] = await Promise.all([
        must(sel(ctx, "checkins", F.checkin).eq("client_id", a.client_id).order("submitted_at", { ascending: false }).limit(5), "support_brief.checkins"),
        must(sel(ctx, "messages", F.messageInbox).eq("client_id", a.client_id).order("sent_at", { ascending: false }).limit(8), "support_brief.messages"),
        must(sel(ctx, "workout_sessions", F.sessionLite).eq("client_id", a.client_id).order("session_date", { ascending: false }).limit(5), "support_brief.sessions"),
        must(sel(ctx, "client_notes", F.note).eq("client_id", a.client_id).order("created_at", { ascending: false }).limit(5), "support_brief.notes"),
        must(sel(ctx, "progress_weights", F.weight).eq("client_id", a.client_id).order("date", { ascending: false }).limit(6), "support_brief.weights"),
      ]);
      const lastSession = (sessions as any[])[0]?.session_date ?? null;
      const days = daysBetween(lastSession);
      return {
        client,
        recent_checkins: checkins,
        recent_messages: [...(messages as any[])].reverse(),
        last_session_date: lastSession,
        days_since_last_session: days,
        training_state: days == null ? "not_tracked" : days > 7 ? "stale" : "recent",
        coach_notes: notes,
        weight_trend: weights,
      };
    },
  },
  {
    name: "get_client_onboarding",
    description:
      "The client's submitted intake — the same Onboarding tab the coach sees in the app: goal, equipment access, " +
      "training experience, days available per week, injuries, allergies, medical notes, plus body metrics and the " +
      "onboarding pipeline state. Reads the real submitted answers; it never fills a blank with a default. " +
      "intake_state is submitted, no_intake_submitted (nobody has ever filled it in), or intake_pending (a form was " +
      "sent and not returned) — those are different facts. `missing` names every required answer that is absent. " +
      "`onboarding` is the status-view row: next_action (send_intake … onboarded) plus every fact it rests on; " +
      "paid_via_platform is true or null (not tracked), never false.",
    inputSchema: obj({ client_id: S.id, limit: S.limit }, ["client_id"]),
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const [intakesS, pendingS, stateS, metricsS] = await Promise.all([
        section(sel(ctx, "intake_forms", F.intake).eq("client_id", a.client_id).eq("status", "submitted")
          .order("submitted_at", { ascending: false }).limit(a?.limit ?? 10), "intake_forms"),
        section(sel(ctx, "intake_forms", "id, created_at, expires_at").eq("client_id", a.client_id)
          .eq("status", "pending").order("created_at", { ascending: false }).limit(5), "pending_intake_forms"),
        section(sel(ctx, "client_onboarding", F.onboardingState).eq("client_id", a.client_id)
          .order("updated_at", { ascending: false }).limit(1), "client_onboarding"),
        section(admin().from("clients").select(F.clientMetrics)
          .eq("id", a.client_id).eq("tenant_id", ctx.tenantId).limit(1), "profile_metrics"),
      ]);
      if (!intakesS.ok) throw new ToolError(intakesS.unavailable);
      // Slice 1: the status view's row for this client — same function the coach's roster reads.
      const factsS = await section(admin().rpc("client_onboarding_facts", { p_tenant_id: ctx.tenantId }), "onboarding_facts");
      const factRow = factsS.ok ? ((factsS.value as any[]).find((r) => r.client_id === a.client_id) ?? null) : null;

      const intakes = (intakesS.value as any[]).map((r) => ({ ...r, answers: redactAnswers(r.answers) }));
      const latest = intakes[0] ?? null;
      const metrics = (metricsS.ok ? (metricsS.value as any[])[0] : null) ?? null;
      const pending = sectionRows(pendingS as Section<any[]>);

      const intake_state = latest ? "submitted" : (pending.length ? "intake_pending" : "no_intake_submitted");
      return {
        intake_state,
        latest_intake: latest,
        intake_history: intakes.slice(1),
        pending_forms: pendingS.ok ? pending.length : renderSection(pendingS),
        // next_action + every fact it rests on (intake/draft/program/nutrition/invite/first set).
        // paid_via_platform is true or null (not tracked) — never false; see the SQL comment.
        onboarding: factsS.ok ? factRow : renderSection(factsS),
        onboarding_state: stateS.ok ? ((stateS.value as any[])[0] ?? null) : renderSection(stateS),
        profile_metrics: metricsS.ok ? metrics : renderSection(metricsS),
        parq: latest ? parqView(latest.answers) : null,
        waiver: latest ? waiverView(latest.answers) : null,
        missing: latest ? intakeCompleteness(latest.answers, metrics) : null,
        unavailable_sections: unavailableSections({
          pending_intake_forms: pendingS, client_onboarding: stateS, profile_metrics: metricsS, onboarding_facts: factsS,
        }).length
          ? unavailableSections({ pending_intake_forms: pendingS, client_onboarding: stateS, profile_metrics: metricsS, onboarding_facts: factsS })
          : null,
      };
    },
  },
  {
    name: "get_client_parq",
    description:
      "The client's PAR-Q health screen, read directly rather than as a side effect of generate_program_draft. " +
      "Each of the eight questions comes back true, false, or null — null means the question was never answered " +
      "and is NOT the same as 'no'. Also returns which answers raised a flag, and whether medications were " +
      "disclosed. A flagged or incomplete screen is a reason to stop and ask, not a number to work around.",
    inputSchema: obj({ client_id: S.id }, ["client_id"]),
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const rows = await must(
        sel(ctx, "intake_forms", F.intake).eq("client_id", a.client_id).eq("status", "submitted")
          .order("submitted_at", { ascending: false }).limit(1),
        "get_client_parq",
      );
      const latest = (rows as any[])[0] ?? null;
      if (!latest) {
        return {
          parq_state: "no_intake_submitted",
          message: "This client has never submitted an intake, so the health screen has never been asked. " +
            "That is a gap in what was collected, not a clean screen.",
          parq: null,
        };
      }
      const view = parqView(latest.answers);
      return {
        parq_state: view.complete ? (view.flagged.length ? "flagged" : "clear") : "incomplete",
        intake_id: latest.id,
        submitted_at: latest.submitted_at,
        stored_health_flags: latest.health_flags ?? [],
        parq: view,
      };
    },
  },
  {
    name: "get_escalation_history",
    description:
      "Support tickets logged in this workspace, newest first — the whole business, or filtered to one client, " +
      "one status or one severity. A resolved ticket always carries how it was resolved; the schema will not " +
      "let one be closed without that.",
    inputSchema: obj({
      client_id: S.id,
      status: { type: "string", enum: ["open", "acknowledged", "resolved", "all"] },
      severity: { type: "string", enum: ["low", "normal", "high"] },
      limit: S.limit,
    }),
    run: async (ctx, a) => {
      let q = sel(ctx, "support_tickets", F.ticket).order("created_at", { ascending: false }).limit(a?.limit ?? 50);
      if (a?.client_id) q = q.eq("client_id", a.client_id);
      if (a?.status && a.status !== "all") q = q.eq("status", a.status);
      if (a?.severity) q = q.eq("severity", a.severity);
      const rows = await must(q, "get_escalation_history") as any[];
      const names = new Map<string, string>();
      const ids = [...new Set(rows.map((r) => r.client_id).filter(Boolean))];
      if (ids.length) {
        const { data } = await sel(ctx, "clients", "id, display_name").in("id", ids);
        for (const c of (data ?? []) as any[]) names.set(c.id, c.display_name);
      }
      const open = rows.filter((r) => r.status !== "resolved");
      return {
        total: rows.length,
        open: open.length,
        open_high_severity: open.filter((r) => r.severity === "high").length,
        tickets: rows.map((r) => ({ ...r, display_name: r.client_id ? (names.get(r.client_id) ?? null) : null })),
        note: rows.length ? undefined : "No support tickets have ever been logged in this workspace.",
      };
    },
  },
  {
    name: "get_message_templates",
    description: "Saved reusable message bodies for this workspace. Bodies may contain {{display_name}} / {{first_name}}, which send_bulk_message substitutes per recipient.",
    inputSchema: obj({ category: { type: "string", maxLength: 60 }, limit: S.limit }),
    run: async (ctx, a) => {
      let q = sel(ctx, "message_templates", F.template).order("title").limit(a?.limit ?? 50);
      if (a?.category) q = q.eq("category", a.category);
      const rows = await must(q, "get_message_templates") as any[];
      return { templates: rows, note: rows.length ? undefined : "No message templates have been saved in this workspace yet." };
    },
  },
  {
    name: "get_compliance_status",
    description:
      "One gate check per client: PAR-Q answered and whether anything is flagged, waiver signed, and whether the " +
      "intake is complete enough to program from. Pass client_id for one client, or omit it for the roster. " +
      "compliance_state is clear, flagged (a health answer needs a human), incomplete (questions unanswered) or " +
      "no_intake (nobody ever asked). Those are four different facts and none of them is 'fine'.",
    inputSchema: obj({ client_id: S.id, status: { type: "string", enum: ["active", "all"] } }),
    run: async (ctx, a) => {
      let clientQ = sel(ctx, "clients", F.client).order("display_name");
      if (a?.client_id) clientQ = clientQ.eq("id", a.client_id);
      else if ((a?.status ?? "active") === "active") clientQ = clientQ.eq("status", "active");
      const clients = await must(clientQ, "get_compliance_status.clients") as any[];
      if (!clients.length) throw notFound(a?.client_id ? "client" : "clients");
      const ids = clients.map((c) => c.id);

      const [intakesS, metricsS] = await Promise.all([
        section(sel(ctx, "intake_forms", "client_id, answers, health_flags, status, submitted_at")
          .in("client_id", ids).eq("status", "submitted").order("submitted_at", { ascending: false }).limit(500), "intake_forms"),
        section(admin().from("clients").select("id, " + F.clientMetrics).eq("tenant_id", ctx.tenantId).in("id", ids), "profile_metrics"),
      ]);
      if (!intakesS.ok) throw new ToolError(intakesS.unavailable);
      const latest = new Map<string, any>();
      for (const r of intakesS.value as any[]) if (!latest.has(r.client_id)) latest.set(r.client_id, r);
      const metrics = new Map<string, any>();
      for (const m of sectionRows(metricsS as Section<any[]>)) metrics.set(m.id, m);

      const rows = clients.map((c) => {
        const intake = latest.get(c.id) ?? null;
        if (!intake) {
          return {
            client_id: c.id, display_name: c.display_name, status: c.status,
            compliance_state: "no_intake",
            parq: { answered: 0, total: 8, complete: false, flagged: [], unanswered: null },
            waiver: { state: "not_signed", signed_at: null },
            intake: null,
            blockers: ["No intake has ever been submitted — the health screen and waiver were never asked for."],
          };
        }
        const parq = parqView(intake.answers);
        const waiver = waiverView(intake.answers);
        const completeness = intakeCompleteness(intake.answers, metrics.get(c.id) ?? null);
        const blockers: string[] = [];
        if (!parq.complete) blockers.push(`PAR-Q incomplete — unanswered: ${parq.unanswered.join(", ")}`);
        if (parq.flagged.length) blockers.push(`PAR-Q flagged: ${parq.flagged.join(", ")}`);
        if (parq.medications_state === "disclosed") blockers.push("Medications disclosed — review before programming");
        if (waiver.state !== "signed") blockers.push("Waiver not signed");
        // A health-screen-only submission (intake_kind "screen", from /screen) is the PAR-Q and
        // waiver for a client who is already programmed. Missing programming answers are a
        // note on that row, not a compliance blocker — the screen never asked for them.
        const screenOnly = intake.answers?.intake_kind === "screen";
        const notes: string[] = [];
        const gap = (line: string) => (screenOnly ? notes : blockers).push(line);
        if (completeness.missing_programming.length) gap(`Intake missing: ${completeness.missing_programming.join(", ")}`);
        if (completeness.missing_body_metrics.length) gap(`Body metrics missing: ${completeness.missing_body_metrics.join(", ")}`);
        const state = !parq.complete ? "incomplete" : parq.flagged.length ? "flagged" : blockers.length ? "incomplete" : "clear";
        return {
          client_id: c.id, display_name: c.display_name, status: c.status,
          compliance_state: state,
          parq: { answered: parq.answered, total: parq.total, complete: parq.complete, flagged: parq.flagged, unanswered: parq.unanswered, medications_state: parq.medications_state },
          waiver: { state: waiver.state, version: waiver.version, signed_at: waiver.signed_at },
          intake: { submitted_at: intake.submitted_at, kind: screenOnly ? "screen" : "full", programmable: completeness.programmable, missing: completeness },
          blockers,
          ...(notes.length ? { notes } : {}),
        };
      });
      const totals: Record<string, number> = { clear: 0, flagged: 0, incomplete: 0, no_intake: 0 };
      for (const r of rows) totals[r.compliance_state] = (totals[r.compliance_state] ?? 0) + 1;
      return {
        totals,
        clients: rows,
        profile_metrics_unavailable: metricsS.ok ? null : (metricsS as { unavailable: string }).unavailable,
      };
    },
  },
  {
    name: "get_roster_state",
    description:
      "The whole roster (or a filtered slice) in one call: profile, active program, nutrition plan, onboarding " +
      "state and engagement per client, instead of dozens of round-trips. Choose which blocks with `include`. " +
      "BILLING IS NOT INCLUDED — no billing data is exposed on this surface at all; the response names that " +
      "omission rather than leaving a silent hole. Capped at 200 clients; truncation is stated.",
    inputSchema: obj({
      status: { type: "string", enum: ["active", "paused", "invited", "all"] },
      client_ids: { type: "array", items: S.id, minItems: 1, maxItems: 200 },
      include: {
        type: "array", maxItems: 6,
        items: { type: "string", enum: ["profile", "program", "nutrition", "onboarding", "engagement"] },
      },
      window_days: { type: "integer", minimum: 1, maximum: 365 },
    }),
    run: async (ctx, a) => {
      const ROSTER_CAP = 200;
      const include = new Set<string>(Array.isArray(a?.include) && a.include.length
        ? a.include
        : ["profile", "program", "nutrition", "onboarding", "engagement"]);
      const windowDays = a?.window_days ?? 30;
      const since = new Date(Date.now() - windowDays * 86400000).toISOString();

      let clientQ = sel(ctx, "clients", F.client).order("display_name");
      if (Array.isArray(a?.client_ids) && a.client_ids.length) clientQ = clientQ.in("id", a.client_ids);
      else if ((a?.status ?? "active") !== "all") clientQ = clientQ.eq("status", a?.status ?? "active");
      const all = await must(clientQ, "get_roster_state.clients") as any[];
      const clients = all.slice(0, ROSTER_CAP);
      if (!clients.length) return { clients: [], count: 0, not_included: NOT_INCLUDED };
      const ids = clients.map((c) => c.id);

      const wantProgram = include.has("program") || include.has("engagement");
      const [metricsS, assignS, plansS, intakesS, onbS, factsS, sessS, checkS, msgS] = await Promise.all([
        include.has("profile")
          ? section(admin().from("clients").select("id, " + F.clientMetrics).eq("tenant_id", ctx.tenantId).in("id", ids), "profile_metrics")
          : Promise.resolve(sectionOk([] as any[])),
        wantProgram
          ? section(sel(ctx, "assignments", "client_id, program_id, active, current_day_index, assigned_at").eq("active", true).in("client_id", ids), "assignments")
          : Promise.resolve(sectionOk([] as any[])),
        include.has("nutrition") || include.has("engagement")
          ? section(sel(ctx, "client_meal_plans", "id, client_id, title, status, target_calories, target_protein_g, target_fat_g, target_carb_g, assigned_at, updated_at").in("client_id", ids).limit(1000), "client_meal_plans")
          : Promise.resolve(sectionOk([] as any[])),
        include.has("onboarding")
          ? section(sel(ctx, "intake_forms", "client_id, answers, status, submitted_at").in("client_id", ids).eq("status", "submitted").order("submitted_at", { ascending: false }).limit(500), "intake_forms")
          : Promise.resolve(sectionOk([] as any[])),
        include.has("onboarding")
          ? section(sel(ctx, "client_onboarding", "client_id, stage, account_state, blockers, released_at").in("client_id", ids).limit(500), "client_onboarding")
          : Promise.resolve(sectionOk([] as any[])),
        include.has("onboarding")
          ? section(admin().rpc("client_onboarding_facts", { p_tenant_id: ctx.tenantId }), "onboarding_facts")
          : Promise.resolve(sectionOk([] as any[])),
        include.has("engagement")
          ? section(sel(ctx, "workout_sessions", "client_id, session_date").gte("session_date", since.slice(0, 10)).in("client_id", ids).limit(5000), "workout_sessions_in_window")
          : Promise.resolve(sectionOk([] as any[])),
        include.has("engagement")
          ? section(sel(ctx, "checkins", "client_id, submitted_at").order("submitted_at", { ascending: false }).in("client_id", ids).limit(1000), "checkins")
          : Promise.resolve(sectionOk([] as any[])),
        include.has("engagement")
          ? section(sel(ctx, "messages", "client_id, sender_role, sent_at, read_at").order("sent_at", { ascending: false }).in("client_id", ids).limit(2000), "messages")
          : Promise.resolve(sectionOk([] as any[])),
      ]);

      const programIds = [...new Set(sectionRows(assignS as Section<any[]>).map((r) => r.program_id).filter(Boolean))];
      const programs = new Map<string, any>();
      if (programIds.length) {
        const { data } = await sel(ctx, "programs", F.programList).in("id", programIds);
        for (const p of (data ?? []) as any[]) programs.set(p.id, p);
      }
      const scan = include.has("engagement") ? await lastSessionDates(ctx, ids) : { byClient: new Map<string, string>(), complete: true, reason: null };

      const metrics = new Map(sectionRows(metricsS as Section<any[]>).map((m) => [m.id, m]));
      const assignByClient = new Map(sectionRows(assignS as Section<any[]>).map((r) => [r.client_id, r]));
      const plansByClient = new Map<string, any>();
      for (const p of sectionRows(plansS as Section<any[]>)) {
        const cur = plansByClient.get(p.client_id);
        if (!cur || (p.status === "assigned" && cur.status !== "assigned")) plansByClient.set(p.client_id, p);
      }
      const intakeByClient = new Map<string, any>();
      for (const r of sectionRows(intakesS as Section<any[]>)) if (!intakeByClient.has(r.client_id)) intakeByClient.set(r.client_id, r);
      const onbByClient = new Map(sectionRows(onbS as Section<any[]>).map((r) => [r.client_id, r]));
      const factsByClient = new Map(sectionRows(factsS as Section<any[]>).map((r) => [r.client_id, r]));
      const sessionsInWindow = new Map<string, number>();
      for (const r of sectionRows(sessS as Section<any[]>)) sessionsInWindow.set(r.client_id, (sessionsInWindow.get(r.client_id) ?? 0) + 1);
      const lastCheckin = new Map<string, string>(), checkinsInWindow = new Map<string, number>();
      for (const r of sectionRows(checkS as Section<any[]>)) {
        if (!lastCheckin.has(r.client_id)) lastCheckin.set(r.client_id, r.submitted_at);
        if (r.submitted_at >= since) checkinsInWindow.set(r.client_id, (checkinsInWindow.get(r.client_id) ?? 0) + 1);
      }
      const lastIn = new Map<string, string>(), lastOut = new Map<string, string>(), unread = new Map<string, number>();
      for (const r of sectionRows(msgS as Section<any[]>)) {
        if (r.sender_role === "client") {
          if (!lastIn.has(r.client_id)) lastIn.set(r.client_id, r.sent_at);
          if (r.read_at == null) unread.set(r.client_id, (unread.get(r.client_id) ?? 0) + 1);
        } else if (!lastOut.has(r.client_id)) lastOut.set(r.client_id, r.sent_at);
      }

      const rows = clients.map((c) => {
        const out: Record<string, unknown> = { client_id: c.id, display_name: c.display_name, status: c.status, coaching_tier: c.coaching_tier };
        if (include.has("profile")) out.profile = { ...c, ...(metrics.get(c.id) ?? {}) };
        if (include.has("program")) {
          const asg = assignByClient.get(c.id);
          const p = asg ? programs.get(asg.program_id) : null;
          out.program = asg
            ? { assignment_id: asg.id, program_id: asg.program_id, name: p?.name ?? null, program_state: p ? "in_library" : "deleted_from_library", assigned_at: asg.assigned_at, current_day_index: asg.current_day_index, ...(p ? structureSummary(p.structure) : {}) }
            : null;
        }
        if (include.has("nutrition")) out.nutrition = plansByClient.get(c.id) ?? null;
        if (include.has("onboarding")) {
          const intake = intakeByClient.get(c.id) ?? null;
          out.onboarding = {
            intake_state: intake ? "submitted" : "no_intake_submitted",
            submitted_at: intake?.submitted_at ?? null,
            parq: intake ? { answered: parqView(intake.answers).answered, total: 8, complete: parqView(intake.answers).complete, flagged: parqView(intake.answers).flagged } : null,
            waiver_state: intake ? waiverView(intake.answers).state : "not_signed",
            missing: intake ? intakeCompleteness(intake.answers, metrics.get(c.id) ?? null) : null,
            pipeline: onbByClient.get(c.id) ?? null,
            // Slice 1 status view: next_action by fixed precedence + the facts it rests on.
            // A failed facts read is reported in unavailable_sections, not as null-means-fine.
            facts: factsS.ok ? (factsByClient.get(c.id) ?? null) : renderSection(factsS),
          };
        }
        if (include.has("engagement")) {
          const row = segmentEngagement({
            client_id: c.id, display_name: c.display_name, status: c.status, coaching_tier: c.coaching_tier,
            has_active_program: assignByClient.has(c.id),
            has_nutrition_plan: plansByClient.get(c.id)?.status === "assigned",
            last_session_date: scan.byClient.get(c.id) ?? null,
            sessions_in_window: sessionsInWindow.get(c.id) ?? 0,
            last_checkin_at: lastCheckin.get(c.id) ?? null,
            checkins_in_window: checkinsInWindow.get(c.id) ?? 0,
            last_client_message_at: lastIn.get(c.id) ?? null,
            unread_messages: unread.get(c.id) ?? 0,
            last_coach_message_at: lastOut.get(c.id) ?? null,
          }, { windowDays });
          out.engagement = !scan.complete && row.last_session_date == null && row.segment === "never_started"
            ? { ...row, segment: "not_tracked", segment_reason: "Training history scan was truncated before reaching this client — their real state is unknown, not zero." }
            : row;
        }
        return out;
      });

      const gaps = unavailableSections({
        profile_metrics: metricsS, assignments: assignS, client_meal_plans: plansS,
        intake_forms: intakesS, client_onboarding: onbS, onboarding_facts: factsS,
        workout_sessions_in_window: sessS, checkins: checkS, messages: msgS,
      });
      return {
        count: rows.length,
        total_matched: all.length,
        truncated: all.length > ROSTER_CAP,
        included_blocks: [...include],
        window_days: windowDays,
        session_scan_complete: scan.complete,
        session_scan_note: scan.reason,
        // Stated, not silently absent. A roster view that quietly omits billing reads complete.
        not_included: NOT_INCLUDED,
        clients: rows,
        unavailable_sections: gaps.length ? gaps : null,
      };
    },
  },
  {
    name: "list_community_posts",
    description:
      "The tenant's community feed, newest first (pinned first if pin_first is set), each with its comment and " +
      "reaction counts. Posts are authored by the coach's business — this schema has no client-authored posts; " +
      "clients participate through comments and reactions.",
    inputSchema: obj({ limit: S.limit, pin_first: { type: "boolean" } }),
    run: async (ctx, a) => {
      const posts = await must(
        sel(ctx, "community_posts", F.communityPost)
          .order("pinned", { ascending: false }).order("created_at", { ascending: false })
          .limit(a?.limit ?? 25),
        "list_community_posts",
      ) as any[];
      if (!posts.length) return { posts: [], note: "This workspace has no community posts yet." };
      const ids = posts.map((p) => p.id);
      const [commentsS, reactionsS] = await Promise.all([
        section(sel(ctx, "community_comments", "post_id").in("post_id", ids).limit(5000), "comments"),
        section(sel(ctx, "community_reactions", "post_id").in("post_id", ids).limit(5000), "reactions"),
      ]);
      const tally = (rows: any[]) => {
        const m = new Map<string, number>();
        for (const r of rows) m.set(r.post_id, (m.get(r.post_id) ?? 0) + 1);
        return m;
      };
      const c = tally(sectionRows(commentsS as Section<any[]>)), r = tally(sectionRows(reactionsS as Section<any[]>));
      return {
        posts: posts.map((p) => ({
          ...p,
          comments: commentsS.ok ? (c.get(p.id) ?? 0) : null,
          reactions: reactionsS.ok ? (r.get(p.id) ?? 0) : null,
        })),
        unavailable_sections: unavailableSections({ comments: commentsS, reactions: reactionsS }).length
          ? unavailableSections({ comments: commentsS, reactions: reactionsS })
          : null,
      };
    },
  },
  {
    name: "get_community_post",
    description: "One community post in full with every comment (oldest first, with the commenting client's name) and who reacted.",
    inputSchema: obj({ post_id: S.id }, ["post_id"]),
    run: async (ctx, a) => {
      const { data: post } = await sel(ctx, "community_posts", F.communityPost).eq("id", a.post_id).maybeSingle() as { data: any };
      if (!post) throw notFound("community post");
      const [commentsS, reactionsS] = await Promise.all([
        section(sel(ctx, "community_comments", "id, author_role, client_id, body, created_at")
          .eq("post_id", a.post_id).order("created_at", { ascending: true }).limit(500), "comments"),
        section(sel(ctx, "community_reactions", "client_id, created_at").eq("post_id", a.post_id).limit(500), "reactions"),
      ]);
      const comments = sectionRows(commentsS as Section<any[]>);
      const reactions = sectionRows(reactionsS as Section<any[]>);
      const clientIds = [...new Set([...comments, ...reactions].map((r) => r.client_id).filter(Boolean))];
      const names = new Map<string, string>();
      if (clientIds.length) {
        const { data } = await sel(ctx, "clients", "id, display_name").in("id", clientIds);
        for (const c of (data ?? []) as any[]) names.set(c.id, c.display_name);
      }
      return {
        post,
        comments: commentsS.ok
          ? comments.map((c) => ({ ...c, display_name: c.client_id ? (names.get(c.client_id) ?? null) : null }))
          : renderSection(commentsS),
        reactions: reactionsS.ok
          ? reactions.map((r) => ({ client_id: r.client_id, display_name: names.get(r.client_id) ?? null, created_at: r.created_at }))
          : renderSection(reactionsS),
      };
    },
  },
  {
    name: "get_community_engagement",
    description:
      "Who is active and who is dormant in the community, per client — comments, reactions and last activity " +
      "across a window. community_state is active, quiet (they are on the roster and have posted nothing in the " +
      "window) or never_participated. If this workspace has no community posts at all, that is reported as the " +
      "system having nothing to participate IN — never as clients being disengaged.",
    inputSchema: obj({ window_days: { type: "integer", minimum: 1, maximum: 365 }, status: { type: "string", enum: ["active", "all"] } }),
    run: async (ctx, a) => {
      const windowDays = a?.window_days ?? 30;
      const since = new Date(Date.now() - windowDays * 86400000).toISOString();
      let clientQ = sel(ctx, "clients", "id, display_name, status, coaching_tier").order("display_name");
      if ((a?.status ?? "active") === "active") clientQ = clientQ.eq("status", "active");
      const [clients, postsS, commentsS, reactionsS] = await Promise.all([
        must(clientQ, "get_community_engagement.clients") as Promise<any[]>,
        section(sel(ctx, "community_posts", "id, created_at").limit(1000), "community_posts"),
        section(sel(ctx, "community_comments", "client_id, created_at").order("created_at", { ascending: false }).limit(5000), "comments"),
        section(sel(ctx, "community_reactions", "client_id, created_at").order("created_at", { ascending: false }).limit(5000), "reactions"),
      ]);
      const posts = sectionRows(postsS as Section<any[]>);
      if (postsS.ok && posts.length === 0) {
        return {
          community_state: "no_posts_exist",
          message: "This workspace has never posted to community. Nobody has anything to engage with, so there " +
            "is no client engagement to measure here — that is a gap in what has been published, not client behaviour.",
          window_days: windowDays, clients: [],
        };
      }
      const roll = (rows: any[]) => {
        const m = new Map<string, { total: number; inWindow: number; last: string | null }>();
        for (const r of rows) {
          if (!r.client_id) continue;
          const cur = m.get(r.client_id) ?? { total: 0, inWindow: 0, last: null };
          cur.total += 1;
          if (r.created_at >= since) cur.inWindow += 1;
          if (!cur.last || r.created_at > cur.last) cur.last = r.created_at;
          m.set(r.client_id, cur);
        }
        return m;
      };
      const cm = roll(sectionRows(commentsS as Section<any[]>)), rc = roll(sectionRows(reactionsS as Section<any[]>));
      const rows = clients.map((c) => {
        const a1 = cm.get(c.id), a2 = rc.get(c.id);
        const last = [a1?.last, a2?.last].filter(Boolean).sort().pop() ?? null;
        const inWindow = (a1?.inWindow ?? 0) + (a2?.inWindow ?? 0);
        const ever = (a1?.total ?? 0) + (a2?.total ?? 0);
        return {
          client_id: c.id, display_name: c.display_name, coaching_tier: c.coaching_tier,
          comments_total: a1?.total ?? 0, comments_in_window: a1?.inWindow ?? 0,
          reactions_total: a2?.total ?? 0, reactions_in_window: a2?.inWindow ?? 0,
          last_activity_at: last,
          community_state: ever === 0 ? "never_participated" : (inWindow > 0 ? "active" : "quiet"),
        };
      });
      return {
        community_state: "ok",
        window_days: windowDays,
        posts_in_feed: postsS.ok ? posts.length : null,
        totals: {
          active: rows.filter((r) => r.community_state === "active").length,
          quiet: rows.filter((r) => r.community_state === "quiet").length,
          never_participated: rows.filter((r) => r.community_state === "never_participated").length,
        },
        clients: rows,
        unavailable_sections: unavailableSections({ community_posts: postsS, comments: commentsS, reactions: reactionsS }).length
          ? unavailableSections({ community_posts: postsS, comments: commentsS, reactions: reactionsS })
          : null,
      };
    },
  },
  {
    name: "get_client_program_history",
    description:
      "Every program this client has ever been assigned, newest first — not just the current one. Each entry " +
      "carries when it was assigned, whether it is the active cycle, how many sessions were logged against it, " +
      "and when the last one was. A program that has since been deleted from the library is still listed, " +
      "marked as such, rather than vanishing from their history.",
    inputSchema: obj({ client_id: S.id, limit: S.limit }, ["client_id"]),
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const assigns = await must(
        sel(ctx, "assignments", "id, program_id, assigned_at, active, current_day_index, block_weeks, ends_on")
          .eq("client_id", a.client_id).order("assigned_at", { ascending: false }).limit(a?.limit ?? 50),
        "get_client_program_history",
      ) as any[];
      if (!assigns.length) {
        return { client_id: a.client_id, history: [], note: "This client has never been assigned a program." };
      }
      const programIds = [...new Set(assigns.map((r) => r.program_id).filter(Boolean))];
      const [progS, sessS] = await Promise.all([
        section(sel(ctx, "programs", F.programList).in("id", programIds), "programs"),
        section(sel(ctx, "workout_sessions", "assignment_id, session_date, status")
          .eq("client_id", a.client_id).order("session_date", { ascending: false }).limit(1000), "workout_sessions"),
      ]);
      const byProgram = new Map(sectionRows(progS as Section<any[]>).map((p) => [p.id, p]));
      const stats = new Map<string, { total: number; complete: number; last: string | null }>();
      for (const s of sectionRows(sessS as Section<any[]>)) {
        const cur = stats.get(s.assignment_id) ?? { total: 0, complete: 0, last: null };
        cur.total += 1;
        if (s.status === "complete") cur.complete += 1;
        if (s.session_date && (!cur.last || s.session_date > cur.last)) cur.last = s.session_date;
        stats.set(s.assignment_id, cur);
      }
      return {
        client_id: a.client_id,
        history: assigns.map((r) => {
          const p = byProgram.get(r.program_id);
          const st = stats.get(r.id) ?? { total: 0, complete: 0, last: null };
          return {
            assignment_id: r.id,
            program_id: r.program_id,
            program_name: p?.name ?? null,
            program_state: p ? "in_library" : "deleted_from_library",
            origin: p ? (p.source_draft_id ? "ai_generated" : "hand_built") : null,
            assigned_at: r.assigned_at,
            active: r.active,
            current_day_index: r.active ? r.current_day_index : null,
            block_weeks: r.block_weeks, ends_on: r.ends_on,
            sessions_logged: st.total,
            sessions_completed: st.complete,
            last_session_date: st.last,
          };
        }),
        unavailable_sections: unavailableSections({ programs: progS, workout_sessions: sessS }).length
          ? unavailableSections({ programs: progS, workout_sessions: sessS })
          : null,
      };
    },
  },
  {
    name: "get_client_activity_log",
    description:
      "One unified timeline for a client, newest first, merged from every surface: workouts, check-ins, weights, " +
      "photos, messages both directions, coach notes, program assignments, nutrition plans, generated drafts, " +
      "intake submissions and challenge runs. Use this instead of stacking half a dozen other calls to " +
      "reconstruct what has happened. The `sources` block names every source that was queried and whether it " +
      "succeeded — a source that failed is reported, never dropped, because a timeline missing its messages " +
      "reads as a client who never wrote to you.",
    inputSchema: obj({
      client_id: S.id,
      since: { type: "string", description: "ISO date/timestamp; only events at or after this are returned" },
      limit: { type: "integer", minimum: 1, maximum: 500 },
      kinds: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 20, description: "Filter to these event kinds" },
    }, ["client_id"]),
    run: async (ctx, a) => {
      const client = await ownedClient(ctx, a.client_id) as any;
      const cid = a.client_id;
      const [sessions, logs, checkins, weights, photos, messages, notes, assigns, plans, drafts, intakes, runs] =
        await Promise.all([
          section(sel(ctx, "workout_sessions", "id, day_id, session_date, status, completed_at").eq("client_id", cid)
            .order("session_date", { ascending: false }).limit(200), "workout_sessions"),
          section(sel(ctx, "workout_logs", "session_id, logged_at, weight, reps, done").eq("client_id", cid)
            .order("logged_at", { ascending: false }).limit(500), "workout_logs"),
          section(sel(ctx, "checkins", "id, submitted_at, weight, coach_seen").eq("client_id", cid)
            .order("submitted_at", { ascending: false }).limit(100), "checkins"),
          section(sel(ctx, "progress_weights", "date, weight").eq("client_id", cid)
            .order("date", { ascending: false }).limit(200), "progress_weights"),
          section(sel(ctx, "progress_photos", "id, taken_at, pose_tag").eq("client_id", cid)
            .order("taken_at", { ascending: false }).limit(100), "progress_photos"),
          section(sel(ctx, "messages", "id, sender_role, body, sent_at, read_at").eq("client_id", cid)
            .order("sent_at", { ascending: false }).limit(200), "messages"),
          section(sel(ctx, "client_notes", "id, body, created_at").eq("client_id", cid)
            .order("created_at", { ascending: false }).limit(100), "client_notes"),
          section(sel(ctx, "assignments", "id, program_id, assigned_at, active").eq("client_id", cid)
            .order("assigned_at", { ascending: false }).limit(50), "assignments"),
          section(sel(ctx, "client_meal_plans", "id, title, status, created_at, assigned_at").eq("client_id", cid)
            .order("created_at", { ascending: false }).limit(50), "client_meal_plans"),
          section(sel(ctx, "program_drafts", "id, status, generated_at, decided_at").eq("client_id", cid)
            .order("generated_at", { ascending: false }).limit(50), "program_drafts"),
          section(sel(ctx, "intake_forms", "id, status, submitted_at, created_at").eq("client_id", cid)
            .order("created_at", { ascending: false }).limit(20), "intake_forms"),
          section(sel(ctx, "challenge_runs", "id, challenge_id, status, started_at, completed_at").eq("client_id", cid)
            .order("created_at", { ascending: false }).limit(50), "challenge_runs"),
        ]);

      // Program names for assignment events — one bulk read, not one per row.
      const programIds = [...new Set(sectionRows(assigns as Section<any[]>).map((r) => r.program_id).filter(Boolean))];
      const programNames = new Map<string, string>();
      if (programIds.length) {
        const { data } = await sel(ctx, "programs", "id, name").in("id", programIds);
        for (const p of (data ?? []) as any[]) programNames.set(p.id, p.name);
      }

      const events: ActivityEvent[] = [];
      const sessionById = new Map<string, any>();
      for (const s of sectionRows(sessions as Section<any[]>)) {
        sessionById.set(s.id, s);
        if (s.completed_at) {
          events.push({ at: s.completed_at, kind: "session_complete", summary: "Completed a training session", ref: { session_id: s.id } });
        } else if (s.session_date) {
          events.push({ at: `${s.session_date}T00:00:00Z`, kind: "session_started", summary: "Started a training session (not marked complete)", ref: { session_id: s.id } });
        }
      }
      // Sets rolled up per session — a timeline of 400 individual set rows is noise, not history.
      const setsBySession = new Map<string, { n: number; done: number; at: string }>();
      for (const l of sectionRows(logs as Section<any[]>)) {
        const cur = setsBySession.get(l.session_id) ?? { n: 0, done: 0, at: l.logged_at };
        cur.n += 1;
        if (l.done) cur.done += 1;
        if (l.logged_at && l.logged_at > cur.at) cur.at = l.logged_at;
        setsBySession.set(l.session_id, cur);
      }
      for (const [sid, agg] of setsBySession) {
        events.push({ at: agg.at, kind: "sets_logged", summary: `Logged ${agg.n} set(s), ${agg.done} marked done`, ref: { session_id: sid, day_id: sessionById.get(sid)?.day_id ?? null } });
      }
      for (const c of sectionRows(checkins as Section<any[]>)) {
        events.push({ at: c.submitted_at, kind: "checkin_submitted", summary: c.weight == null ? "Submitted a check-in (no weight given)" : `Submitted a check-in — ${c.weight}`, ref: { checkin_id: c.id, coach_seen: c.coach_seen } });
      }
      for (const w of sectionRows(weights as Section<any[]>)) {
        events.push({ at: `${w.date}T00:00:00Z`, kind: "weight_logged", summary: `Weight logged: ${w.weight}`, ref: {} });
      }
      for (const p of sectionRows(photos as Section<any[]>)) {
        events.push({ at: p.taken_at, kind: "photo_added", summary: `Progress photo added${p.pose_tag ? ` (${p.pose_tag})` : ""}`, ref: { photo_id: p.id } });
      }
      for (const m of sectionRows(messages as Section<any[]>)) {
        const inbound = m.sender_role === "client";
        events.push({
          at: m.sent_at,
          kind: inbound ? "message_in" : "message_out",
          summary: `${inbound ? "Client wrote" : "Coach wrote"}: ${String(m.body ?? "").slice(0, 200)}`,
          ref: { message_id: m.id, unread: inbound ? m.read_at == null : undefined },
        });
      }
      for (const n of sectionRows(notes as Section<any[]>)) {
        events.push({ at: n.created_at, kind: "note_added", summary: `Coach note: ${String(n.body ?? "").slice(0, 200)}`, ref: { note_id: n.id } });
      }
      for (const s of sectionRows(assigns as Section<any[]>)) {
        events.push({ at: s.assigned_at, kind: "program_assigned", summary: `Assigned program: ${programNames.get(s.program_id) ?? "(program no longer in the library)"}${s.active ? " (current)" : ""}`, ref: { assignment_id: s.id, program_id: s.program_id } });
      }
      for (const p of sectionRows(plans as Section<any[]>)) {
        events.push({ at: p.created_at, kind: "nutrition_plan_drafted", summary: `Nutrition plan drafted: ${p.title ?? "(untitled)"}`, ref: { plan_id: p.id, status: p.status } });
        if (p.assigned_at) events.push({ at: p.assigned_at, kind: "nutrition_plan_assigned", summary: `Nutrition plan released to the client: ${p.title ?? "(untitled)"}`, ref: { plan_id: p.id } });
      }
      for (const d of sectionRows(drafts as Section<any[]>)) {
        events.push({ at: d.generated_at, kind: "program_draft_generated", summary: `Program draft generated (${d.status})`, ref: { draft_id: d.id } });
        if (d.decided_at) events.push({ at: d.decided_at, kind: "program_draft_decided", summary: `Program draft ${d.status}`, ref: { draft_id: d.id } });
      }
      for (const i of sectionRows(intakes as Section<any[]>)) {
        if (i.submitted_at) events.push({ at: i.submitted_at, kind: "intake_submitted", summary: "Intake submitted", ref: { intake_id: i.id } });
        else events.push({ at: i.created_at, kind: "intake_sent", summary: "Intake form sent (not yet returned)", ref: { intake_id: i.id } });
      }
      for (const r of sectionRows(runs as Section<any[]>)) {
        if (r.started_at) events.push({ at: r.started_at, kind: "challenge_started", summary: `Challenge run started (${r.status})`, ref: { run_id: r.id, challenge_id: r.challenge_id } });
        if (r.completed_at) events.push({ at: r.completed_at, kind: "challenge_completed", summary: `Challenge run completed (${r.status})`, ref: { run_id: r.id } });
      }

      const kinds: string[] | null = Array.isArray(a?.kinds) && a.kinds.length ? a.kinds : null;
      const filtered = kinds ? events.filter((e) => kinds.includes(e.kind)) : events;
      const merged = mergeActivityLog(filtered, { limit: a?.limit ?? 100, since: a?.since ?? null });

      const sourceSections: Record<string, Section<unknown>> = {
        workout_sessions: sessions, workout_logs: logs, checkins, progress_weights: weights,
        progress_photos: photos, messages, client_notes: notes, assignments: assigns,
        client_meal_plans: plans, program_drafts: drafts, intake_forms: intakes, challenge_runs: runs,
      };
      const failedSources = unavailableSections(sourceSections);
      return {
        client: { id: client.id, display_name: client.display_name, status: client.status },
        window: { since: a?.since ?? null, limit: a?.limit ?? 100 },
        event_count: merged.total,
        truncated: merged.truncated,
        undated_events_skipped: merged.undated,
        events: merged.events,
        // Named, per source, so a partial timeline can never be mistaken for a quiet client.
        sources: Object.entries(sourceSections).map(([name, s]) =>
          s.ok ? { source: name, status: "ok" } : { source: name, status: "unavailable", reason: (s as { unavailable: string }).unavailable }),
        complete: failedSources.length === 0,
        unavailable_sources: failedSources.length ? failedSources : null,
      };
    },
  },
  {
    name: "get_engagement_report",
    description:
      "Roster-wide engagement in one call: per client, last training date, sessions and check-ins in the window, " +
      "last inbound/outbound message, unread count, and whether they even have a program and a nutrition plan. " +
      "Segments each client engaged / slipping / dormant / never_started / not_tracked. `not_tracked` means the " +
      "client has NO active program — nothing was ever asked of them, so a low score would be the system's gap " +
      "wearing their name; `never_started` means they DO have a program and have done nothing, which is a real " +
      "zero. Each row lists `excluded_signals` — anything that was not measurable for that client is stated, " +
      "never quietly averaged in.",
    inputSchema: obj({
      window_days: { type: "integer", minimum: 1, maximum: 365 },
      status: { type: "string", enum: ["active", "all"] },
      slipping_after_days: { type: "integer", minimum: 1, maximum: 90 },
      dormant_after_days: { type: "integer", minimum: 2, maximum: 365 },
    }),
    run: async (ctx, a) => {
      const windowDays = a?.window_days ?? 30;
      const slippingAfter = a?.slipping_after_days ?? 7;
      const dormantAfter = a?.dormant_after_days ?? 21;
      if (dormantAfter <= slippingAfter) {
        throw new ToolError(`dormant_after_days (${dormantAfter}) must be greater than slipping_after_days (${slippingAfter})`);
      }
      const since = new Date(Date.now() - windowDays * 86400000).toISOString();
      const sinceDate = since.slice(0, 10);

      let clientQ = sel(ctx, "clients", F.client).order("display_name");
      if ((a?.status ?? "active") === "active") clientQ = clientQ.eq("status", "active");
      const clients = (await must(clientQ, "get_engagement_report.clients")) as any[];
      if (!clients.length) return { window_days: windowDays, clients: [], totals: {}, note: "No clients matched." };

      const ids = clients.map((c) => c.id);
      const [assignS, sessionsS, checkinsS, msgS, plansS] = await Promise.all([
        section(sel(ctx, "assignments", "client_id").eq("active", true).in("client_id", ids), "assignments"),
        section(sel(ctx, "workout_sessions", "client_id, session_date").gte("session_date", sinceDate).in("client_id", ids), "workout_sessions_in_window"),
        section(sel(ctx, "checkins", "client_id, submitted_at").order("submitted_at", { ascending: false }).in("client_id", ids).limit(1000), "checkins"),
        section(sel(ctx, "messages", "client_id, sender_role, sent_at, read_at").order("sent_at", { ascending: false }).in("client_id", ids).limit(2000), "messages"),
        section(sel(ctx, "client_meal_plans", "client_id, status").eq("status", "assigned").in("client_id", ids), "client_meal_plans"),
      ]);
      const scan = await lastSessionDates(ctx, ids);

      const withProgram = new Set(sectionRows(assignS as Section<any[]>).map((r) => r.client_id));
      const withPlan = new Set(sectionRows(plansS as Section<any[]>).map((r) => r.client_id));
      const sessionsInWindow = new Map<string, number>();
      for (const r of sectionRows(sessionsS as Section<any[]>)) {
        sessionsInWindow.set(r.client_id, (sessionsInWindow.get(r.client_id) ?? 0) + 1);
      }
      const lastCheckin = new Map<string, string>();
      const checkinsInWindow = new Map<string, number>();
      for (const r of sectionRows(checkinsS as Section<any[]>)) {
        if (!lastCheckin.has(r.client_id)) lastCheckin.set(r.client_id, r.submitted_at);
        if (r.submitted_at >= since) checkinsInWindow.set(r.client_id, (checkinsInWindow.get(r.client_id) ?? 0) + 1);
      }
      const lastIn = new Map<string, string>(), lastOut = new Map<string, string>(), unread = new Map<string, number>();
      for (const r of sectionRows(msgS as Section<any[]>)) {
        if (r.sender_role === "client") {
          if (!lastIn.has(r.client_id)) lastIn.set(r.client_id, r.sent_at);
          if (r.read_at == null) unread.set(r.client_id, (unread.get(r.client_id) ?? 0) + 1);
        } else if (!lastOut.has(r.client_id)) lastOut.set(r.client_id, r.sent_at);
      }

      const rows = clients.map((c) => {
        const signals: EngagementSignals = {
          client_id: c.id,
          display_name: c.display_name,
          status: c.status,
          coaching_tier: c.coaching_tier,
          has_active_program: withProgram.has(c.id),
          has_nutrition_plan: withPlan.has(c.id),
          last_session_date: scan.byClient.get(c.id) ?? null,
          sessions_in_window: sessionsInWindow.get(c.id) ?? 0,
          last_checkin_at: lastCheckin.get(c.id) ?? null,
          checkins_in_window: checkinsInWindow.get(c.id) ?? 0,
          last_client_message_at: lastIn.get(c.id) ?? null,
          unread_messages: unread.get(c.id) ?? 0,
          last_coach_message_at: lastOut.get(c.id) ?? null,
        };
        const row = segmentEngagement(signals, { windowDays, slippingAfterDays: slippingAfter, dormantAfterDays: dormantAfter });
        // A truncated history scan must not let a real "stale" client read as "never started".
        if (!scan.complete && row.last_session_date == null && row.segment === "never_started") {
          return { ...row, segment: "not_tracked" as const, segment_reason: "Training history scan was truncated before reaching this client — their real state is unknown, not zero." };
        }
        return row;
      });

      const gaps = unavailableSections({ assignments: assignS, workout_sessions_in_window: sessionsS, checkins: checkinsS, messages: msgS, client_meal_plans: plansS });
      return {
        window_days: windowDays,
        thresholds: { slipping_after_days: slippingAfter, dormant_after_days: dormantAfter },
        totals: summariseEngagement(rows as any),
        session_scan_complete: scan.complete,
        session_scan_note: scan.reason,
        clients: rows,
        unavailable_sections: gaps.length ? gaps : null,
      };
    },
  },
  // ---- writes (scope=read_write) ----
  {
    name: "update_client_onboarding",
    description:
      "Key intake in on a client's behalf when they cannot self-serve the form (phone consult, in person). " +
      "Merges into the client's existing intake — passing three fields never erases the other five; pass an " +
      "explicit null to clear one. Refuses unknown values for goal / equipment / experience / days_per_week / " +
      "injuries rather than storing them, and refuses to write waiver or signature fields at all: the client " +
      "signs that themselves. PAR-Q answers must be true or false; omit a question that was not asked rather " +
      "than sending a placeholder. Intake does not write profile unless sync_profile is true; sync copies only " +
      "body-metric keys present in this call.",
    inputSchema: obj({
      client_id: S.id,
      answers: { type: "object", description: "Intake keys to set. goal|equipment|experience|days_per_week|injuries|allergies|medications|meals_per_day|cardio_regimen|competition_history|sex|age|height_cm|weight_kg|goal_weight_kg and the eight parq_* booleans." },
      sync_profile: { type: "boolean", description: "If true, also write the body-metric keys from this call onto clients.profile. Default false." },
    }, ["client_id", "answers"]),
    write: true,
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const incoming = a.answers as Record<string, unknown>;
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || !Object.keys(incoming).length) {
        throw new ToolError("answers must be a non-empty object of intake keys to set");
      }
      const invalid = validateIntakeAnswers(incoming);
      if (invalid) throw new ToolError(invalid);

      const existingRows = await must(
        sel(ctx, "intake_forms", "id, answers, health_flags").eq("client_id", a.client_id).eq("status", "submitted")
          .order("submitted_at", { ascending: false }).limit(1),
        "update_client_onboarding.read",
      );
      const existing = (existingRows as any[])[0] ?? null;
      const merged = mergeIntakeAnswers(existing?.answers ?? {}, incoming);
      const health_flags = computeHealthFlags(merged);
      const now = new Date().toISOString();

      let mode: "created" | "updated";
      let id: string;
      if (existing) {
        const { error } = await admin().from("intake_forms")
          .update({ answers: merged, health_flags })
          .eq("id", existing.id).eq("tenant_id", ctx.tenantId);
        if (error) throw new ToolError(error.message);
        mode = "updated";
        id = existing.id;
      } else {
        // intake_forms.token is a single-use client invite credential. A coach-keyed row still
        // needs one (NOT NULL), so it is minted already spent and already expired — it can
        // never be handed to anyone or used to persist a second draft.
        const { data, error } = await insTenant(ctx, "intake_forms", {
          client_id: a.client_id,
          token: `coachkeyed_${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, ""),
          status: "submitted",
          answers: merged,
          health_flags,
          submitted_at: now,
          expires_at: now,
          token_consumed_at: now,
        }).select("id").single();
        if (error) throw new ToolError(error.message);
        mode = "created";
        id = data.id;
      }

      const profilePatch = profileMetricsFromAnswers(incoming);
      let profile_sync: unknown = { status: "not_requested" };
      if (a.sync_profile === true) {
        if (!Object.keys(profilePatch).length) {
          profile_sync = { status: "skipped", detail: "sync_profile was true but this call contained no body-metric keys" };
        } else {
          const { error: profileErr } = await admin().from("clients").update(profilePatch)
            .eq("id", a.client_id).eq("tenant_id", ctx.tenantId);
          profile_sync = profileErr
            ? { status: "error", detail: profileErr.message }
            : { status: "updated", keys_set: Object.keys(profilePatch) };
        }
      }

      const { data: metrics } = await admin().from("clients").select(F.clientMetrics)
        .eq("id", a.client_id).eq("tenant_id", ctx.tenantId).maybeSingle();
      const completeness = intakeCompleteness(merged, metrics as any);
      return {
        mode,
        intake_id: id,
        keys_set: Object.keys(incoming),
        health_flags,
        missing: completeness,
        note: completeness.programmable
          ? "Intake is complete enough to generate a program."
          : "Still not programmable — see `missing`. These are facts about this person and cannot be defaulted.",
        profile_sync,
        profile_metrics: metrics ?? null,
      };
    },
  },
  {
    name: "update_client_profile_metrics",
    description:
      "Write body metrics on the clients profile row (sex, age, height_cm, weight_kg, goal_weight_kg, unit_pref). " +
      "This is the row get_client_onboarding.profile_metrics and get_roster_state profile read. " +
      "Pass only the fields you are changing. Explicit null clears a field. Does not touch intake, PAR-Q, waiver, " +
      "or check-in cadence. Age 14–90. Height 120–230 cm. Weight and goal weight 35–250 kg.",
    inputSchema: obj({
      client_id: S.id,
      sex: { type: ["string", "null"], enum: ["male", "female", null] },
      age: { type: ["integer", "null"], minimum: 14, maximum: 90 },
      height_cm: { type: ["number", "null"], minimum: 120, maximum: 230 },
      weight_kg: { type: ["number", "null"], minimum: 35, maximum: 250 },
      goal_weight_kg: { type: ["number", "null"], minimum: 35, maximum: 250 },
      unit_pref: { type: "string", enum: ["imperial", "metric"] },
    }, ["client_id"]),
    write: true,
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const patch: Record<string, unknown> = {};
      if ("sex" in a) patch.sex = a.sex ?? null;
      if ("age" in a) patch.age = a.age ?? null;
      if ("height_cm" in a) patch.height_cm = a.height_cm ?? null;
      if ("weight_kg" in a) patch.weight_kg = a.weight_kg ?? null;
      if ("goal_weight_kg" in a) patch.goal_weight_kg = a.goal_weight_kg ?? null;
      if ("unit_pref" in a) patch.unit_pref = a.unit_pref;
      if (!Object.keys(patch).length) {
        throw new ToolError("nothing to update — pass sex, age, height_cm, weight_kg, goal_weight_kg, and/or unit_pref");
      }
      const { error } = await admin().from("clients").update(patch).eq("id", a.client_id).eq("tenant_id", ctx.tenantId);
      if (error) throw new ToolError(error.message);
      const { data: metrics } = await admin().from("clients").select(F.clientMetrics)
        .eq("id", a.client_id).eq("tenant_id", ctx.tenantId).maybeSingle();
      return { updated: true, keys_set: Object.keys(patch), profile_metrics: metrics ?? null };
    },
  },
  {
    name: "send_message",
    description: "Send a message to one of the coach's clients (appears in the app's Messages thread as the coach). Pure append: does NOT mark the thread read — call mark_thread_read explicitly once the unread items are actually handled.",
    inputSchema: obj({ client_id: S.id, body: { type: "string", minLength: 1, maxLength: 2000 } }, ["client_id", "body"]),
    write: true,
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const { error } = await insTenant(ctx, "messages", { client_id: a.client_id, sender_role: "coach", body: a.body });
      if (error) throw new ToolError(error.message);
      return { sent: true };
    },
  },
  {
    name: "mark_thread_read",
    description: "Explicitly acknowledge one client's message thread as read by the coach. Clears the thread's unread state everywhere (inbox badge, list_inbox, support queue, attention signals). Use ONLY after the unread messages have actually been reviewed/handled — sending a reply does not do this for you. New client messages after this call are unread again.",
    inputSchema: obj({ client_id: S.id }, ["client_id"]),
    write: true,
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      try {
        return await markThreadReadCore(admin(), ctx, a.client_id);
      } catch (e) {
        if (e instanceof MarkThreadReadError) throw new ToolError(e.message);
        throw e;
      }
    },
  },
  {
    name: "mark_checkin_seen",
    description: "Mark a client check-in as reviewed by the coach.",
    inputSchema: obj({ checkin_id: S.id }, ["checkin_id"]),
    write: true,
    run: async (ctx, a) => {
      const { data, error } = await admin().from("checkins").update({ coach_seen: true })
        .eq("id", a.checkin_id).eq("tenant_id", ctx.tenantId).select("id");
      if (error) throw new ToolError(error.message);
      if (!data?.length) throw notFound("check-in");
      return { seen: true };
    },
  },
  {
    name: "archive_client_note",
    description: "Hide a coach note from the default list without deleting it. Pass archived:false to bring it back. A note is a record of what was observed and when; this never destroys one.",
    inputSchema: obj({ note_id: S.id, archived: { type: "boolean", description: "Default true" } }, ["note_id"]),
    write: true,
    run: async (ctx, a) => {
      const archived = a?.archived !== false;
      const { data, error } = await admin().from("client_notes")
        .update({ archived_at: archived ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
        .eq("id", a.note_id).eq("tenant_id", ctx.tenantId).select("id, client_id, archived_at");
      if (error) throw new ToolError(error.message);
      if (!data?.length) throw notFound("note");
      return { ...data[0], archived };
    },
  },
  {
    name: "archive_program",
    description:
      "Retire a program from the library without destroying anything. It stops appearing in list_programs, but " +
      "the program, its structure uuids, and every assignment and workout log anchored to them stay intact — a " +
      "client mid-cycle on it is unaffected and it still names itself correctly in their program history. " +
      "Pass archived:false to restore it. This is the right way to clean up duplicate or stale entries.",
    inputSchema: obj({ program_id: S.id, archived: { type: "boolean", description: "Default true" } }, ["program_id"]),
    write: true,
    run: async (ctx, a) => {
      const p = await ownedProgram(ctx, a.program_id) as any;
      const archived = a?.archived !== false;
      const { error } = await admin().from("programs")
        .update({ archived_at: archived ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
        .eq("id", p.id).eq("tenant_id", ctx.tenantId);
      if (error) throw new ToolError(error.message);
      const active = await sel(ctx, "assignments", "id").eq("program_id", p.id).eq("active", true);
      const live = (active.data ?? []).length;
      return {
        program_id: p.id, name: p.name, archived,
        clients_currently_on_it: live,
        note: archived && live > 0
          ? `${live} client(s) are mid-cycle on this program. Archiving only hides it from the library — their assignment, their current day, and their logged history are all untouched.`
          : undefined,
      };
    },
  },
  {
    name: "delete_program",
    description:
      "Permanently delete a program. REFUSES if any assignment — active or historical — references it, because " +
      "assignments.program_id cascades on delete: removing the program would silently delete those assignment " +
      "rows and orphan the clients' logged workout history behind them. Use archive_program instead in that case. " +
      "Requires confirm_name to exactly match the program's name.",
    inputSchema: obj({ program_id: S.id, confirm_name: { type: "string", minLength: 1, maxLength: 200 } }, ["program_id", "confirm_name"]),
    write: true,
    run: async (ctx, a) => {
      const p = await ownedProgram(ctx, a.program_id) as any;
      if (String(a.confirm_name).trim() !== String(p.name).trim()) {
        throw new ToolError(`nothing deleted — confirm_name must exactly match the program's name, which is "${p.name}".`);
      }
      const { data: assigns, error: ae } = await sel(ctx, "assignments", "id, client_id, active").eq("program_id", p.id);
      if (ae) throw new ToolError(ae.message);
      const rows = (assigns ?? []) as any[];
      if (rows.length) {
        const activeCount = rows.filter((r) => r.active).length;
        throw new ToolError(
          `nothing deleted — ${rows.length} assignment(s) reference this program (${activeCount} currently active). ` +
          "assignments.program_id is ON DELETE CASCADE, so deleting it would take those rows with it and orphan " +
          "the workout history anchored to them. Call archive_program instead: it hides the program from the " +
          "library and destroys nothing.",
        );
      }
      const { error } = await admin().from("programs").delete().eq("id", p.id).eq("tenant_id", ctx.tenantId);
      if (error) throw new ToolError(error.message);
      return { deleted: true, program_id: p.id, name: p.name, note: "It had never been assigned to anyone, so no history was attached to it." };
    },
  },
  {
    name: "create_support_ticket",
    description:
      "Log an issue on a client's behalf, or a business-level issue with no client attached. Also updates an " +
      "existing ticket when ticket_id is passed. A ticket cannot be resolved without a resolution — the schema " +
      "refuses it — because a silently closed ticket stops anyone looking.",
    inputSchema: obj({
      ticket_id: S.id,
      client_id: { type: ["string", "null"], pattern: UUID_PATTERN, description: "Omit for a business-level issue that is about no particular client" },
      title: { type: "string", minLength: 1, maxLength: 200 },
      detail: { type: ["string", "null"], maxLength: 5000 },
      severity: { type: "string", enum: ["low", "normal", "high"] },
      status: { type: "string", enum: ["open", "acknowledged", "resolved"] },
      resolution: { type: ["string", "null"], maxLength: 5000 },
    }),
    write: true,
    run: async (ctx, a) => {
      if (a.client_id) await ownedClient(ctx, a.client_id);
      const now = new Date().toISOString();
      if (a.status === "resolved" && !String(a.resolution ?? "").trim()) {
        throw new ToolError("a ticket cannot be resolved without a resolution — say what actually happened");
      }
      if (a.ticket_id) {
        const { data: existing } = await sel(ctx, "support_tickets", F.ticket).eq("id", a.ticket_id).maybeSingle() as { data: any };
        if (!existing) throw notFound("support ticket");
        const patch: Record<string, unknown> = { updated_at: now };
        if (a.title != null) patch.title = String(a.title).trim();
        if ("detail" in a) patch.detail = a.detail ?? null;
        if (a.severity) patch.severity = a.severity;
        if ("client_id" in a) patch.client_id = a.client_id ?? null;
        if ("resolution" in a) patch.resolution = a.resolution ?? null;
        if (a.status) {
          patch.status = a.status;
          if (a.status === "resolved") {
            patch.resolved_at = now;
            if (!String(a.resolution ?? existing.resolution ?? "").trim()) {
              throw new ToolError("a ticket cannot be resolved without a resolution — say what actually happened");
            }
            patch.resolution = a.resolution ?? existing.resolution;
          } else { patch.resolved_at = null; }
        }
        const { data, error } = await admin().from("support_tickets").update(patch)
          .eq("id", a.ticket_id).eq("tenant_id", ctx.tenantId).select(F.ticket).single();
        if (error) throw new ToolError(error.message);
        return { mode: "updated", ticket: data };
      }
      if (!a.title) throw new ToolError("title is required when opening a new ticket");
      const { data, error } = await insTenant(ctx, "support_tickets", {
        client_id: a.client_id ?? null,
        title: String(a.title).trim(),
        detail: a.detail ?? null,
        severity: a.severity ?? "normal",
        status: a.status ?? "open",
        resolution: a.resolution ?? null,
        resolved_at: a.status === "resolved" ? now : null,
        opened_by: ctx.createdBy,
      }).select(F.ticket).single();
      if (error) throw new ToolError(error.message);
      return {
        mode: "created", ticket: data,
        scope: a.client_id ? "client" : "business",
      };
    },
  },
  {
    name: "save_message_template",
    description:
      "Save or overwrite a reusable message body for this workspace, addressed by slug. Bodies may use " +
      "{{display_name}} / {{first_name}}; any other placeholder is refused here rather than going out as literal " +
      "braces to a whole roster later.",
    inputSchema: obj({
      slug: { type: "string", minLength: 1, maxLength: 60, pattern: "^[a-z0-9][a-z0-9_-]*$" },
      title: { type: "string", minLength: 1, maxLength: 200 },
      body: { type: "string", minLength: 1, maxLength: 2000 },
      category: { type: ["string", "null"], maxLength: 60 },
    }, ["slug", "title", "body"]),
    write: true,
    run: async (ctx, a) => {
      const unknown = unknownPlaceholders(a.body);
      if (unknown.length) {
        throw new ToolError(
          `not saved — this body uses placeholder(s) nothing can fill: ${unknown.join(", ")}. ` +
          `Only ${PLACEHOLDERS.join(" and ")} are substituted; anything else would be sent as literal text.`,
        );
      }
      const now = new Date().toISOString();
      const { data: existing } = await sel(ctx, "message_templates", "id").eq("slug", a.slug).maybeSingle() as { data: any };
      if (existing) {
        const { data, error } = await admin().from("message_templates")
          .update({ title: String(a.title).trim(), body: a.body, category: a.category ?? null, updated_at: now })
          .eq("id", existing.id).eq("tenant_id", ctx.tenantId).select(F.template).single();
        if (error) throw new ToolError(error.message);
        return { mode: "updated", template: data };
      }
      const { data, error } = await insTenant(ctx, "message_templates", {
        slug: a.slug, title: String(a.title).trim(), body: a.body,
        category: a.category ?? null, created_by: ctx.createdBy,
      }).select(F.template).single();
      if (error) throw new ToolError(error.message);
      return { mode: "created", template: data };
    },
  },
  {
    name: "list_client_documents",
    description:
      "Documents on file for one client — signed PAR-Q forms, waivers, IDs, medical notes — newest first, " +
      "each with a short-lived signed link (5 minutes; re-mint with get_client_document once it expires). " +
      "Filter by kind, or omit it to see everything on file.",
    inputSchema: obj({ client_id: S.id, kind: { type: "string", enum: [...DOCUMENT_KINDS] }, limit: S.limit }, ["client_id"]),
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      let q = sel(ctx, "client_documents", F.document).eq("client_id", a.client_id)
        .order("created_at", { ascending: false }).limit(a?.limit ?? 50);
      if (a?.kind) q = q.eq("kind", a.kind);
      const rows = await must(q, "list_client_documents") as any[];
      const signed = await signDocumentPaths(rows.map((r) => r.storage_path));
      return {
        client_id: a.client_id,
        documents: rows.map((r) => ({
          ...r,
          ...(signed.get(r.storage_path) ?? { photo_path: r.storage_path, url: null, url_error: "not signed" }),
        })),
        note: rows.length ? undefined : "No documents on file for this client.",
      };
    },
  },
  {
    name: "get_client_document",
    description:
      "One document by id, with a fresh signed link. Use this to re-mint an expired link from " +
      "list_client_documents rather than re-listing everything.",
    inputSchema: obj({ document_id: S.id }, ["document_id"]),
    run: async (ctx, a) => {
      const { data } = await sel(ctx, "client_documents", F.document).eq("id", a.document_id).maybeSingle() as { data: any };
      if (!data) throw notFound("document");
      const signed = await signDocumentPaths([data.storage_path]);
      return {
        ...data,
        ...(signed.get(data.storage_path) ?? { photo_path: data.storage_path, url: null, url_error: "not signed" }),
      };
    },
  },
  {
    name: "upload_client_document",
    description:
      "Store a document for a client from base64 file content — a signed PAR-Q, a waiver, an ID, a medical " +
      "note. Coach-only; no client token can call this, regardless of scope. kind must be one of: " +
      `${DOCUMENT_KINDS.join(", ")}. mime_type must be one of: ${DOCUMENT_MIME_ALLOWLIST.join(", ")}. ` +
      "Roughly 6 MB per file, maximum.",
    inputSchema: obj({
      client_id: S.id,
      kind: { type: "string", enum: [...DOCUMENT_KINDS] },
      title: { type: ["string", "null"], maxLength: 200 },
      filename: { type: "string", minLength: 1, maxLength: 200 },
      mime_type: { type: "string", enum: [...DOCUMENT_MIME_ALLOWLIST] },
      content_base64: { type: "string", minLength: 1 },
    }, ["client_id", "kind", "filename", "mime_type", "content_base64"]),
    write: true,
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const validation = validateDocumentUpload(a);
      if (!validation.ok) throw new ToolError(validation.error);
      const path = documentStoragePath(ctx.tenantId, a.client_id, a.kind, a.filename, new Date().toISOString());
      const bytes = Uint8Array.from(atob(a.content_base64), (c) => c.charCodeAt(0));
      const { error: uploadError } = await admin().storage.from(DOC_BUCKET)
        .upload(path, bytes, { contentType: a.mime_type, upsert: false });
      if (uploadError) throw new ToolError(`upload failed: ${uploadError.message}`);
      const { data, error } = await insTenant(ctx, "client_documents", {
        client_id: a.client_id,
        kind: a.kind,
        title: a.title ?? null,
        filename: String(a.filename).trim(),
        storage_path: path,
        mime_type: a.mime_type,
        size_bytes: validation.sizeBytes,
        uploaded_by: ctx.createdBy,
      }).select(F.document).single();
      if (error) throw new ToolError(error.message);
      return { uploaded: true, document: data };
    },
  },
  {
    name: "send_bulk_message",
    description:
      "Send one message to many clients at once, personalised per recipient — the native version of hand-rolling " +
      "a migration announcement through email. Use {{display_name}} and {{first_name}} in the body; they are " +
      "substituted per recipient. Recipients are either explicit client_ids or a roster filter. " +
      "IMPORTANT: you must pass confirm_recipient_count matching the number of clients this will actually reach, " +
      "so a filter that resolves to more people than you expected refuses instead of sending. Returns a " +
      "per-recipient result — never a blanket 'sent' over a partial delivery.",
    inputSchema: obj({
      body: { type: "string", minLength: 1, maxLength: 2000 },
      confirm_recipient_count: { type: "integer", minimum: 1, maximum: 200, description: "Must equal the resolved recipient count, or nothing is sent" },
      client_ids: { type: "array", items: S.id, minItems: 1, maxItems: 200 },
      status: { type: "string", enum: ["active", "paused", "invited", "all"], description: "Roster filter, used only when client_ids is omitted" },
      coaching_tier: { type: "string", maxLength: 60, description: "Further narrows the roster filter" },
    }, ["body", "confirm_recipient_count"]),
    write: true,
    run: async (ctx, a) => {
      const body = String(a.body);
      let recipients: any[];
      if (Array.isArray(a.client_ids) && a.client_ids.length) {
        const { data, error } = await sel(ctx, "clients", "id, display_name, status").in("id", a.client_ids);
        if (error) throw new ToolError(error.message);
        recipients = (data ?? []) as any[];
        const found = new Set(recipients.map((r) => r.id));
        const missing = a.client_ids.filter((id: string) => !found.has(id));
        if (missing.length) throw new ToolError(`${missing.length} client id(s) are not in your workspace — nothing was sent. Unknown: ${missing.join(", ")}`);
      } else {
        let q = sel(ctx, "clients", "id, display_name, status").order("display_name");
        const status = a?.status ?? "active";
        if (status !== "all") q = q.eq("status", status);
        if (a?.coaching_tier) q = q.eq("coaching_tier", a.coaching_tier);
        const { data, error } = await q;
        if (error) throw new ToolError(error.message);
        recipients = (data ?? []) as any[];
      }
      if (!recipients.length) throw new ToolError("that filter matched no clients — nothing was sent");
      // The whole point of the confirmation: a filter that quietly resolves to the entire roster
      // must refuse, not send. This is the highest-blast-radius write on the surface.
      if (recipients.length !== a.confirm_recipient_count) {
        throw new ToolError(
          `nothing sent — this would reach ${recipients.length} client(s) but confirm_recipient_count said ${a.confirm_recipient_count}. ` +
          "Check who is actually in scope, then call again with the real number.",
        );
      }

      const unknown = unknownPlaceholders(body);
      if (unknown.length) {
        throw new ToolError(
          `nothing sent — the body uses placeholder(s) this surface cannot fill: ${unknown.join(", ")}. ` +
          `Only ${PLACEHOLDERS.join(" and ")} are substituted; anything else would go out to every client as literal text.`,
        );
      }
      // A client with no display name is a real gap in the record. Refuse the whole send rather
      // than delivering "Hi ," to them, and rather than inventing a friendly stand-in that
      // would stop anyone noticing the name is missing.
      const nameless = recipients.filter((r) => personaliseMessage(body, r.display_name).unfilled.length);
      if (nameless.length) {
        throw new ToolError(
          `nothing sent — ${nameless.length} recipient(s) have no display name on file, so the personalisation ` +
          `would come out blank: ${nameless.map((r) => r.id).join(", ")}. Fix those records, or send a body ` +
          "with no name placeholder in it.",
        );
      }

      const results: Array<{ client_id: string; display_name: string | null; sent: boolean; error?: string }> = [];
      for (const r of recipients) {
        const { body: personalised } = personaliseMessage(body, r.display_name);
        const { error } = await insTenant(ctx, "messages", { client_id: r.id, sender_role: "coach", body: personalised });
        results.push(error
          ? { client_id: r.id, display_name: r.display_name, sent: false, error: error.message }
          : { client_id: r.id, display_name: r.display_name, sent: true });
        // Paced, so a 200-client send does not arrive as one burst against the database or the
        // clients' notification channels.
        await new Promise((res) => setTimeout(res, 40));
      }
      const failed = results.filter((r) => !r.sent);
      return {
        attempted: results.length,
        sent: results.length - failed.length,
        failed: failed.length,
        // Named individually. "22 of 22 sent" and "18 of 22 sent" must never look the same.
        results,
        note: failed.length
          ? `${failed.length} recipient(s) did NOT receive this. They are listed above with the reason — resend to those specifically, not to everyone.`
          : undefined,
      };
    },
  },
  {
    name: "post_to_community",
    description:
      "Publish a post to the tenant's community feed. This schema has no client-authored posts — every post is " +
      "the coach's business speaking; clients participate through comments and reactions. media_type must match " +
      "the media you attach (video, image or text).",
    inputSchema: obj({
      body: { type: "string", minLength: 1, maxLength: 5000 },
      media_url: { type: ["string", "null"], maxLength: 1000 },
      media_type: { type: ["string", "null"], enum: ["video", "image", "text", null] },
      pinned: { type: "boolean" },
    }, ["body"]),
    write: true,
    run: async (ctx, a) => {
      const mediaUrl = a.media_url?.trim() || null;
      if (mediaUrl && !a.media_type) throw new ToolError("media_url was given without media_type — pass video, image or text");
      if (mediaUrl && !/^https?:\/\//i.test(mediaUrl)) throw new ToolError("media_url must be an http(s) URL");
      const { data, error } = await insTenant(ctx, "community_posts", {
        body: String(a.body).trim(),
        media_url: mediaUrl,
        media_type: mediaUrl ? a.media_type : null,
        pinned: a.pinned ?? false,
      }).select(F.communityPost).single();
      if (error) throw new ToolError(error.message);
      return { post: data, visible_to: "every client in this workspace" };
    },
  },
  {
    name: "moderate_community_post",
    description:
      "Pin, unpin or delete a community post. DELETE IS PERMANENT and cascades — every comment and reaction on " +
      "that post goes with it, and this schema has no soft-delete to undo it. Deleting therefore requires " +
      "confirm_delete: true, and the deleted post's body is returned so it is at least recoverable from this " +
      "transcript.",
    inputSchema: obj({
      post_id: S.id,
      action: { type: "string", enum: ["pin", "unpin", "delete"] },
      confirm_delete: { type: "boolean" },
    }, ["post_id", "action"]),
    write: true,
    run: async (ctx, a) => {
      const { data: post } = await sel(ctx, "community_posts", F.communityPost).eq("id", a.post_id).maybeSingle() as { data: any };
      if (!post) throw notFound("community post");
      if (a.action !== "delete") {
        const { error } = await admin().from("community_posts").update({ pinned: a.action === "pin" })
          .eq("id", a.post_id).eq("tenant_id", ctx.tenantId);
        if (error) throw new ToolError(error.message);
        return { post_id: a.post_id, pinned: a.action === "pin" };
      }
      if (a.confirm_delete !== true) {
        throw new ToolError(
          "nothing deleted — deleting a post also deletes every comment and reaction on it, permanently, with no " +
          "undo in this schema. Pass confirm_delete: true if that is genuinely intended.",
        );
      }
      const [{ data: comments }, { data: reactions }] = await Promise.all([
        sel(ctx, "community_comments", "id").eq("post_id", a.post_id),
        sel(ctx, "community_reactions", "client_id").eq("post_id", a.post_id),
      ]);
      const { error } = await admin().from("community_posts").delete()
        .eq("id", a.post_id).eq("tenant_id", ctx.tenantId);
      if (error) throw new ToolError(error.message);
      return {
        deleted: true,
        deleted_post: post,
        also_deleted: { comments: (comments ?? []).length, reactions: (reactions ?? []).length },
        note: "Permanent. The post body above is the only remaining copy.",
      };
    },
  },
  {
    name: "create_client_note",
    description:
      "Write a coach-private note on a client — a finding, a call summary, something to remember. Clients never " +
      "see these. Attributed to the coach account that issued this connector token. This is how an AI logs what " +
      "it worked out back into the system instead of leaving it in a chat transcript.",
    inputSchema: obj({ client_id: S.id, body: { type: "string", minLength: 1, maxLength: 5000 } }, ["client_id", "body"]),
    write: true,
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const { data, error } = await insTenant(ctx, "client_notes", {
        client_id: a.client_id,
        body: String(a.body).trim(),
        // The coach user who issued this token (connector_tokens.created_by, NOT NULL) — the
        // same reader identity mark_thread_read already uses. Real attribution, not a blank.
        author_user_id: ctx.createdBy,
      }).select("id, created_at").single();
      if (error) throw new ToolError(error.message);
      return { note_id: data.id, created_at: data.created_at, client_id: a.client_id, visible_to_client: false };
    },
  },
  {
    name: "update_client_note",
    description: "Rewrite the body of an existing coach-private note. Replaces the body in full — read it with list_client_notes first if you are appending.",
    inputSchema: obj({ note_id: S.id, body: { type: "string", minLength: 1, maxLength: 5000 } }, ["note_id", "body"]),
    write: true,
    run: async (ctx, a) => {
      const { data, error } = await admin().from("client_notes")
        .update({ body: String(a.body).trim(), updated_at: new Date().toISOString() })
        .eq("id", a.note_id).eq("tenant_id", ctx.tenantId)
        .select("id, client_id, updated_at");
      if (error) throw new ToolError(error.message);
      if (!data?.length) throw notFound("note");
      return { updated: true, ...data[0] };
    },
  },
  {
    name: "log_workout_on_behalf",
    description:
      "Log a client's set actuals (weight × reps), or a cardio exercise's actuals (duration/distance/RPE), for " +
      "them — for a call, an in-person session, or catching up a client who trains off-app. Writes to the " +
      "CURRENT day of their active program, starting or resuming that day's session exactly as the client's own " +
      "Start-workout button does. A cardio exercise has exactly one set at set_index 0 — check get_program for " +
      "which exercises on the day are cardio. Sets default to NOT done unless done:true is passed, and a " +
      "done:true set must carry an actual weight, reps, duration, or distance — an empty 'done' set is refused, " +
      "not silently invented. Use exercise_ids from get_program; set_index is 0-based. Refuses if the client has " +
      "no active program, or if today is a rest day — it will not invent a session that does not exist in their plan.",
    inputSchema: obj({
      client_id: S.id,
      sets: {
        type: "array", minItems: 1, maxItems: 60,
        items: obj({
          exercise_id: S.id,
          set_index: { type: "integer", minimum: 0 },
          weight: { type: ["number", "null"] },
          reps: { type: ["integer", "null"] },
          duration_seconds: { type: ["integer", "null"], description: "Cardio actual duration in seconds." },
          distance_meters: { type: ["number", "null"], description: "Cardio actual distance in meters." },
          rpe: { type: ["number", "null"], minimum: 1, maximum: 10, description: "Perceived exertion 1-10. Used for both strength sets and cardio." },
          done: { type: "boolean" },
        }, ["exercise_id", "set_index"]),
      },
    }, ["client_id", "sets"]),
    write: true,
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const { assignment, program } = await activeAssignmentFor(ctx, a.client_id);
      // Resolved per assignment.day_order (client schedule adjustments) when set,
      // else the program's own order — see effectiveDays.ts. Logging against the
      // raw program-order day here would write to the wrong day_id whenever the
      // client has swapped their schedule.
      const { days } = resolveEffectiveDays(program as any, assignment as any);
      const day = days[assignment.current_day_index];
      if (!day) throw new ToolError(`their program has no day at index ${assignment.current_day_index}`);
      if (day.kind !== "training") {
        throw new ToolError(`the client's current day (${day.label ?? "current day"}) is a rest day — there is nothing to log against it.`);
      }
      const setsPerExercise = new Map<string, number>();
      for (const g of day.groups ?? []) for (const ex of g.exercises ?? []) setsPerExercise.set(ex.exercise_id, (ex.sets ?? []).length);
      for (const s of a.sets) {
        const n = setsPerExercise.get(s?.exercise_id);
        if (n === undefined) throw new ToolError(`exercise ${s?.exercise_id} is not in this client's current day (${day.label ?? "current day"}) — check get_program`);
        if (!Number.isInteger(s.set_index) || s.set_index < 0 || s.set_index >= n) {
          throw new ToolError(`set_index ${s.set_index} out of range for that exercise (0–${n - 1})`);
        }
        const doneErr = earnedDoneError(s);
        if (doneErr) throw new ToolError(doneErr);
      }
      // Same idempotent (assignment_id, day_id) upsert the app's Start-workout uses, so logging
      // on a client's behalf and the client logging it themselves land on one session, not two.
      const { data: session, error: se } = await admin().from("workout_sessions")
        .upsert({ tenant_id: ctx.tenantId, client_id: a.client_id, assignment_id: assignment.id, day_id: day.day_id },
          { onConflict: "assignment_id,day_id" })
        .select("id").single();
      if (se) throw new ToolError(se.message);
      const { error: le } = await admin().from("workout_logs").upsert(
        a.sets.map((s: any) => ({
          tenant_id: ctx.tenantId, client_id: a.client_id, session_id: session.id,
          exercise_id: s.exercise_id, set_index: s.set_index,
          weight: s.weight == null ? null : Number(s.weight),
          reps: s.reps == null ? null : Number(s.reps),
          duration_seconds: s.duration_seconds == null ? null : Number(s.duration_seconds),
          distance_meters: s.distance_meters == null ? null : Number(s.distance_meters),
          rpe: s.rpe == null ? null : Number(s.rpe),
          done: s.done ?? false, updated_at: new Date().toISOString(),
        })),
        { onConflict: "session_id,exercise_id,set_index" },
      );
      if (le) throw new ToolError(le.message);
      return {
        session_id: session.id, client_id: a.client_id, day_label: day.label ?? null,
        logged_sets: a.sets.length,
        note: "Sets logged against the client's current day. The day is not marked complete — the client finishes it in the app.",
      };
    },
  },
  {
    name: "reply_to_checkin",
    description:
      "Respond to a specific check-in and (by default) mark it seen. IMPORTANT: this schema has no " +
      "check-in feedback field — nothing stores 'the coach's response to check-in X'. The reply is therefore " +
      "delivered as a real message in the client's thread, opening with a dated reference to the check-in it " +
      "answers. The response says so explicitly. If check-in-attached feedback is wanted, that is a schema " +
      "change, not something this tool quietly pretends to do.",
    inputSchema: obj({
      checkin_id: S.id,
      body: { type: "string", minLength: 1, maxLength: 2000 },
      mark_seen: { type: "boolean", description: "Default true — set false to reply without acknowledging it" },
    }, ["checkin_id", "body"]),
    write: true,
    run: async (ctx, a) => {
      const { data: checkin } = await sel(ctx, "checkins", "id, client_id, submitted_at")
        .eq("id", a.checkin_id).maybeSingle() as { data: any };
      if (!checkin) throw notFound("check-in");
      const when = String(checkin.submitted_at ?? "").slice(0, 10);
      const body = `Re: your check-in${when ? ` from ${when}` : ""} — ${String(a.body).trim()}`;
      const { data: msg, error } = await insTenant(ctx, "messages", {
        client_id: checkin.client_id, sender_role: "coach", body,
      }).select("id, sent_at").single();
      if (error) throw new ToolError(error.message);

      const markSeen = a?.mark_seen !== false;
      let seen: boolean | string = false;
      if (markSeen) {
        const { error: e2 } = await admin().from("checkins").update({ coach_seen: true })
          .eq("id", a.checkin_id).eq("tenant_id", ctx.tenantId);
        // The reply is already sent and cannot be unsent. Report the acknowledgment failure
        // rather than swallowing it — a check-in silently left unseen resurfaces in triage.
        seen = e2 ? `not marked seen: ${e2.message}` : true;
      }
      return {
        delivered_as: "message",
        note: "Delivered as a message in the client's thread. This schema has no check-in-attached feedback field.",
        message_id: msg.id,
        sent_at: msg.sent_at,
        client_id: checkin.client_id,
        checkin_marked_seen: seen,
      };
    },
  },
  {
    name: "update_client_prep_info",
    description: "Set a client's show date, show name, lifestyle/prep classification, and/or check-in schedule (the same fields as the app's client profile). Pass only the fields you're changing; pass null to clear show_date, show_name, or reset checkin_cadence/checkin_day_of_week to inherit the tenant default. checkin_day_of_week: 0=Sunday..6=Saturday. Changing checkin_cadence or checkin_day_of_week cancels this client's future scheduled check-in due dates and regenerates them on the new rhythm — the response's checkin_schedule field reports what happened, including a 'blocked' result if neither this client nor the tenant has any cadence configured at all.",
    inputSchema: obj({
      client_id: S.id,
      show_date: { type: ["string", "null"], description: "ISO date (YYYY-MM-DD), or null to clear" },
      show_name: { type: ["string", "null"], maxLength: 120 },
      client_type: { type: ["string", "null"], enum: ["lifestyle", "prep", null] },
      checkin_cadence: { type: ["string", "null"], enum: ["weekly", "biweekly", "monthly", null], description: "Null inherits the tenant's default cadence — not the same as 'no check-ins'." },
      checkin_day_of_week: { type: ["integer", "null"], minimum: 0, maximum: 6, description: "0=Sunday..6=Saturday. Null inherits the day the client started." },
    }, ["client_id"]),
    write: true,
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const patch: Record<string, unknown> = {};
      if ("show_date" in a) patch.show_date = a.show_date || null;
      if ("show_name" in a) patch.show_name = a.show_name?.trim() || null;
      if ("client_type" in a) patch.client_type = a.client_type || null;
      if ("checkin_cadence" in a) patch.checkin_cadence = a.checkin_cadence || null;
      if ("checkin_day_of_week" in a) patch.checkin_day_of_week = a.checkin_day_of_week ?? null;
      // Flipping into prep without an explicit cadence call is exactly the case a coach forgets
      // to think about — a prep client gets checked on weekly by default rather than silently
      // inheriting whatever (or nothing) the tenant default happens to already be.
      if (patch.client_type === "prep" && !("checkin_cadence" in a)) {
        const { data: current } = await admin().from("clients").select("checkin_cadence").eq("id", a.client_id).maybeSingle();
        if (!current?.checkin_cadence) patch.checkin_cadence = "weekly";
      }
      if (!Object.keys(patch).length) throw new ToolError("nothing to update — pass show_date, show_name, client_type, checkin_cadence, and/or checkin_day_of_week");
      const { error } = await admin().from("clients").update(patch).eq("id", a.client_id).eq("tenant_id", ctx.tenantId);
      if (error) throw new ToolError(error.message);

      // The client row write above already succeeded. What follows is a secondary
      // consistency step (keeping client_checkin_schedule's future due dates in step
      // with whatever cadence just landed) — its own failure must not report the
      // whole tool call as failed, since the actual prep-info update did go through.
      // Best-effort, but never silent: a failure here is surfaced in checkin_schedule,
      // not swallowed (same convention as client.js's submitCheckin warnings).
      const todayYmd = ymdUtc(new Date());
      const action = checkinScheduleActions(patch, a.client_id, todayYmd);
      let checkin_schedule: unknown = { status: "unchanged" };
      if (action.kind === "cancel_and_regenerate") {
        const { error: cancelErr } = await admin().from("client_checkin_schedule")
          .update({ status: "cancelled" })
          .eq("client_id", action.clientId).eq("status", "scheduled").gt("due_on", action.todayYmd);
        if (cancelErr) {
          checkin_schedule = { status: "error", detail: `could not cancel the old schedule: ${cancelErr.message}` };
        } else {
          const { data: rpcData, error: rpcErr } = await admin().rpc("schedule_client_checkins", { p_client_id: action.clientId });
          checkin_schedule = rpcErr ? { status: "error", detail: rpcErr.message } : rpcData;
        }
      }
      return { updated: true, ...patch, checkin_schedule };
    },
  },
  {
    name: "update_client_status",
    description: "Change a client's lifecycle status to active, paused, or archived. Archived is the app's non-destructive close-out — it drops them off active-roster views while keeping every check-in, message, program and note (the same state the Archive-client button sets). Use it when a client cancels. Moving back to active from paused or archived only ever touches the status column (plus pause bookkeeping) — nothing about programs, assignments, or history is touched, so it never silently wipes anything. pause_resume_date is only meaningful together with status: \"paused\"; it is cleared automatically for any other status.",
    inputSchema: obj({
      client_id: S.id,
      status: { type: "string", enum: ["active", "paused", "archived"] },
      pause_resume_date: { type: ["string", "null"], description: "ISO date (YYYY-MM-DD) the client expects to resume — only used with status: \"paused\"" },
    }, ["client_id", "status"]),
    write: true,
    run: async (ctx, a) => {
      const client = await ownedClient(ctx, a.client_id);
      const patch: Record<string, unknown> = { status: a.status };
      if (a.status === "paused") {
        if (client.status !== "paused") patch.paused_at = new Date().toISOString();
        if ("pause_resume_date" in a) patch.pause_resume_date = a.pause_resume_date || null;
      } else {
        patch.paused_at = null;
        patch.pause_resume_date = null;
      }
      const { error } = await admin().from("clients").update(patch).eq("id", client.id).eq("tenant_id", ctx.tenantId);
      if (error) throw new ToolError(error.message);
      return { client_id: client.id, status: a.status, was: client.status };
    },
  },
  {
    name: "create_challenge",
    description: "Create a new challenge, always in draft status, with its daily standards — call publish_challenge separately once it's ready to go live. duration_days and the standards list both cap at 7 (schema constraint). num_standards is how many of the listed standards a participant must hit on a given day for that day to count as met; defaults to requiring all of them.",
    inputSchema: obj({
      title: { type: "string", minLength: 1, maxLength: 200 },
      slug: { type: "string", minLength: 1, maxLength: 60, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", description: "URL-safe, unique per workspace, lowercase-with-hyphens" },
      subtitle: { type: "string", maxLength: 200 },
      description: { type: "string", maxLength: 2000 },
      duration_days: { type: "integer", minimum: 1, maximum: 7 },
      standards: {
        type: "array", minItems: 1, maxItems: 7,
        items: obj({ title: { type: "string", minLength: 1, maxLength: 120 }, description: { type: "string", maxLength: 500 } }, ["title"]),
        description: "The daily standards, in order — e.g. 'Hit your protein target'.",
      },
      num_standards: { type: "integer", minimum: 1, maximum: 7, description: "Defaults to standards.length (must hit all of them)" },
      reward_type: { type: "string", minLength: 1, maxLength: 60, description: "Defaults to free_month_standard" },
      audience: { type: "string", enum: ["open", "clients_only", "non_clients_only"], description: "Defaults to open" },
    }, ["title", "slug", "duration_days", "standards"]),
    write: true,
    run: async (ctx, a) => {
      const standards = a.standards as Array<{ title: string; description?: string }>;
      const numStandards = a.num_standards ?? standards.length;
      if (numStandards > standards.length)
        throw new ToolError(`num_standards (${numStandards}) can't exceed the number of standards provided (${standards.length})`);
      const { data: challenge, error } = await insTenant(ctx, "challenges", {
        slug: String(a.slug).trim(),
        title: String(a.title).trim(),
        subtitle: a.subtitle?.trim() || null,
        description: a.description?.trim() || null,
        duration_days: a.duration_days,
        num_standards: numStandards,
        reward_type: a.reward_type?.trim() || "free_month_standard",
        audience: a.audience ?? "open",
        status: "draft",
      }).select("id, slug, title, status").single();
      if (error) {
        if (error.code === "23505") throw new ToolError(`a challenge with slug "${a.slug}" already exists in this workspace`);
        throw new ToolError(error.message);
      }
      // Two separate inserts, not a transaction: a standards-insert failure here leaves
      // a real but standards-less draft row behind (publish_challenge refuses those, so
      // it can't reach clients half-built — retry create_challenge or clean it up by hand).
      const { error: se } = await admin().from("challenge_standards").insert(
        standards.map((s, i) => ({
          tenant_id: ctx.tenantId, challenge_id: challenge.id, ordinal: i + 1,
          title: String(s.title).trim(), description: s.description?.trim() || null,
        })),
      );
      if (se) throw new ToolError(`challenge created (${challenge.id}) but standards failed: ${se.message}`);
      return { ...challenge, standards: standards.length, num_standards: numStandards };
    },
  },
  {
    name: "publish_challenge",
    description: "Make a draft (or re-publish an archived) challenge live and enrollable — status → published. Refuses if the challenge has no standards defined yet, since an empty challenge can never be completed. Safe to call on an already-published challenge (no-op).",
    inputSchema: obj({ challenge_id: S.id }, ["challenge_id"]),
    write: true,
    run: async (ctx, a) => {
      const { data: challenge } = await sel(ctx, "challenges", "id, status").eq("id", a.challenge_id).maybeSingle();
      if (!challenge) throw notFound("challenge");
      if (challenge.status === "published") return { challenge_id: challenge.id, status: "published", already_published: true };
      const { data: standards } = await sel(ctx, "challenge_standards", "id").eq("challenge_id", a.challenge_id);
      if (!standards?.length) throw new ToolError("this challenge has no standards yet — nothing for a participant to hit each day. Add standards (recreate via create_challenge, or ask for a standards-editing tool) before publishing.");
      const { error } = await admin().from("challenges").update({ status: "published" }).eq("id", a.challenge_id).eq("tenant_id", ctx.tenantId);
      if (error) throw new ToolError(error.message);
      return { challenge_id: challenge.id, status: "published" };
    },
  },
  {
    name: "enroll_client_in_challenge",
    description: "Coach-side enrollment: starts an active challenge run for one of your own clients immediately, the same way a participant's own self-enrollment does. Requires the client to have already signed into the app at least once — there is no participant identity to attach a run to otherwise. Audience restrictions (clients_only / non_clients_only) are NOT applied here; you are choosing this client directly, which is authorization enough. Idempotent — enrolling a client already in a run for this challenge just returns their existing run.",
    inputSchema: obj({ challenge_id: S.id, client_id: S.id }, ["challenge_id", "client_id"]),
    write: true,
    run: async (ctx, a) => {
      const client = await ownedClient(ctx, a.client_id);
      const { data: full } = await admin().from("clients").select("client_user_id")
        .eq("id", a.client_id).eq("tenant_id", ctx.tenantId).maybeSingle();
      if (!full?.client_user_id)
        throw new ToolError(`${client.display_name} has never signed into the app yet — no participant identity to enroll (client_user_id is unset)`);
      const { data: challenge } = await sel(ctx, "challenges", "id, status").eq("id", a.challenge_id).maybeSingle();
      if (!challenge) throw notFound("challenge");
      if (challenge.status !== "published") throw new ToolError(`challenge is ${challenge.status}, not published — call publish_challenge first`);
      const { data: existing } = await sel(ctx, "challenge_runs", "id, status")
        .eq("challenge_id", a.challenge_id).eq("participant_user_id", full.client_user_id).maybeSingle();
      if (existing) return { run_id: existing.id, status: existing.status, already_enrolled: true };
      const { data, error } = await insTenant(ctx, "challenge_runs", {
        challenge_id: a.challenge_id, participant_user_id: full.client_user_id, client_id: a.client_id,
        status: "active", started_at: new Date().toISOString(),
      }).select("id, status").single();
      if (error) throw new ToolError(error.message);
      return { run_id: data.id, status: data.status };
    },
  },
  {
    name: "create_program",
    description: "Create a new program from a full structure ({days:[{kind, label, groups:[{type, exercises:[{name, sets:[{target_reps, target_weight, notes}]}]}]}]}). The server mints all structure uuids.",
    inputSchema: obj({ name: { type: "string", minLength: 1 }, structure: { type: "object" } }, ["name", "structure"]),
    write: true,
    run: async (ctx, a) => {
      const structure = validateStructure(a.structure);
      const { data, error } = await insTenant(ctx, "programs", {
        name: String(a.name).trim(), structure, is_default: false, source_draft_id: null,
      }).select("id, name").single();
      if (error) throw new ToolError(error.message);
      return { ...data, ...structureSummary(structure) };
    },
  },
  {
    name: "update_program",
    description: "Replace a program's structure (and/or name). Existing day_id/exercise_id uuids MUST be reused verbatim from get_program — they anchor client workout history. Edits that drop existing ids are rejected while clients are mid-cycle on the program, unless allow_removals is true.",
    inputSchema: obj({
      program_id: S.id, name: { type: "string" }, structure: { type: "object" },
      allow_removals: { type: "boolean", description: "Permit dropping existing days/exercises even with clients mid-cycle (their logged history for removed items shows as '(removed exercise)')." },
    }, ["program_id"]),
    write: true,
    run: async (ctx, a) => {
      const p = await ownedProgram(ctx, a.program_id);
      const patch: Record<string, unknown> = {};
      if (a.name) patch.name = String(a.name).trim();
      if (a.structure) {
        const next = validateStructure(a.structure);
        const missing = [...structureIds(p.structure)].filter((id) => !structureIds(next).has(id));
        if (missing.length) {
          const active = await sel(ctx, "assignments", "id").eq("program_id", p.id).eq("active", true);
          if ((active.data ?? []).length > 0 && !a.allow_removals)
            throw new ToolError(
              `edit drops ${missing.length} existing day/exercise id(s) while ${active.data!.length} client(s) are mid-cycle on this program. ` +
              `Reuse the ids from get_program, or pass allow_removals: true to proceed anyway.`);
        }
        patch.structure = next;
      }
      if (!Object.keys(patch).length) throw new ToolError("nothing to update — pass name and/or structure");
      const { error } = await admin().from("programs").update(patch).eq("id", p.id).eq("tenant_id", ctx.tenantId);
      if (error) throw new ToolError(error.message);
      return { updated: true, ...(patch.structure ? structureSummary(patch.structure) : {}) };
    },
  },
  {
    name: "duplicate_program",
    description: "Clone a program with fresh structure uuids (clone-to-customize; the copy's history never collides with the original's).",
    inputSchema: obj({ program_id: S.id, new_name: { type: "string" } }, ["program_id"]),
    write: true,
    run: async (ctx, a) => {
      const p = await ownedProgram(ctx, a.program_id);
      const structure = validateStructure(JSON.parse(JSON.stringify(p.structure, (k, v) =>
        (k === "day_id" || k === "group_id" || k === "exercise_id") ? undefined : v)));
      const { data, error } = await insTenant(ctx, "programs", {
        name: a.new_name?.trim() || `${p.name} (copy)`, structure,
        meal_plan: p.meal_plan ?? null, is_default: false, source_draft_id: null,
      }).select("id, name").single();
      if (error) throw new ToolError(error.message);
      return data;
    },
  },
  {
    name: "assign_program",
    description: "Assign a program to one or more clients, starting each at day 1. Replaces each client's currently active assignment (their prior cycle ends; logged history is kept).",
    inputSchema: obj({ program_id: S.id, client_ids: { type: "array", items: S.id, minItems: 1, maxItems: 50 } }, ["program_id", "client_ids"]),
    write: true,
    run: async (ctx, a) => {
      await ownedProgram(ctx, a.program_id);
      for (const cid of a.client_ids) await ownedClient(ctx, cid);
      for (const cid of a.client_ids) {
        const { error: d } = await admin().from("assignments").update({ active: false, updated_at: new Date().toISOString() })
          .eq("client_id", cid).eq("tenant_id", ctx.tenantId).eq("active", true);
        if (d) throw new ToolError(d.message);
        const { error: i } = await insTenant(ctx, "assignments", { client_id: cid, program_id: a.program_id, active: true, current_day_index: 0 });
        if (i) throw new ToolError(i.message);
      }
      return { assigned: a.client_ids.length };
    },
  },
  {
    name: "generate_program_draft",
    description:
      "Generate a training + nutrition plan from real, stated intake facts — the same computation " +
      "the client-facing intake form uses. This is what assemble_meal_plan needs before it can build " +
      "nutrition: it fails with no_macro_targets until a draft with computed macros exists. Refuses " +
      "on any missing required fact rather than guessing — goal, equipment, experience, days_per_week, " +
      "and all eight PAR-Q health-screen questions must be stated explicitly, even a 'no'. Body metrics " +
      "(sex, age, height, weight) are read from the client's profile when already on file; pass them to " +
      "override or to supply what isn't. A PAR-Q flag holds the draft for your review instead of " +
      "generating a plan — that is not a bug, it means don't guess past a real health screen. On success " +
      "the draft lands Pending (or auto-publishes if this tenant's approval gate is off) with computed " +
      "calorie/protein/fat/carb targets.",
    inputSchema: obj({
      client_id: S.id,
      goal: { type: "string", enum: ["fat_loss", "muscle_gain", "recomp", "maintain"] },
      equipment: { type: "string", enum: ["full_gym", "home_basic", "bodyweight"] },
      experience: { type: "string", enum: ["beginner", "intermediate", "advanced"] },
      days_per_week: { type: "integer", minimum: 3, maximum: 6 },
      injuries: { type: "array", items: { type: "string" }, maxItems: 20, description: "e.g. knee, shoulder, lower_back, elbow, wrist — empty array if none reported" },
      dietary_style: { type: "string", maxLength: 60 },
      allergies: { type: "string", maxLength: 500 },
      diet_notes: { type: "string", maxLength: 1000 },
      weekly_loss_lb: { type: ["number", "null"], description: "Optional coach-set target rate; never required" },
      goal_weight_kg: { type: ["number", "null"], description: "Optional coach target only; never required, never blocks" },
      sex: { type: ["string", "null"], enum: ["male", "female", null], description: "Overrides the on-file value; required (here or on the client's profile) if neither is set" },
      age: { type: ["integer", "null"], minimum: 14, maximum: 90 },
      height_cm: { type: ["number", "null"], minimum: 120, maximum: 230 },
      weight_kg: { type: ["number", "null"], minimum: 35, maximum: 250 },
      parq_heart_condition: { type: "boolean" },
      parq_chest_pain: { type: "boolean" },
      parq_dizziness: { type: "boolean" },
      parq_bone_joint: { type: "boolean" },
      parq_bp_meds: { type: "boolean" },
      parq_other_reason: { type: "boolean" },
      pregnant: { type: "boolean" },
      eating_disorder_history: { type: "boolean" },
      medications: { type: "string", maxLength: 500, description: "Free text; non-empty raises a health flag" },
    }, [
      "client_id", "goal", "equipment", "experience", "days_per_week",
      "parq_heart_condition", "parq_chest_pain", "parq_dizziness", "parq_bone_joint",
      "parq_bp_meds", "parq_other_reason", "pregnant", "eating_disorder_history",
    ]),
    write: true,
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      // F.client is a deliberately thin allowlist (no body metrics) — read the columns
      // generate.ts actually needs directly, as a fallback for whatever wasn't passed.
      const { data: full } = await admin().from("clients")
        .select("sex, age, height_cm, weight_kg, client_type")
        .eq("id", a.client_id).eq("tenant_id", ctx.tenantId).maybeSingle();

      const answers = {
        goal: a.goal, equipment: a.equipment, experience: a.experience, days_per_week: a.days_per_week,
        injuries: a.injuries ?? [], dietary_style: a.dietary_style, allergies: a.allergies, diet_notes: a.diet_notes,
        weekly_loss_lb: a.weekly_loss_lb ?? undefined, goal_weight_kg: a.goal_weight_kg ?? undefined,
        sex: a.sex ?? full?.sex ?? undefined,
        age: a.age ?? full?.age ?? undefined,
        height_cm: a.height_cm ?? full?.height_cm ?? undefined,
        weight_kg: a.weight_kg != null ? a.weight_kg : (full?.weight_kg != null ? Number(full.weight_kg) : undefined),
        // clients.client_type is lifestyle/prep; the generator's own vocabulary is
        // lifestyle/competitor. "prep" and "competitor" both mean the same real-world
        // fact (this person is prepping for a show) — mapped, not coincidentally equal.
        client_class: full?.client_type === "prep" ? "competitor" : "lifestyle",
        parq_heart_condition: a.parq_heart_condition, parq_chest_pain: a.parq_chest_pain,
        parq_dizziness: a.parq_dizziness, parq_bone_joint: a.parq_bone_joint,
        parq_bp_meds: a.parq_bp_meds, parq_other_reason: a.parq_other_reason,
        pregnant: a.pregnant, eating_disorder_history: a.eating_disorder_history,
        medications: a.medications ?? "",
      };

      const missingBody = missingBodyMetrics(answers);
      if (missingBody.length) throw new ToolError(
        `not generated — missing body metrics: ${missingBody.join(", ")}. Not on the client's profile ` +
        `and not passed as arguments; these are facts about this specific person and cannot be defaulted.`,
      );
      const missingHealth = missingParq(answers);
      if (missingHealth.length) throw new ToolError(
        `not generated — every PAR-Q health-screen question must be answered explicitly, null is not ` +
        `the same as no: ${missingHealth.join(", ")}.`,
      );

      const plan = generatePlan(answers);

      const { data: cfg } = await sel(ctx, "tenant_config", "program_approval_gate").maybeSingle();
      const gateEnabled = cfg?.program_approval_gate ?? true;
      const status = plan.held ? "held_medical" : "draft";

      const ins = await insTenant(ctx, "program_drafts", {
        client_id: a.client_id, intake_id: null, status,
        training: plan.training, meal_plan: plan.meal_plan, macros: plan.macros,
        rationale: plan.rationale, health_flags: plan.health_flags, gate_enabled: gateEnabled,
      }).select("id, status").single();
      if (ins.error) throw new ToolError(ins.error.message);

      if (plan.held) {
        return {
          status: "held_medical", draft_id: ins.data.id, health_flags: plan.health_flags,
          message: "Health-screen flag raised — held for coach review. No plan auto-generated.",
        };
      }
      const targets = { calories: plan.macros.calories, protein_g: plan.macros.protein_g, fat_g: plan.macros.fat_g, carb_g: plan.macros.carb_g };
      if (gateEnabled === false) {
        const { data: pid, error } = await admin().rpc("publish_program_draft", { p_draft_id: ins.data.id });
        if (error) throw new ToolError("publish: " + error.message);
        return { status: "published", draft_id: ins.data.id, program_id: pid, gate: false, targets };
      }
      return {
        status: "draft_pending_approval", draft_id: ins.data.id, gate: true, targets,
        message: "Plan generated and queued as a pending draft for coach approval. Once approved, " +
          "assemble_meal_plan can build nutrition against these targets.",
      };
    },
  },
  {
    name: "get_meal_plan",
    description: "The client's current structured nutrition plan (assigned, else latest draft) plus day-0 slots and meal names/macros.",
    inputSchema: obj({ client_id: S.id }, ["client_id"]),
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const rows = (await sel(ctx, "client_meal_plans", F.mealPlan)
        .eq("client_id", a.client_id)
        .order("updated_at", { ascending: false })).data ?? [];
      const plan = rows.find((r: any) => r.status === "assigned")
        ?? rows.find((r: any) => r.status === "draft")
        ?? rows[0]
        ?? null;
      if (!plan) return { plan: null, slots: [] };
      const slots = (await sel(ctx, "client_meal_plan_slots", F.mealSlot)
        .eq("plan_id", plan.id).eq("day_index", 0)
        .order("slot_index")).data ?? [];
      const mealIds = [...new Set(slots.map((s: any) => s.meal_id).filter(Boolean))];
      let meals: any[] = [];
      if (mealIds.length) {
        const q = await admin().from("meals").select(F.meal)
          .in("id", mealIds)
          .eq("status", "published")
          .or(mealLibraryVisibilityFilter(ctx.tenantId, ctx.clientId));
        meals = q.data ?? [];
      }
      const byId = new Map(meals.map((m: any) => [m.id, m]));
      return {
        plan,
        slots: slots.map((s: any) => ({ ...s, meal: byId.get(s.meal_id) ?? null })),
      };
    },
  },
  {
    name: "get_nutrition_history",
    description:
      "Every structured nutrition plan this client has ever had — assigned, draft and archived — newest first, " +
      "with macro targets, slot counts and when each was released. Also surfaces any legacy jsonb-blob meal_plans " +
      "rows, labelled source:\"legacy\", so the two shapes are never conflated.",
    inputSchema: obj({ client_id: S.id, limit: S.limit }, ["client_id"]),
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const [plansS, slotsS, legacyS] = await Promise.all([
        section(sel(ctx, "client_meal_plans", F.mealPlan + ", updated_at, rotation_days, assembly_mode, substitution_policy")
          .eq("client_id", a.client_id).order("created_at", { ascending: false }).limit(a?.limit ?? 30), "client_meal_plans"),
        section(sel(ctx, "client_meal_plan_slots", "plan_id, day_index").eq("client_id", a.client_id).limit(2000), "plan_slots"),
        section(sel(ctx, "meal_plans", "id, title, calories, protein_g, fat_g, carb_g, status, created_at, assigned_at")
          .eq("client_id", a.client_id).order("created_at", { ascending: false }).limit(20), "legacy_meal_plans"),
      ]);
      if (!plansS.ok) throw new ToolError(plansS.unavailable);
      const plans = plansS.value as any[];
      const slotCount = new Map<string, number>(), dayCount = new Map<string, Set<number>>();
      for (const s of sectionRows(slotsS as Section<any[]>)) {
        slotCount.set(s.plan_id, (slotCount.get(s.plan_id) ?? 0) + 1);
        if (!dayCount.has(s.plan_id)) dayCount.set(s.plan_id, new Set());
        dayCount.get(s.plan_id)!.add(s.day_index);
      }
      return {
        client_id: a.client_id,
        current_assigned_plan_id: plans.find((p) => p.status === "assigned")?.id ?? null,
        plans: plans.map((p) => ({
          ...p, source: "structured",
          slots: slotsS.ok ? (slotCount.get(p.id) ?? 0) : null,
          days: slotsS.ok ? (dayCount.get(p.id)?.size ?? 0) : null,
        })),
        legacy_plans: legacyS.ok ? (legacyS.value as any[]).map((p) => ({ ...p, source: "legacy" })) : renderSection(legacyS),
        unavailable_sections: unavailableSections({ plan_slots: slotsS, legacy_meal_plans: legacyS }).length
          ? unavailableSections({ plan_slots: slotsS, legacy_meal_plans: legacyS })
          : null,
      };
    },
  },
  {
    name: "edit_meal_plan",
    description:
      "Change an existing nutrition plan in place instead of rebuilding it from scratch: swap the meal in a slot, " +
      "change servings, add a slot note, lock a slot, or adjust the plan's macro targets, title and notes. " +
      "Get slot ids from get_meal_plan and meal ids from list_meals. Editing an ASSIGNED plan changes what the " +
      "client sees immediately — the response says which. A draft still needs release_meal_plan.",
    inputSchema: obj({
      plan_id: S.id,
      slot_edits: {
        type: "array", minItems: 1, maxItems: 100,
        items: obj({
          slot_id: S.id,
          meal_id: { type: ["string", "null"], pattern: UUID_PATTERN, description: "null clears the slot" },
          servings: { type: "number", minimum: 0.1, maximum: 20 },
          note: { type: ["string", "null"], maxLength: 500 },
          is_locked: { type: "boolean" },
        }, ["slot_id"]),
      },
      targets: obj({
        calories: { type: ["number", "null"], minimum: 0, maximum: 10000 },
        protein_g: { type: ["number", "null"], minimum: 0, maximum: 1000 },
        fat_g: { type: ["number", "null"], minimum: 0, maximum: 1000 },
        carb_g: { type: ["number", "null"], minimum: 0, maximum: 2000 },
      }),
      title: { type: "string", maxLength: 200 },
      notes: { type: ["string", "null"], maxLength: 4000 },
    }, ["plan_id"]),
    write: true,
    run: async (ctx, a) => {
      const { data: plan } = await sel(ctx, "client_meal_plans", "id, client_id, status, title")
        .eq("id", a.plan_id).maybeSingle() as { data: any };
      if (!plan) throw notFound("meal plan");
      if (plan.status === "archived") throw new ToolError("this plan is archived — build a new one rather than editing history");

      const edits: any[] = Array.isArray(a.slot_edits) ? a.slot_edits : [];
      const results: any[] = [];
      if (edits.length) {
        // Slots must belong to THIS plan (and therefore this tenant) — a slot id from anywhere
        // else resolves to not-found rather than being written.
        const { data: slots, error: se } = await sel(ctx, "client_meal_plan_slots", "id, slot_label, meal_id")
          .eq("plan_id", plan.id).in("id", edits.map((e) => e.slot_id));
        if (se) throw new ToolError(se.message);
        const known = new Set(((slots ?? []) as any[]).map((s) => s.id));
        const stray = edits.map((e) => e.slot_id).filter((id) => !known.has(id));
        if (stray.length) throw new ToolError(`slot(s) not on this plan: ${stray.join(", ")}`);

        // Every incoming meal must be published and visible to this tenant — the same gate
        // list_meals and get_meal_plan apply. A coach cannot point a slot at another tenant's meal.
        const mealIds = [...new Set(edits.map((e) => e.meal_id).filter(Boolean))];
        if (mealIds.length) {
          const { data: meals, error: me } = await admin().from("meals").select("id")
            .in("id", mealIds).eq("status", "published").or(mealLibraryVisibilityFilter(ctx.tenantId, ctx.clientId));
          if (me) throw new ToolError(me.message);
          const ok = new Set(((meals ?? []) as any[]).map((m) => m.id));
          const bad = mealIds.filter((id) => !ok.has(id));
          if (bad.length) throw new ToolError(`meal(s) not available to this workspace (unpublished, or not yours): ${bad.join(", ")}`);
        }

        for (const e of edits) {
          const patch: Record<string, unknown> = {};
          if ("meal_id" in e) patch.meal_id = e.meal_id ?? null;
          if ("servings" in e) patch.servings = e.servings;
          if ("note" in e) patch.note = e.note ?? null;
          if ("is_locked" in e) patch.is_locked = e.is_locked;
          if (!Object.keys(patch).length) { results.push({ slot_id: e.slot_id, changed: false, reason: "no fields supplied" }); continue; }
          const { error } = await admin().from("client_meal_plan_slots")
            .update(patch).eq("id", e.slot_id).eq("tenant_id", ctx.tenantId).eq("plan_id", plan.id);
          // Per-slot outcome. A partial failure names which slots landed and which did not,
          // rather than reporting one blanket success over a half-applied edit.
          results.push(error ? { slot_id: e.slot_id, changed: false, error: error.message } : { slot_id: e.slot_id, changed: true, ...patch });
        }
      }

      const planPatch: Record<string, unknown> = {};
      if (a.title != null) planPatch.title = String(a.title).trim();
      if ("notes" in a) planPatch.notes = a.notes ?? null;
      for (const [k, col] of [["calories", "target_calories"], ["protein_g", "target_protein_g"], ["fat_g", "target_fat_g"], ["carb_g", "target_carb_g"]] as const) {
        if (a.targets && k in a.targets) planPatch[col] = a.targets[k];
      }
      if (Object.keys(planPatch).length) {
        planPatch.updated_at = new Date().toISOString();
        const { error } = await admin().from("client_meal_plans").update(planPatch)
          .eq("id", plan.id).eq("tenant_id", ctx.tenantId);
        if (error) throw new ToolError(error.message);
      }
      if (!results.length && !Object.keys(planPatch).length) {
        throw new ToolError("nothing to change — pass slot_edits, targets, title and/or notes");
      }
      const failed = results.filter((r) => r.error);
      return {
        plan_id: plan.id, client_id: plan.client_id, plan_status: plan.status,
        live_to_client: plan.status === "assigned",
        note: plan.status === "assigned"
          ? "This plan is assigned, so the client sees these changes now."
          : "This plan is still a draft — call release_meal_plan when it is ready.",
        slot_results: results,
        slots_changed: results.filter((r) => r.changed).length,
        slots_failed: failed.length,
        plan_fields_changed: Object.keys(planPatch).filter((k) => k !== "updated_at"),
      };
    },
  },
  {
    name: "create_custom_meal",
    description:
      "Add a coach-specific recipe to this workspace's meal library. Owned by this tenant and invisible to " +
      "every other one; list_meals and edit_meal_plan can use it immediately once published. " +
      "If any of kcal/protein_g/fat_g/carb_g is omitted, the meal is saved with macro_state 'incomplete' and " +
      "the response says so — macros are never estimated from the name.",
    inputSchema: obj({
      name: { type: "string", minLength: 1, maxLength: 120 },
      category: { type: "string", enum: ["breakfast", "chicken", "beef", "fish", "eggs", "carb_side", "vegetable", "no_cook", "freezer"] },
      kcal: { type: ["number", "null"], minimum: 0, maximum: 5000 },
      protein_g: { type: ["number", "null"], minimum: 0, maximum: 500 },
      fat_g: { type: ["number", "null"], minimum: 0, maximum: 500 },
      carb_g: { type: ["number", "null"], minimum: 0, maximum: 1000 },
      summary: { type: "string", maxLength: 500 },
      base_servings: { type: "integer", minimum: 1, maximum: 20 },
      serves_lifestyle: { type: "boolean" },
      serves_prep: { type: "boolean" },
      publish: { type: "boolean", description: "Default true. false keeps it as a private draft, unusable in plans." },
    }, ["name", "category"]),
    write: true,
    run: async (ctx, a) => {
      const name = String(a.name).trim();
      const macros = { kcal: a.kcal ?? null, protein_g: a.protein_g ?? null, fat_g: a.fat_g ?? null, carb_g: a.carb_g ?? null };
      const complete = Object.values(macros).every((v) => v != null);
      const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "meal";

      // meals has a unique index on (tenant_id, slug) for tenant-owned rows. Probe, then suffix.
      const { data: taken, error: te } = await admin().from("meals").select("slug")
        .eq("tenant_id", ctx.tenantId).like("slug", `${base}%`);
      if (te) throw new ToolError(te.message);
      const used = new Set(((taken ?? []) as any[]).map((r) => r.slug));
      let slug = base;
      for (let n = 2; used.has(slug) && n < 200; n += 1) slug = `${base}-${n}`;
      if (used.has(slug)) throw new ToolError(`too many meals already named like "${name}" — give it a more specific name`);

      const { data, error } = await insTenant(ctx, "meals", {
        slug, name, summary: a.summary?.trim() || null, category: a.category,
        base_servings: a.base_servings ?? 1,
        ...macros,
        macro_state: complete ? "manual" : "incomplete",
        serves_lifestyle: a.serves_lifestyle ?? true,
        serves_prep: a.serves_prep ?? false,
        status: a.publish === false ? "draft" : "published",
      }).select(F.meal + ", slug, status, macro_state").single();
      if (error) throw new ToolError(error.message);
      return {
        meal: data,
        owned_by: "this workspace only",
        note: complete
          ? undefined
          : "Saved with macro_state 'incomplete' because at least one macro was not given. It will not be " +
            "treated as a real macro source until those numbers come from somewhere real — they are not guessable from the name.",
      };
    },
  },
  {
    name: "list_meals",
    description: "Search the tenant meal library by name. Use before swapping a slot so you pick a real meal id.",
    inputSchema: obj({ query: { type: "string", minLength: 1 }, limit: S.limit }, ["query"]),
    run: async (ctx, a) => {
      const q = String(a.query).trim();
      const { data, error } = await admin().from("meals").select(F.meal)
        .ilike("name", `%${q}%`)
        // Service-role access bypasses RLS, so the tenant boundary must be
        // explicit here: published shared meals or published meals owned by
        // the authenticated tenant. Draft/retired rows stay private to the editor.
        .eq("status", "published")
        .or(mealLibraryVisibilityFilter(ctx.tenantId, ctx.clientId))
        .order("name")
        .limit(a?.limit ?? 20);
      if (error) throw new ToolError(error.message);
      return data ?? [];
    },
  },
  {
    name: "assemble_meal_plan",
    description: "Draft a new structured meal plan from the shared library. Does not release it — call release_meal_plan after you review get_meal_plan.",
    inputSchema: obj({
      client_id: S.id,
      meals_per_day: { type: "integer", minimum: 1, maximum: 8 },
      rotation_days: { type: "integer", minimum: 1, maximum: 14 },
    }, ["client_id"]),
    write: true,
    run: async (ctx, a) => {
      await ownedClient(ctx, a.client_id);
      const { data, error } = await admin().rpc("assemble_client_meal_plan", {
        p_client_id: a.client_id,
        p_meals_per_day: a.meals_per_day ?? null,
        p_rotation_days: a.rotation_days ?? null,
      });
      if (error) throw new ToolError(error.message);
      return data;
    },
  },
  {
    name: "release_meal_plan",
    description: "Publish a draft meal plan to the client's Nutrition tab. Archives the previously assigned plan.",
    inputSchema: obj({ plan_id: S.id }, ["plan_id"]),
    write: true,
    run: async (ctx, a) => {
      const { data: plan, error: e1 } = await sel(ctx, "client_meal_plans", "id, client_id, status")
        .eq("id", a.plan_id).maybeSingle();
      if (e1) throw new ToolError(e1.message);
      if (!plan) throw notFound("meal plan");
      if (plan.status !== "draft") throw new ToolError(`plan is ${plan.status}, not draft`);
      const now = new Date().toISOString();
      const { error: e2 } = await admin().from("client_meal_plans")
        .update({ status: "archived", updated_at: now })
        .eq("client_id", plan.client_id).eq("tenant_id", ctx.tenantId).eq("status", "assigned");
      if (e2) throw new ToolError(e2.message);
      const { data, error: e3 } = await admin().from("client_meal_plans")
        .update({ status: "assigned", assigned_at: now, updated_at: now })
        .eq("id", plan.id).eq("tenant_id", ctx.tenantId)
        .select("id, client_id, status, assigned_at").maybeSingle();
      if (e3) throw new ToolError(e3.message);
      return data;
    },
  },
  {
    name: "get_promo_video",
    description: "The current Coach Brief / welcome video URL for this tenant (YouTube, Vimeo, or .mp4).",
    inputSchema: obj(),
    run: async (ctx) => {
      const { data } = await sel(ctx, "tenant_config", "welcome_video_url, app_name").maybeSingle();
      return { url: data?.welcome_video_url ?? "", app_name: data?.app_name ?? null };
    },
  },
  {
    name: "set_promo_video",
    description: "Paste a YouTube, Vimeo, or direct .mp4 URL onto Coach Brief (same field as Settings → Welcome / homepage video). Empty string clears the plate.",
    inputSchema: obj({ url: { type: "string", description: "YouTube / Vimeo / .mp4 URL, or empty to clear" } }, ["url"]),
    write: true,
    run: async (ctx, a) => {
      const next = String(a.url ?? "").trim() || null;
      const { error } = await admin().from("tenant_config")
        .update({ welcome_video_url: next, updated_at: new Date().toISOString() })
        .eq("tenant_id", ctx.tenantId);
      if (error) throw new ToolError(error.message);
      return { url: next ?? "", saved: true };
    },
  },
  {
    name: "list_brief_slides",
    description:
      "The ordered slide strip on the Brief tab — the coach front door, mirrored read-only on every client's " +
      "front door. Returns public image URLs (the brand bucket is public marketing content, unlike progress " +
      "photos, which are private and always signed).",
    inputSchema: obj(),
    run: async (ctx) => {
      const rows = await must(
        sel(ctx, "brief_slides", F.briefSlide)
          .order("position", { ascending: true }).order("created_at", { ascending: true }),
        "list_brief_slides",
      ) as any[];
      return {
        slides: rows.map((s) => ({
          ...s,
          image_url: admin().storage.from("brand").getPublicUrl(s.image_path).data.publicUrl,
        })),
        max_slides: MAX_SLIDES,
      };
    },
  },
  {
    name: "add_brief_slide",
    description:
      "Add a still image to the Brief tab's slide strip from base64 content. Appends to the end unless " +
      `position (1-${MAX_SLIDES}) is given. mime_type must be one of: ${SLIDE_MIME_ALLOWLIST.join(", ")}; ` +
      `roughly 6 MB maximum; the strip is full at ${MAX_SLIDES}. Marketing content only — every client of ` +
      "this tenant sees the strip, so never a client's photo, name, or any other client PII.",
    inputSchema: obj({
      mime_type: { type: "string", enum: [...SLIDE_MIME_ALLOWLIST] },
      content_base64: { type: "string", minLength: 1 },
      caption: { type: ["string", "null"], maxLength: 200 },
      position: { type: "integer", minimum: 1, maximum: MAX_SLIDES },
    }, ["mime_type", "content_base64"]),
    write: true,
    run: async (ctx, a) => {
      const validation = validateSlideUpload(a);
      if (!validation.ok) throw new ToolError(validation.error);
      // The database enforces the cap and assigns the position atomically (migration
      // 20260830190000: insert trigger + per-tenant lock). No count pre-check here —
      // a read-then-insert check is exactly the race that migration closed.
      const path = slideStoragePath(ctx.tenantId, crypto.randomUUID(), a.mime_type);
      const bytes = Uint8Array.from(atob(a.content_base64), (c) => c.charCodeAt(0));
      const { error: uploadError } = await admin().storage.from("brand")
        .upload(path, bytes, { contentType: a.mime_type, upsert: false });
      if (uploadError) throw new ToolError(`upload failed: ${uploadError.message}`);
      const { data, error } = await insTenant(ctx, "brief_slides", {
        image_path: path, caption: a.caption?.trim() || null,
      }).select(F.briefSlide).single();
      if (error) {
        // The image reached storage but the row didn't (e.g. the trigger's full-at-12
        // refusal) — remove the orphan, report the real failure.
        await admin().storage.from("brand").remove([path]).then(() => {}, () => {});
        throw new ToolError(error.message);
      }
      let slide = data as any;
      if (a.position !== undefined) {
        slide = await placeSlideAt(ctx, slide.id, Number(a.position));
      }
      return {
        added: true,
        slide: { ...slide, image_url: admin().storage.from("brand").getPublicUrl(path).data.publicUrl },
      };
    },
  },
  {
    name: "update_brief_slide",
    description:
      `Change a Brief slide's caption and/or position (1-${MAX_SLIDES}). Moving a slide SHIFTS the ` +
      "others — the whole strip is atomically renumbered, so there are never duplicate positions.",
    inputSchema: obj({
      slide_id: S.id,
      caption: { type: ["string", "null"], maxLength: 200 },
      position: { type: "integer", minimum: 1, maximum: MAX_SLIDES },
    }, ["slide_id"]),
    write: true,
    run: async (ctx, a) => {
      if (a.caption === undefined && a.position === undefined) {
        throw new ToolError("nothing to change — pass caption and/or position");
      }
      let slide: any = null;
      if (a.caption !== undefined) {
        const { data, error } = await admin().from("brief_slides")
          .update({ caption: a.caption?.trim() || null, updated_at: new Date().toISOString() })
          .eq("id", a.slide_id).eq("tenant_id", ctx.tenantId).select(F.briefSlide).maybeSingle();
        if (error) throw new ToolError(error.message);
        if (!data) throw notFound("slide");
        slide = data;
      }
      if (a.position !== undefined) {
        slide = await placeSlideAt(ctx, String(a.slide_id), Number(a.position));
      }
      return { updated: true, slide };
    },
  },
  {
    name: "remove_brief_slide",
    description: "Remove a slide from the Brief strip and delete its image file.",
    inputSchema: obj({ slide_id: S.id }, ["slide_id"]),
    write: true,
    run: async (ctx, a) => {
      const { data, error } = await admin().from("brief_slides").delete()
        .eq("id", a.slide_id).eq("tenant_id", ctx.tenantId).select("id, image_path").maybeSingle();
      if (error) throw new ToolError(error.message);
      if (!data) throw notFound("slide");
      // Best-effort: the row is the source of truth; a stray file in the public
      // marketing bucket is cosmetic and stated rather than silently ignored.
      const removal = await admin().storage.from("brand").remove([data.image_path])
        .then(() => null, (e: Error) => e.message || "storage removal failed");
      return { removed: true, image_file_removed: removal == null, ...(removal ? { image_file_note: removal } : {}) };
    },
  },
];

// Client-token surface: read-only, own data only (sel() pins client_id).
const CLIENT_TOOLS: Tool[] = [
  {
    name: "my_profile",
    description: "The client's own coaching profile (tier, status).",
    inputSchema: obj(),
    run: async (ctx) => (await sel(ctx, "clients", "id, display_name, status, coaching_tier").maybeSingle()).data,
  },
  {
    name: "my_program",
    description:
      "The client's active program: full structure plus current day position. current_day_index indexes into " +
      "current_day_order (the order the client actually walks this block in, which can differ from the " +
      "program's own day list order after a schedule adjustment), not into program.structure.days directly — " +
      "current_day is that resolved day, already picked out for convenience.",
    inputSchema: obj(),
    run: async (ctx) => {
      const a = (await sel(ctx, "assignments", F.assignment).eq("active", true).maybeSingle()).data as any;
      if (!a) return { active_program: null };
      const p = (await admin().from("programs").select("id, name, structure").eq("id", a.program_id).eq("tenant_id", ctx.tenantId).maybeSingle()).data;
      // Resolved per assignment.day_order (client schedule adjustments) when set,
      // else the program's own order — see effectiveDays.ts.
      const { days } = resolveEffectiveDays(p as any, a);
      return {
        program: p,
        current_day_index: a.current_day_index,
        current_day_order: days.map((d: any) => d?.day_id ?? null),
        current_day: days[a.current_day_index] ?? null,
      };
    },
  },
  {
    name: "my_workouts",
    description: "The client's own workout history (sessions with per-set actuals), newest first.",
    inputSchema: obj({ limit: S.limit }),
    run: async (ctx, a) => (await sel(ctx, "workout_sessions", F.session)
      .order("session_date", { ascending: false }).limit(a?.limit ?? 15)).data ?? [],
  },
  {
    name: "my_checkins",
    description: "The client's own check-ins, newest first.",
    inputSchema: obj({ limit: S.limit }),
    run: async (ctx, a) => (await sel(ctx, "checkins", F.checkin)
      .order("submitted_at", { ascending: false }).limit(a?.limit ?? 20)).data ?? [],
  },
  {
    name: "my_messages",
    description: "The client's message thread with their coach, oldest first.",
    inputSchema: obj({ limit: S.limit }),
    run: async (ctx, a) => (await sel(ctx, "messages", F.message)
      .order("sent_at", { ascending: true }).limit(a?.limit ?? 50)).data ?? [],
  },
  {
    name: "my_schedule",
    description:
      "The client's calendar view: planned program days projected forward (same projection as the app's calendar), upcoming check-in due dates, program block end, and show-day countdown. days_ahead defaults to 14 (max 60). States are explicit: planned.state 'not_tracked' means no active program — not a rest week — and checkins.state 'not_scheduled' means the system has no schedule for this client, not that nothing is due.",
    inputSchema: obj({ days_ahead: { type: "integer", minimum: 1, maximum: 60 } }),
    run: async (ctx, a) => {
      const daysAhead = a?.days_ahead ?? 14;
      const today = new Date();
      const toDate = new Date(today);
      toDate.setDate(toDate.getDate() + daysAhead - 1);

      const assignment = (await sel(ctx, "assignments", F.assignmentSchedule).eq("active", true).maybeSingle()).data;
      const program = assignment
        ? (await admin().from("programs").select("id, name, structure").eq("id", assignment.program_id).eq("tenant_id", ctx.tenantId).maybeSingle()).data
        : null;
      const client = (await sel(ctx, "clients", F.client).maybeSingle()).data;
      const scheduleRows = (await sel(ctx, "client_checkin_schedule", F.checkinSchedule)
        .gte("due_on", ymdUtc(today)).lte("due_on", ymdUtc(toDate)).order("due_on")).data ?? [];

      return {
        ...buildForwardSchedule({ today, fromDate: today, toDate, program, assignment, scheduleRows, client }),
        as_of: ymdUtc(today),
      };
    },
  },
  {
    name: "my_progress",
    description:
      "The client's progress trends: weight series (weigh-ins recorded with check-ins), best-set strength series per current-program exercise, and the promises-kept consistency metric (consecutive weeks meeting the program's training-day target). Fields with state 'not_tracked' were never instrumented for this client and must not be read as zeros.",
    inputSchema: obj({}),
    run: async (ctx) => {
      const [weightRows, checkinWeightRows, workoutLogRows, assignment] = await Promise.all([
        sel(ctx, "progress_weights", F.weight).order("date", { ascending: true }).then((r) => r.data ?? []),
        sel(ctx, "checkins", F.checkinWeight).not("weight", "is", null).then((r) => r.data ?? []),
        sel(ctx, "workout_logs", F.workoutLogTrend).then((r) => r.data ?? []),
        sel(ctx, "assignments", F.assignment).eq("active", true).maybeSingle().then((r) => r.data),
      ]);

      const sessionIds = [...new Set((workoutLogRows as any[]).map((l) => l.session_id))];
      const sessionDateById: Record<string, string> = {};
      if (sessionIds.length > 0) {
        const { data: sessions } = await sel(ctx, "workout_sessions", F.sessionDateOnly).in("id", sessionIds);
        for (const s of (sessions ?? []) as any[]) sessionDateById[s.id] = s.session_date;
      }

      const program = assignment
        ? (await admin().from("programs").select("structure").eq("id", (assignment as any).program_id).eq("tenant_id", ctx.tenantId).maybeSingle()).data
        : null;
      const days = Array.isArray((program as any)?.structure?.days) ? (program as any).structure.days : [];
      const programExerciseNameById: Record<string, string> = {};
      for (const d of days as any[]) for (const g of d.groups ?? []) for (const ex of g.exercises ?? []) programExerciseNameById[ex.exercise_id] = ex.name;

      const sessionQuery = sel(ctx, "workout_sessions", F.sessionConsistency);
      const assignedAt = (assignment as any)?.assigned_at ?? null;
      const { data: sessionsForConsistency } = assignedAt
        ? await sessionQuery.gte("session_date", String(assignedAt).slice(0, 10))
        : await sessionQuery;

      return {
        ...buildProgressTrends({ weightRows: weightRows as any, checkinWeightRows: checkinWeightRows as any, workoutLogRows: workoutLogRows as any, sessionDateById, programExerciseNameById }),
        consistency: computeConsistency({ today: new Date(), sessions: (sessionsForConsistency ?? []) as any, programDays: days, assignedAt }),
      };
    },
  },
  // ---- comms/logging writes (scope=comms) — the ENTIRE client write surface. ----
  // These relay the client's own actions: messages, set logs, day completion. They touch
  // ONLY messages / workout_sessions / workout_logs / the day-advance on assignments —
  // never programs, meal plans, or which program is assigned.
  {
    name: "message_coach",
    description: "Send a message to your coach (appears in their inbox as you).",
    inputSchema: obj({ body: { type: "string", minLength: 1, maxLength: 2000 } }, ["body"]),
    write: true,
    needsCoach: true,
    run: async (ctx, a) => {
      const { error } = await insTenant(ctx, "messages", { client_id: ctx.clientId, sender_role: "client", body: a.body });
      if (error) throw new ToolError(error.message);
      return { sent: true };
    },
  },
  {
    name: "flag_issue",
    description: "Flag something that needs the coach's attention (pain/injury, missed sessions, plan concerns). Sends a clearly AI-attributed priority message to the coach.",
    inputSchema: obj({
      topic: { type: "string", minLength: 1, maxLength: 120 },
      detail: { type: "string", maxLength: 2000 },
    }, ["topic"]),
    write: true,
    needsCoach: true,
    run: async (ctx, a) => {
      const body = `⚠️ Issue flagged (sent by my AI): ${String(a.topic).trim()}${a.detail ? ` — ${String(a.detail).trim()}` : ""}`;
      const { error } = await insTenant(ctx, "messages", { client_id: ctx.clientId, sender_role: "client", body });
      if (error) throw new ToolError(error.message);
      return { flagged: true };
    },
  },
  {
    name: "log_workout_sets",
    description: "Log set actuals (weight × reps) for the CURRENT training day of your active program. Starts (or resumes) today's session exactly like the app's Start-workout button. Sets default to NOT done unless done:true is passed, and a done:true set must carry an actual weight or reps — an empty 'done' set is refused, not silently invented. Use exercise_ids from my_program; set_index is 0-based.",
    inputSchema: obj({
      sets: {
        type: "array", minItems: 1, maxItems: 60,
        items: obj({
          exercise_id: S.id,
          set_index: { type: "integer", minimum: 0 },
          weight: { type: ["number", "null"] },
          reps: { type: ["integer", "null"] },
          done: { type: "boolean" },
        }, ["exercise_id", "set_index"]),
      },
    }, ["sets"]),
    write: true,
    run: async (ctx, a) => {
      const { assignment, program } = await myActiveAssignment(ctx);
      // Resolved per assignment.day_order (client schedule adjustments) when set,
      // else the program's own order — see effectiveDays.ts.
      const { days } = resolveEffectiveDays(program as any, assignment as any);
      const day = days[assignment.current_day_index];
      if (!day) throw new ToolError(`no day at index ${assignment.current_day_index}`);
      if (day.kind !== "training") throw new ToolError("the current day is a rest day — nothing to log. Use complete_current_day to acknowledge it.");
      const setsPerExercise = new Map<string, number>();
      for (const g of day.groups ?? []) for (const ex of g.exercises ?? []) setsPerExercise.set(ex.exercise_id, (ex.sets ?? []).length);
      if (!Array.isArray(a.sets) || a.sets.length === 0) throw new ToolError("sets must be a non-empty array");
      for (const s of a.sets) {
        const n = setsPerExercise.get(s?.exercise_id);
        if (n === undefined) throw new ToolError(`exercise ${s?.exercise_id} is not in today's workout (${day.label ?? "current day"}) — use my_program`);
        if (!Number.isInteger(s.set_index) || s.set_index < 0 || s.set_index >= n)
          throw new ToolError(`set_index ${s.set_index} out of range for that exercise (0–${n - 1})`);
        const doneErr = earnedDoneError(s);
        if (doneErr) throw new ToolError(doneErr);
      }
      // Same idempotent (assignment_id, day_id) upsert the app's Start-workout uses.
      const { data: session, error: se } = await admin().from("workout_sessions")
        .upsert({ tenant_id: ctx.tenantId, client_id: ctx.clientId, assignment_id: assignment.id, day_id: day.day_id },
          { onConflict: "assignment_id,day_id" })
        .select("id").single();
      if (se) throw new ToolError(se.message);
      const { error: le } = await admin().from("workout_logs").upsert(
        a.sets.map((s: any) => ({
          tenant_id: ctx.tenantId, client_id: ctx.clientId, session_id: session.id,
          exercise_id: s.exercise_id, set_index: s.set_index,
          weight: s.weight == null ? null : Number(s.weight),
          reps: s.reps == null ? null : Number(s.reps),
          done: s.done ?? false, updated_at: new Date().toISOString(),
        })),
        { onConflict: "session_id,exercise_id,set_index" },
      );
      if (le) throw new ToolError(le.message);
      return { session_id: session.id, day_label: day.label ?? null, logged_sets: a.sets.length };
    },
  },
  {
    name: "complete_current_day",
    description: "Finish the current program day — exactly the app's Finish-workout / Complete-rest-day button. Pass the current day's day_id from my_program as confirmation. Training days need their sets logged first (log_workout_sets); the final day closes the block and cycles back to day 1. Re-completing an already-closed day is a safe no-op.",
    inputSchema: obj({ day_id: S.id }, ["day_id"]),
    write: true,
    run: async (ctx, a) => {
      const { assignment, program } = await myActiveAssignment(ctx);
      const res = await closeDayCore(admin(), assignment, program, a.day_id);
      if (!res.ok) throw new ToolError(res.error);
      return res.body;
    },
  },
  // ---- owner writes (scope=owner; self-serve tenants only — DB trigger guarantees the
  //      token cannot exist elsewhere). Every tool touches ONLY this client's own rows. ----
  {
    name: "update_my_program",
    description: "Replace YOUR training week (days, exercises, sets/reps). Reuse day_id/exercise_id uuids from my_program verbatim — they anchor your logged history; dropping ids is refused unless allow_removals is true. Self-serve owner tokens only.",
    inputSchema: obj({ structure: { type: "object" }, allow_removals: { type: "boolean" } }, ["structure"]),
    write: true, scope: "owner",
    run: async (ctx, a) => {
      const { assignment, program } = await myActiveAssignment(ctx);
      const { data: others } = await admin().from("assignments").select("id").eq("program_id", program.id).neq("client_id", ctx.clientId!).limit(1);
      if ((others ?? []).length) throw new ToolError("this program is shared with another client and cannot be edited from a client token");
      const next = validateStructure(a.structure);
      const missing = [...structureIds(program.structure)].filter((id) => !structureIds(next).has(id));
      if (missing.length && !a.allow_removals)
        throw new ToolError(`edit drops ${missing.length} existing day/exercise id(s) — your history for them would show as removed. Reuse the ids from my_program, or pass allow_removals: true.`);
      const { error } = await admin().from("programs").update({ structure: next }).eq("id", program.id).eq("tenant_id", ctx.tenantId);
      if (error) throw new ToolError(error.message);
      return { updated: true, assignment_id: assignment.id, ...structureSummary(next) };
    },
  },
  {
    name: "set_my_macros",
    description: "Set calorie and macro targets on YOUR assigned meal plan. All four numbers required. Floors: calories by sex (1300 F / 1600 M) and protein at 1.6 g per kg of your current weight; sub-floor values are refused with the floor named, never clamped. Self-serve owner tokens only.",
    inputSchema: obj({ target_calories: { type: "number" }, target_protein_g: { type: "number" }, target_fat_g: { type: "number" }, target_carb_g: { type: "number" } },
      ["target_calories", "target_protein_g", "target_fat_g", "target_carb_g"]),
    write: true, scope: "owner",
    run: async (ctx, a) => {
      // Both floors come from the client's OWN entered facts — sex for calories, current
      // weight for protein (1.6 g/kg, see mealMacros.ts). Nothing is defaulted (THE GATE):
      // a missing fact is a refusal that names what to enter.
      const { data: clientRow } = await admin().from("clients").select("sex, weight_kg").eq("id", ctx.clientId!).eq("tenant_id", ctx.tenantId).maybeSingle();
      const sex = clientRow?.sex ?? null;
      if (!sex) throw new ToolError("sex is not set on your profile — set it in Settings, then retry");
      const proteinFloor = proteinFloorG(clientRow?.weight_kg);
      if (proteinFloor === null) throw new ToolError("current weight is not set on your profile — Settings → Update my numbers, then retry");
      const kg = Number(clientRow!.weight_kg);
      const floors = {
        kcal: CALORIE_FLOOR_BY_SEX[sex === "female" ? "female" : "male"],
        protein_g: proteinFloor,
        protein_basis: `${PROTEIN_FLOOR_PER_KG} g per kg of your ${Math.round(kg * 10) / 10} kg`,
      };
      const r = macroTargetsOrError(a, floors);
      if (!r.ok) throw new ToolError(r.error);
      const { data: plan } = await admin().from("client_meal_plans").select("id").eq("client_id", ctx.clientId!).eq("tenant_id", ctx.tenantId).eq("status", "assigned").maybeSingle();
      if (!plan) throw new ToolError("no assigned meal plan — run regenerate_my_plan or finish your intake first");
      const { error } = await admin().from("client_meal_plans").update({ ...r.targets, updated_at: new Date().toISOString() }).eq("id", plan.id);
      if (error) throw new ToolError(error.message);
      return { updated: true, meal_plan_id: plan.id, ...r.targets };
    },
  },
  {
    name: "set_my_meals",
    description: "Fill or swap slots on YOUR assigned meal plan with meals from the library or your own custom meals (see add_my_meal). Pass slot_id from my_meal_plan and a meal_id you can see; a meal outside your visibility resolves to not-found. Self-serve owner tokens only.",
    inputSchema: obj({ assignments: { type: "array", minItems: 1, maxItems: 40, items: obj({ slot_id: S.id, meal_id: S.id }, ["slot_id", "meal_id"]) } }, ["assignments"]),
    write: true, scope: "owner",
    run: async (ctx, a) => {
      const { data: plan } = await admin().from("client_meal_plans").select("id").eq("client_id", ctx.clientId!).eq("tenant_id", ctx.tenantId).eq("status", "assigned").maybeSingle();
      if (!plan) throw new ToolError("no assigned meal plan");
      const mealIds = [...new Set(a.assignments.map((x: any) => x.meal_id))];
      const { data: visible } = await admin().from("meals").select("id").in("id", mealIds).eq("status", "published").or(mealLibraryVisibilityFilter(ctx.tenantId, ctx.clientId));
      const ok = new Set((visible ?? []).map((m: any) => m.id));
      const bad = mealIds.filter((id) => !ok.has(id));
      if (bad.length) throw new ToolError(`meal(s) not found: ${bad.join(", ")}`);
      const slotIds = a.assignments.map((x: any) => x.slot_id);
      const { data: slots } = await admin().from("client_meal_plan_slots").select("id").in("id", slotIds)
        .eq("plan_id", plan.id).eq("client_id", ctx.clientId!).eq("tenant_id", ctx.tenantId);
      const owned = new Set((slots ?? []).map((s: any) => s.id));
      const foreign = slotIds.filter((id: string) => !owned.has(id));
      if (foreign.length) throw new ToolError(`slot(s) not on your plan: ${foreign.join(", ")}`);
      for (const x of a.assignments) {
        const { error } = await admin().from("client_meal_plan_slots").update({ meal_id: x.meal_id })
          .eq("id", x.slot_id).eq("client_id", ctx.clientId!).eq("tenant_id", ctx.tenantId);
        if (error) throw new ToolError(error.message);
      }
      return { updated: a.assignments.length, meal_plan_id: plan.id };
    },
  },
  {
    name: "add_my_meal",
    description: "Create a custom meal of your own (e.g. a restaurant order). Give a name and, if you know them, kcal/protein_g/fat_g/carb_g. Missing macros save the meal as incomplete — nothing is estimated for you. Category is optional and defaults to custom. Only you can see your custom meals; they show without a photo. Self-serve owner tokens only.",
    inputSchema: obj({ name: { type: "string" }, category: { type: "string" }, summary: { type: "string" }, kcal: { type: "number" }, protein_g: { type: "number" }, fat_g: { type: "number" }, carb_g: { type: "number" } }, ["name"]),
    write: true, scope: "owner",
    run: async (ctx, a) => {
      let built; try { built = customMealRow(a, { tenantId: ctx.tenantId, clientId: ctx.clientId! }); } catch (e) { throw new ToolError((e as Error).message); }
      const { data, error } = await admin().from("meals").insert(built.row).select("id, macro_state").single();
      if (error) throw new ToolError(error.message);
      return { meal_id: data.id, macro_state: data.macro_state, note: data.macro_state === "incomplete" ? "saved without complete macros — it will not count toward targets until all four are set" : null };
    },
  },
  {
    name: "regenerate_my_plan",
    description: "Rebuild YOUR week and targets from new inputs. Re-asks the health screen: every PAR-Q answer must be given again; any yes holds the plan and points to coaching. Allowed once every 28 days. Self-serve owner tokens only.",
    inputSchema: obj({
      answers: { type: "object", description: "Full intake answers: sex, age, height_cm, weight_kg, goal, days_per_week, equipment, experience, unit_pref, height_raw, weight_raw, injuries, plus every PAR-Q key (parq_heart_condition, parq_chest_pain, parq_dizziness, parq_bone_joint, parq_bp_meds, parq_other_reason, pregnant, eating_disorder_history) and optional medications." },
    }, ["answers"]),
    write: true, scope: "owner",
    run: async (ctx, a) => {
      const { data: token, error: tErr } = await admin().rpc("mint_intake_token_for_client", { p_client_id: ctx.clientId });
      if (tErr) {
        const m = tErr.message || "";
        if (m.includes("too_soon:")) throw new ToolError(`you can regenerate again on ${m.split("too_soon:")[1].slice(0, 10)}`);
        throw new ToolError(m);
      }
      const res = await fetch(`${SUPABASE_URL}/functions/v1/intake-submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ token, answers: a.answers }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new ToolError(out?.error || `intake-submit ${res.status}`);
      return out; // { status: published|held_medical, program_id?, meal_plan_id?, meal_plan_error?, health_flags? }
    },
  },
];

// The client's active assignment + its program, both tenant/client-pinned. Full rows:
// closeDayCore needs tenant_id/client_id/program_id for the cycle handoff.
async function myActiveAssignment(ctx: Ctx): Promise<{ assignment: any; program: any }> {
  const { data: assignment } = await sel(ctx, "assignments", "*").eq("active", true).maybeSingle() as { data: any };
  if (!assignment) throw new ToolError("no active program assignment");
  const { data: program } = await admin().from("programs").select("id, name, structure")
    .eq("id", assignment.program_id).eq("tenant_id", ctx.tenantId).maybeSingle();
  if (!program) throw new ToolError("program missing");
  return { assignment, program };
}

const toolsFor = (ctx: Ctx) => (ctx.kind === "client" ? CLIENT_TOOLS : COACH_TOOLS);

// Audit fixed per-tool structural metadata. Caller-controlled field names and
// free text are discarded; ID fields survive only when they are valid UUIDs.
// On failure the server-generated reason is recorded too — see safety.ts.
async function audit(ctx: Ctx, tool: string, args: any, ok: boolean, errorMessage?: string) {
  const summary = summarizeAuditArguments(tool, args, ok, errorMessage);
  await insTenant(ctx, "connector_audit", { token_id: ctx.tokenId, tool, summary }).then(() => {}, () => {});
}

// ---------- JSON-RPC ----------
const rpcResult = (id: unknown, result: unknown) => jres({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => jres({ jsonrpc: "2.0", id, error: { code, message } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: MCP_CORS });

  // OAuth discovery / handshake sub-paths are served before the MCP token gate.
  const oauth = await handleOAuth(req);
  if (oauth) return oauth;

  if (req.method !== "POST")
    return jres({ ok: true, service: "mcp", hint: "MCP Streamable HTTP endpoint — connect with a POSTing MCP client and a connector token" }, 405);

  const ctx = await authenticate(req);
  if (!ctx)
    return new Response(JSON.stringify({ error: "valid connector token required" }),
      { status: 401, headers: { ...MCP_CORS, "Content-Type": "application/json", "WWW-Authenticate": `Bearer resource_metadata="${RESOURCE_METADATA_URL}"` } });

  let msg: any;
  try { msg = await req.json(); } catch { return rpcError(null, -32700, "parse error"); }
  if (Array.isArray(msg)) return rpcError(null, -32600, "batching not supported");
  const { id, method, params } = msg ?? {};
  if (typeof method !== "string") return rpcError(id ?? null, -32600, "invalid request");

  // Notifications (no id) are acknowledged and ignored — stateless server.
  if (method.startsWith("notifications/") || id === undefined || id === null)
    return new Response(null, { status: 202, headers: MCP_CORS });

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: toolsFor(ctx)
          .filter((t) => canUseTool(ctx.kind, ctx.scope, Boolean(t.write), t.scope))
          .filter((t) => !hiddenWithoutCoach(ctx.selfServe, t.needsCoach))
          .map(({ name, description, inputSchema, write }) => ({
            name,
            description,
            inputSchema,
            annotations: { readOnlyHint: !write },
          })),
      });
    case "tools/call": {
      const tool = toolsFor(ctx).find((t) => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${params?.name}`);
      if (!canUseTool(ctx.kind, ctx.scope, Boolean(tool.write), tool.scope)) {
        const text = ctx.kind === "client"
          ? ctx.scope === "comms" && tool.scope === "owner"
            ? "This connection is read + relay only. Full control (owner) tokens are self-serve-only, from the Connect-your-own-AI section of your app."
            : "This connection is read-only. Create a “read + relay” token from the Connect-your-own-AI section of your app to let your AI message your coach and log workouts."
          : "This connection is read-only. Prepare a finding, draft, or proposal for the coach to review in the app; new coach action tokens are not issued.";
        return rpcResult(id, { content: [{ type: "text", text }], isError: true });
      }
      if (hiddenWithoutCoach(ctx.selfServe, tool.needsCoach)) {
        await audit(ctx, tool.name, params?.arguments ?? {}, false, "refused: tenant has no coach");
        return rpcResult(id, { content: [{ type: "text", text: NO_COACH_TEXT }], isError: true });
      }
      const args = params?.arguments ?? {};
      const argumentError = validateToolArguments(tool.inputSchema, args);
      if (argumentError) {
        await audit(ctx, tool.name, args, false, `invalid arguments: ${argumentError}`);
        return rpcResult(id, { content: [{ type: "text", text: `invalid arguments: ${argumentError}` }], isError: true });
      }
      try {
        const result = await tool.run(ctx, args);
        await audit(ctx, tool.name, args, true);
        return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] });
      } catch (e) {
        const text = e instanceof ToolError ? e.message : "internal error: " + (e as Error).message;
        await audit(ctx, tool.name, args, false, text);
        return rpcResult(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
});
