// trainerize-import — ingest a Trainerize export (contract v1.0.0)
// into the coachapp schema. Insert-only and idempotent:
// re-running the same payload yields all "already imported" skips. Never creates auth
// users, never updates coach-curated data, never deletes anything.
//
// Auth (self-handled; verify_jwt=false): EITHER a coach JWT (role=coach in profiles)
// OR a coach-kind read_write connector token — the same credential the MCP layer uses,
// which keeps bulk-migration scripting on the established token model. Tenant comes
// from the credential, never from the payload.
//
// POST { trainerize_export, trainerize_client_id, dry_run? }
// GET → health check.
import { admin, callerUserId, json, CORS } from "../_shared/challenge.ts";
import {
  isSchemaCompatible, mapClientRow,
  mapProgramStructure, programName, extractStructureTzId,
  mapCheckinRow, mapProgressWeightRow, mapArchiveSession, mapArchiveMeal,
  buildPhotoPath, decodePhotoBase64, mapProgressPhotoRow,
  mapMessageRow, messageDedupKey, PHOTOS_BUCKET,
} from "../_shared/trainerize.ts";

type Ctx = { tenantId: string; weightUnit: string; tokenId: string | null };
const DRY_ID = "00000000-0000-0000-0000-000000000000";

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Coach JWT or coach read_write connector token → tenant context.
async function authenticate(req: Request): Promise<Ctx | { error: Response }> {
  const db = admin();
  const authz = req.headers.get("Authorization") || "";
  const bearer = authz.startsWith("Bearer ") ? authz.slice(7).trim() : "";
  let tenantId: string | null = null, tokenId: string | null = null;

  if (bearer.startsWith("coach_mcp_")) {
    const { data: t } = await db.from("connector_tokens")
      .select("id, tenant_id, kind, scope, revoked_at")
      .eq("token_hash", await sha256hex(bearer)).maybeSingle();
    if (!t || t.revoked_at) return { error: json({ error: "invalid connector token" }, 401) };
    if (t.kind !== "coach" || t.scope !== "read_write")
      return { error: json({ error: "import requires a coach read_write connector token" }, 403) };
    tenantId = t.tenant_id; tokenId = t.id;
  } else {
    const userId = await callerUserId(req);
    if (!userId) return { error: json({ error: "authentication required" }, 401) };
    const { data: prof } = await db.from("profiles").select("role, tenant_id").eq("user_id", userId).maybeSingle();
    if (!prof || prof.role !== "coach") return { error: json({ error: "coach only" }, 403) };
    tenantId = prof.tenant_id;
  }

  const { data: cfg } = await db.from("tenant_config").select("weight_unit").eq("tenant_id", tenantId!).maybeSingle();
  return { tenantId: tenantId!, weightUnit: cfg?.weight_unit ?? "lb", tokenId };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "trainerize-import" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = await authenticate(req);
  if ("error" in auth) return auth.error;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const exp = body?.trainerize_export;
  const tzClientId = body?.trainerize_client_id;
  const dryRun = Boolean(body?.dry_run);

  // Contract guards, ported verbatim from the original.
  if (!exp) return json({ error: "trainerize_export required" }, 400);
  if (!tzClientId) return json({ error: "trainerize_client_id required" }, 400);
  if (!isSchemaCompatible(exp._schema_version))
    return json({ error: `Unsupported _schema_version "${exp._schema_version}". Supported major: 1.x.x.` }, 400);
  if (!exp.client?.email) return json({ error: "client.email required" }, 400);
  if (exp.client.trainerize_id !== tzClientId)
    return json({ error: `trainerize_client_id "${tzClientId}" does not match client.trainerize_id "${exp.client.trainerize_id}"` }, 400);

  try {
    const result = await runImport(auth as Ctx, exp, dryRun);
    if ((auth as Ctx).tokenId) {
      await admin().from("connector_audit").insert({
        tenant_id: (auth as Ctx).tenantId, token_id: (auth as Ctx).tokenId,
        tool: "trainerize_import", summary: { ok: true, dry_run: dryRun, client: exp.client.email, ...result.imported },
      }).then(() => {}, () => {});
    }
    return json(result);
  } catch (e) {
    return json({ status: "failed", error: (e as Error).message }, 500);
  }
});

