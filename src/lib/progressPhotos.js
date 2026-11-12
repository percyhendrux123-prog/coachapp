// Coach-side reads of client check-in / progress photos.
//
// The photos already exist — clients upload them with check-ins (src/lib/client.js) into
// the PRIVATE `progress-photos` bucket, and rows land in `progress_photos`. What never
// existed before 2026-08-30 was a coach screen that reads them. This module is that read
// path: table rows via the pp_coach_read RLS policy, images via short-lived signed URLs
// under the photos_owner_read storage policy (its coach branch). Both policies were
// verified live against production before this file was written — no migration needed.
//
// Signed URLs, never public URLs, never raw paths handed to <img> — same discipline the
// MCP surface applies (supabase/functions/mcp/index.ts PHOTO_BUCKET comment).
//
// Fetchers use dynamic imports (see dateOnly.js header / progressTrends.js) so the pure
// helpers below stay importable under `node --test` without a Vite environment.

const BUCKET = "progress-photos";
const SIGNED_URL_TTL = 3600; // seconds — matches the MCP surface's 1-hour TTL

const PHOTO_COLUMNS = "id, taken_at, photo_url, pose_tag, source_checkin_id";

export async function listClientPhotos(clientId, limit = 100) {
  const { supabase } = await import("./supabase.js");
  const { data, error } = await supabase
    .from("progress_photos")
    .select(PHOTO_COLUMNS)
    .eq("client_id", clientId)
    .order("taken_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

// The Photos tab's fetch: newest `limit` photos PLUS the true total, and — when the
// cap truncates — the genuinely earliest photo appended so the before/after compare
// starts at day one instead of at photo #limit. A capped list presented as complete
// is an invented completeness (THE GATE); `total` lets the UI say what it's showing.
export async function listClientPhotoTimeline(clientId, limit = 100) {
  const { supabase } = await import("./supabase.js");
  const { data, error, count } = await supabase
    .from("progress_photos")
    .select(PHOTO_COLUMNS, { count: "exact" })
    .eq("client_id", clientId)
    .order("taken_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const photos = data ?? [];
  const total = count ?? photos.length;
  if (total > photos.length) {
    const { data: earliest, error: eErr } = await supabase
      .from("progress_photos")
      .select(PHOTO_COLUMNS)
      .eq("client_id", clientId)
      .order("taken_at", { ascending: true })
      .limit(1);
    if (!eErr && earliest?.[0] && !photos.some((p) => p.id === earliest[0].id)) {
      photos.push(earliest[0]); // list is newest-first; the earliest belongs at the end
    }
  }
  return { photos, total };
}

// Batch-sign storage paths. Returns Map path -> signed URL, with null for any path that
// failed to sign. A null is surfaced by the UI as "could not load", never silently
// dropped — a photo that fails to sign is a system fact, not an absent photo.
export async function signPhotoPaths(paths) {
  const clean = (paths ?? []).filter(Boolean);
  if (clean.length === 0) return new Map();
  const { supabase } = await import("./supabase.js");
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(clean, SIGNED_URL_TTL);
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.path, r.error ? null : r.signedUrl]));
}

// Pure. Pick the default two-up compare from a newest-first photo list: earliest vs
// latest. One photo compares against itself-only (caller renders single); empty is empty.
export function defaultComparePair(photosNewestFirst) {
  const list = photosNewestFirst ?? [];
  if (list.length === 0) return null;
  if (list.length === 1) return { before: list[0], after: list[0], single: true };
  return { before: list[list.length - 1], after: list[0], single: false };
}

// Pure. The twin-facts rule (the read-status contract): an empty photo list means one of two
// DIFFERENT things and they must never render the same.
//   - "zero"        — photo prompts are on for this tenant, the client just hasn't
//                     submitted any. A fact about the client. Loud.
//   - "not_tracked" — the tenant has photos switched off (tenant_config.progress_photos_on
//                     or the published check-in config's fields.photos). A fact about the
//                     system, never displayed as a client failure.
//   - "unknown"     — the collection settings themselves could not be read. Reported as
//                     exactly that, not guessed either way.
export function emptyPhotosReason({ tenantPhotosOn, checkinFieldsPhotos }) {
  if (tenantPhotosOn == null || checkinFieldsPhotos == null) return "unknown";
  return tenantPhotosOn !== false && checkinFieldsPhotos === true ? "zero" : "not_tracked";
}
