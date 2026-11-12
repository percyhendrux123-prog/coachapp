// Pure mapping functions for the Trainerize → coachapp importer. Wire contract
// v1.0.0 uses deterministic transforms, no I/O, and skips rather than fabricating
// missing data. Targets the coachapp schema:
//   • client → clients row (tenant-scoped; NEVER an auth user — coach invites later)
//   • program → canonical structure {days:[…]} as ONE training day (Trainerize exports
//     a flat exercise list; inventing a weekly split would fabricate data)
//   • check_ins → checkins + progress_weights, weights converted kg → tenant unit
//   • workout history + meals → trainerize_archive (verbatim payloads, kg preserved)
//   • messages → messages (sender_role), content-hash dedup
// The edge fn composes these and applies all database side effects.

import { createHash } from "node:crypto";

export const SUPPORTED_SCHEMA_MAJOR = 1;
export const PHOTOS_BUCKET = "progress-photos";

// ─── contract guards ─────────────────────────────────────────────────────
export function parseSchemaVersion(v: unknown) {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
export function isSchemaCompatible(v: unknown): boolean {
  const parsed = parseSchemaVersion(v);
  return Boolean(parsed && parsed.major === SUPPORTED_SCHEMA_MAJOR);
}

// ─── helpers ────────────────────────────────────────────────────────────
export function contentHash(...parts: unknown[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(String(p ?? ""));
  return h.digest("hex");
}

export function isoDateOnly(iso: unknown): string | null {
  if (!iso) return null;
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// kg → the tenant's configured display unit. checkins/progress_weights store
// unit-bare numbers the UI shows raw, so they must match tenant_config.weight_unit.
export function kgToTenantUnit(kg: number, weightUnit: string): number {
  if (weightUnit === "kg") return Math.round(kg * 10) / 10;
  return Math.round(kg * 2.20462 * 10) / 10; // 'lb'
}

const mint = () => crypto.randomUUID();

// ─── client ─────────────────────────────────────────────────────────────
// Insert-only fields for a NEW clients row. Existing rows are matched on
// (tenant, lower(email)) and never clobbered (display_name filled only if null).
export function mapClientRow(client: any) {
  return {
    display_name: client.name?.trim() || String(client.email).split("@")[0],
    email: String(client.email).trim().toLowerCase(),
    status: "active",
  };
}

// ─── program → canonical structure ──────────────────────────────────────
// Trainerize program exercises are a flat list: {name, sets: <count>, reps: "5-7",
// rir?, notes?}. schedule.days is only a which-weekdays hint with no exercise→day
// mapping, so the honest import is ONE training day carrying every exercise; the
// coach reshapes it in the builder before assigning. _meta rides at the structure
// top level (the app only reads structure.days — verified) and carries the dedup key.
export function mapProgramStructure(program: any) {
  const exercises = (Array.isArray(program.exercises) ? program.exercises : [])
    .filter((ex: any) => ex && typeof ex.name === "string" && ex.name.trim())
    .map((ex: any) => {
      const setCount = Number.isFinite(ex.sets) && ex.sets > 0 ? Math.min(ex.sets, 20) : 3;
      const noteBits = [
        Number.isFinite(ex.rir) ? `RIR ${ex.rir}` : null,
        typeof ex.notes === "string" && ex.notes.trim() ? ex.notes.trim() : null,
      ].filter(Boolean);
      return {
        exercise_id: mint(),
        name: ex.name.trim(),
        demo_media_url: null,
        sets: Array.from({ length: setCount }, (_, i) => ({
          set_index: i,
          target_reps: typeof ex.reps === "string" && ex.reps ? ex.reps : "8-10",
          target_weight: null,
          notes: i === 0 && noteBits.length ? noteBits.join(" — ") : null,
        })),
      };
    });
  const label = (program.title ?? program.schedule?.title ?? "Imported block").trim() || "Imported block";
  return {
    _meta: {
      trainerize_id: program.trainerize_id,
      source: "trainerize",
      schedule: program.schedule ?? null,
      week_number: program.week_number ?? null,
      status: program.status ?? null,
    },
    days: [{
      day_id: mint(),
      kind: "training",
      label,
      groups: [{ group_id: mint(), type: "straight", exercises }],
    }],
  };
}

export function programName(program: any): string {
  const t = (program.title ?? program.schedule?.title ?? "").trim();
  return `Trainerize — ${t || program.trainerize_id}`;
}

export function extractStructureTzId(structure: any): string | null {
  return structure?._meta?.source === "trainerize" ? structure._meta.trainerize_id ?? null : null;
}

// ─── check-ins ──────────────────────────────────────────────────────────
export function mapCheckinRow(clientId: string, checkin: any, weightUnit: string) {
  const answers: Record<string, unknown> = { source: "trainerize" };
  if (typeof checkin.notes === "string" && checkin.notes.trim()) answers.note = checkin.notes.trim();
  if (Number.isFinite(checkin.body_fat_pct)) answers.body_fat_pct = checkin.body_fat_pct;
  return {
    client_id: clientId,
    submitted_at: `${checkin.date}T00:00:00Z`,
    weight: Number.isFinite(checkin.weight_kg) ? kgToTenantUnit(checkin.weight_kg, weightUnit) : null,
    answers,
    coach_seen: true, // history — nothing should pop as needs-review on day one
  };
}

export function mapProgressWeightRow(clientId: string, checkin: any, weightUnit: string, checkinId: string | null) {
  return {
    client_id: clientId,
    date: checkin.date,
    weight: kgToTenantUnit(checkin.weight_kg, weightUnit),
    source_checkin_id: checkinId,
  };
}

// ─── archive (workout history + meals) ──────────────────────────────────
export function mapArchiveSession(clientId: string, session: any) {
  return {
    client_id: clientId,
    kind: "workout_session",
    trainerize_id: session.trainerize_id,
    occurred_at: session.performed_at ?? null,
    payload: session, // verbatim; weights stay kg here
  };
}

// Meal + its adherence merged into one archive payload.
export function mapArchiveMeal(clientId: string, meal: any, adherence: any | null) {
  return {
    client_id: clientId,
    kind: "meal",
    trainerize_id: meal.trainerize_id,
    occurred_at: meal.date ? `${meal.date}T00:00:00Z` : null,
    payload: adherence
      ? { ...meal, eaten: Boolean(adherence.eaten), eaten_at: adherence.eaten_at ?? null }
      : meal,
  };
}

// ─── progress photos ────────────────────────────────────────────────────
export function buildPhotoPath(tenantId: string, clientId: string, photo: any): string {
  const ext = photo.mime_type === "image/png" ? "png" : photo.mime_type === "image/jpeg" ? "jpg" : "bin";
  return `${tenantId}/${clientId}/trainerize-${photo.trainerize_id}.${ext}`;
}

export function decodePhotoBase64(b64: unknown): { ok: true; bytes: Uint8Array } | { ok: false; reason: string } {
  if (typeof b64 !== "string" || b64.length === 0) return { ok: false, reason: "empty data_base64" };
  try {
    const bin = atob(b64.replace(/\s/g, ""));
    if (bin.length === 0) return { ok: false, reason: "invalid base64" };
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { ok: true, bytes };
  } catch {
    return { ok: false, reason: "invalid base64" };
  }
}

export function mapProgressPhotoRow(clientId: string, photo: any, photoUrl: string, checkinId: string | null) {
  return {
    client_id: clientId,
    taken_at: photo.captured_at ?? `${photo.checkin_date}T00:00:00Z`,
    photo_url: photoUrl,
    pose_tag: null,
    source_checkin_id: checkinId,
  };
}

// ─── messages ───────────────────────────────────────────────────────────
export function mapMessageRow(clientId: string, msg: any) {
  return {
    client_id: clientId,
    sender_role: msg.direction === "from_client" ? "client" : "coach",
    body: msg.content,
    sent_at: msg.sent_at,
    read_at: msg.sent_at, // imported history is read history
  };
}

export function messageDedupKey(clientId: string, msg: { sent_at: unknown; content: unknown }): string {
  return contentHash(clientId, msg.sent_at, msg.content);
}