// ─── core ───────────────────────────────────────────────────────────────
async function runImport(ctx: Ctx, payload: any, dryRun: boolean) {
  const db = admin();
  const warnings: string[] = [];
  const skipped: Record<string, any[]> = {
    programs: [], sessions: [], checkins: [], meals: [], meal_adherence: [], photos: [], messages: [],
  };
  const imported: Record<string, number> = {
    programs: 0, sessions: 0, checkins: 0, meals: 0, meal_adherence: 0, photos: 0, messages: 0,
  };
  if (ctx.weightUnit !== "kg") warnings.push(`weights converted kg → ${ctx.weightUnit} (tenant setting); archive payloads keep original kg`);

  // 1) Resolve / create the clients row (tenant + lower(email) natural key; no auth user).
  const email = String(payload.client.email).trim().toLowerCase();
  const { data: existingClients } = await db.from("clients").select("id, display_name, email").eq("tenant_id", ctx.tenantId);
  const existing = (existingClients ?? []).find((c: any) => (c.email ?? "").toLowerCase() === email);
  let clientId: string, clientCreated = false;
  if (existing) {
    clientId = existing.id;
    if (!existing.display_name && payload.client.name && !dryRun)
      await db.from("clients").update({ display_name: payload.client.name.trim() }).eq("id", clientId);
  } else if (dryRun) {
    clientId = DRY_ID;
    clientCreated = true;
  } else {
    const { data, error } = await db.from("clients")
      .insert({ ...mapClientRow(payload.client), tenant_id: ctx.tenantId, origin: "trainerize_import" }).select("id").single();
    if (error) throw new Error("client insert failed: " + error.message);
    clientId = data.id; clientCreated = true;
  }
  if (payload.client.starting_height_cm != null)
    warnings.push("client.starting_height_cm: no column — value retained in raw payload only");

  // 2) Programs → canonical structure (dedup on structure._meta.trainerize_id per tenant).
  const { data: tenantPrograms } = await db.from("programs").select("id, structure").eq("tenant_id", ctx.tenantId);
  const existingProgramTz = new Set((tenantPrograms ?? []).map((p: any) => extractStructureTzId(p.structure)).filter(Boolean));
  for (const p of payload.programs ?? []) {
    if (!p.trainerize_id) { skipped.programs.push({ reason: "missing trainerize_id" }); continue; }
    if (existingProgramTz.has(p.trainerize_id)) {
      skipped.programs.push({ trainerize_id: p.trainerize_id, reason: "already imported (matching _meta.trainerize_id)" });
      continue;
    }
    existingProgramTz.add(p.trainerize_id);
    if (!dryRun) {
      const { error } = await db.from("programs").insert({
        tenant_id: ctx.tenantId, name: programName(p), structure: mapProgramStructure(p),
        is_default: false, source_draft_id: null,
      });
      if (error) { skipped.programs.push({ trainerize_id: p.trainerize_id, reason: "db error: " + error.message }); continue; }
    }
    imported.programs += 1;
  }

  // 3) Check-ins → checkins + progress_weights (dedup on (client, date)).
  const { data: existingCk } = clientId === DRY_ID ? { data: [] } :
    await db.from("checkins").select("id, submitted_at").eq("client_id", clientId);
  const ckByDate = new Map((existingCk ?? []).map((r: any) => [String(r.submitted_at).slice(0, 10), r.id]));
  const { data: existingPw } = clientId === DRY_ID ? { data: [] } :
    await db.from("progress_weights").select("date").eq("client_id", clientId);
  const pwDates = new Set((existingPw ?? []).map((r: any) => r.date));
  for (const c of payload.check_ins ?? []) {
    if (!c.trainerize_id) { skipped.checkins.push({ reason: "missing trainerize_id" }); continue; }
    if (!c.date) { skipped.checkins.push({ trainerize_id: c.trainerize_id, reason: "missing date" }); continue; }
    if (ckByDate.has(c.date)) {
      skipped.checkins.push({ trainerize_id: c.trainerize_id, reason: "already imported (matching client_id+date)" });
      continue;
    }
    let checkinId: string | null = null;
    if (!dryRun) {
      const { data, error } = await db.from("checkins")
        .insert({ ...mapCheckinRow(clientId, c, ctx.weightUnit), tenant_id: ctx.tenantId }).select("id").single();
      if (error) { skipped.checkins.push({ trainerize_id: c.trainerize_id, reason: "db error: " + error.message }); continue; }
      checkinId = data.id;
      if (Number.isFinite(c.weight_kg) && !pwDates.has(c.date)) {
        await db.from("progress_weights")
          .insert({ ...mapProgressWeightRow(clientId, c, ctx.weightUnit, checkinId), tenant_id: ctx.tenantId })
          .then(({ error: e2 }) => { if (e2) warnings.push(`progress_weight ${c.date}: ${e2.message}`); });
        pwDates.add(c.date);
      }
    }
    ckByDate.set(c.date, checkinId ?? DRY_ID);
    imported.checkins += 1;
  }

  // 4) Workout history + meals → trainerize_archive (upsert-ignore on the unique key).
  const adherenceByMeal = new Map<string, any>();
  for (const a of payload.meal_adherence ?? []) if (a?.trainerize_meal_id) adherenceByMeal.set(a.trainerize_meal_id, a);
  const mealTzIds = new Set((payload.meals ?? []).map((m: any) => m.trainerize_id).filter(Boolean));

  const archiveRows: any[] = [];
  for (const s of payload.workout_sessions ?? []) {
    if (!s.trainerize_id) { skipped.sessions.push({ reason: "missing trainerize_id" }); continue; }
    if (!s.performed_at) { skipped.sessions.push({ trainerize_id: s.trainerize_id, reason: "missing performed_at" }); continue; }
    archiveRows.push({ section: "sessions", row: mapArchiveSession(clientId, s) });
  }
  for (const m of payload.meals ?? []) {
    if (!m.trainerize_id) { skipped.meals.push({ reason: "missing trainerize_id" }); continue; }
    const adh = adherenceByMeal.get(m.trainerize_id) ?? null;
    if (adh) imported.meal_adherence += 1;
    archiveRows.push({ section: "meals", row: mapArchiveMeal(clientId, m, adh) });
  }
  for (const a of payload.meal_adherence ?? []) {
    if (a?.trainerize_meal_id && !mealTzIds.has(a.trainerize_meal_id))
      skipped.meal_adherence.push({ trainerize_meal_id: a.trainerize_meal_id, reason: "no matching meal in import" });
  }
  const { data: existingArch } = clientId === DRY_ID ? { data: [] } :
    await db.from("trainerize_archive").select("kind, trainerize_id").eq("client_id", clientId);
  const archKeys = new Set((existingArch ?? []).map((r: any) => `${r.kind}:${r.trainerize_id}`));
  for (const { section, row } of archiveRows) {
    const key = `${row.kind}:${row.trainerize_id}`;
    if (archKeys.has(key)) {
      skipped[section].push({ trainerize_id: row.trainerize_id, reason: "already imported (archive key match)" });
      if (section === "meals" && adherenceByMeal.has(row.trainerize_id)) imported.meal_adherence -= 1;
      continue;
    }
    archKeys.add(key);
    if (!dryRun) {
      const { error } = await db.from("trainerize_archive").insert({ ...row, tenant_id: ctx.tenantId });
      if (error) { skipped[section].push({ trainerize_id: row.trainerize_id, reason: "db error: " + error.message }); continue; }
    }
    imported[section] += 1;
  }

  // 5) Progress photos → storage (deterministic path, upsert) + progress_photos row.
  const { data: existingPhotos } = clientId === DRY_ID ? { data: [] } :
    await db.from("progress_photos").select("photo_url").eq("client_id", clientId);
  const photoUrls = new Set((existingPhotos ?? []).map((r: any) => r.photo_url));
  for (const ph of payload.progress_photos ?? []) {
    if (!ph.trainerize_id) { skipped.photos.push({ reason: "missing trainerize_id" }); continue; }
    if (!ph.checkin_date) { skipped.photos.push({ trainerize_id: ph.trainerize_id, reason: "missing checkin_date" }); continue; }
    const decoded = decodePhotoBase64(ph.data_base64);
    if (!decoded.ok) { skipped.photos.push({ trainerize_id: ph.trainerize_id, reason: decoded.reason }); continue; }
    const path = buildPhotoPath(ctx.tenantId, clientId, ph);
    if (photoUrls.has(path)) {
      skipped.photos.push({ trainerize_id: ph.trainerize_id, reason: "already imported (matching photo path)" });
      continue;
    }
    photoUrls.add(path);
    if (dryRun) { imported.photos += 1; continue; }
    const { error: upErr } = await db.storage.from(PHOTOS_BUCKET)
      .upload(path, decoded.bytes, { contentType: ph.mime_type ?? "application/octet-stream", upsert: true });
    if (upErr) { skipped.photos.push({ trainerize_id: ph.trainerize_id, reason: "storage error: " + upErr.message }); continue; }
    const checkinId = ckByDate.get(ph.checkin_date) ?? null;
    if (!checkinId) warnings.push(`photo ${ph.trainerize_id}: no matching check-in for ${ph.checkin_date}; file stored, not linked`);
    const { error } = await db.from("progress_photos")
      .insert({ ...mapProgressPhotoRow(clientId, ph, path, checkinId === DRY_ID ? null : checkinId), tenant_id: ctx.tenantId });
    if (error) { skipped.photos.push({ trainerize_id: ph.trainerize_id, reason: "db error: " + error.message }); continue; }
    imported.photos += 1;
  }

  // 6) Messages (content-hash dedup, history arrives read).
  const { data: existingMsgs } = clientId === DRY_ID ? { data: [] } :
    await db.from("messages").select("body, sent_at").eq("client_id", clientId);
  const msgHashes = new Set((existingMsgs ?? []).map((m: any) =>
    messageDedupKey(clientId, { sent_at: new Date(m.sent_at).toISOString(), content: m.body })));
  for (const msg of payload.messages ?? []) {
    if (!msg.trainerize_id) { skipped.messages.push({ reason: "missing trainerize_id" }); continue; }
    if (!msg.sent_at || !msg.content) { skipped.messages.push({ trainerize_id: msg.trainerize_id, reason: "missing sent_at or content" }); continue; }
    if (msg.direction !== "from_client" && msg.direction !== "from_coach") {
      skipped.messages.push({ trainerize_id: msg.trainerize_id, reason: `unknown direction "${msg.direction}"` });
      continue;
    }
    const key = messageDedupKey(clientId, { sent_at: new Date(msg.sent_at).toISOString(), content: msg.content });
    if (msgHashes.has(key)) {
      skipped.messages.push({ trainerize_id: msg.trainerize_id, reason: "already imported (content hash match)" });
      continue;
    }
    msgHashes.add(key);
    if (!dryRun) {
      const { error } = await db.from("messages").insert({ ...mapMessageRow(clientId, msg), tenant_id: ctx.tenantId });
      if (error) { skipped.messages.push({ trainerize_id: msg.trainerize_id, reason: "db error: " + error.message }); continue; }
    }
    imported.messages += 1;
  }

  const anyRealSkips = Object.values(skipped).some((arr) =>
    arr.some((s) => s.reason && !s.reason.startsWith("already imported")));
  return {
    status: anyRealSkips ? "partial" : "ok",
    client_id_supabase: clientId,
    client_created: clientCreated,
    imported, skipped, warnings,
    dry_run: dryRun,
  };
}
