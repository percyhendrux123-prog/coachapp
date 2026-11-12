// Brief slides — the ordered strip of stills on the Brief tab (coach manages, every
// client of the tenant sees the same strip read-only). Rows in brief_slides,
// images in the PUBLIC `brand` bucket under <tenant>/brief-slides/ — marketing-grade
// content, never client PII, so public URLs are correct here (unlike progress photos,
// which stay signed).
//
// INTEGRITY MODEL (since migration 20260830190000, which closed the review findings
// on the original app-enforced model): position density and the 12-count cap are
// DATABASE invariants, not app promises. Inserts get their position assigned by a
// trigger (compact-then-append under a per-tenant lock — supplied positions are
// ignored); reordering goes through the atomic set_brief_slide_order RPC with the
// full id list; a deferrable UNIQUE (tenant_id, position) backstops everything else.
// This module therefore never computes positions — it only phrases errors early so
// the coach gets a sentence instead of a constraint violation.
//
// THE CAP mirrors the video shelf's reasoning (videoLibrary.js MAX_SLOTS): a position
// is a landmark, and past a dozen it stops being one.
//
// Fetchers use dynamic imports (see dateOnly.js header / progressTrends.js) so the pure
// helpers stay importable under `node --test`.

export const MAX_SLIDES = 12;

const SLIDE_MIME = ["image/jpeg", "image/png", "image/webp"];
// 6 MB of real file — kept in exact parity with the MCP twin's base64 cap
// (supabase/functions/mcp/briefSlides.ts: 8M base64 chars = 6 MB decoded).
// briefSlides.parity.test.ts asserts the two never drift.
export const MAX_SLIDE_BYTES = 6 * 1024 * 1024;

const COLUMNS = "id, position, image_path, caption, created_at, updated_at";

// Pure. Sort rows for render: position, then upload time, then id. Positions are
// dense by DB invariant now; the tiebreaks keep render deterministic even against
// data written before the integrity migration or by a future bug.
export function orderSlides(rows) {
  return [...(rows ?? [])].sort(
    (a, b) =>
      (a.position ?? 0) - (b.position ?? 0) ||
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
      String(a.id).localeCompare(String(b.id)),
  );
}

// Pure. Validate a candidate file before anything touches storage.
export function validateSlideFile(file) {
  if (!file) return { ok: false, error: "No file selected." };
  if (!SLIDE_MIME.includes(file.type)) {
    return { ok: false, error: "Slides are images: JPG, PNG, or WebP." };
  }
  if (file.size > MAX_SLIDE_BYTES) {
    return { ok: false, error: "That image is over 6 MB. Export a smaller version." };
  }
  return { ok: true };
}

// Pure. The full id list after moving one slide up/down by render order — the shape
// set_brief_slide_order wants. Null when the move is a no-op (already at the edge,
// or the slide is not in the list).
export function reorderedIds(rows, slideId, direction) {
  const ids = orderSlides(rows).map((r) => r.id);
  const i = ids.indexOf(slideId);
  if (i < 0) return null;
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return null;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return ids;
}

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export async function listSlides() {
  const { supabase } = await import("./supabase.js");
  const { data, error } = await supabase.from("brief_slides").select(COLUMNS);
  if (error) throw error;
  return orderSlides(data);
}

export async function addSlide({ tenantId, file, caption = null, existing }) {
  const check = validateSlideFile(file);
  if (!check.ok) throw new Error(check.error);
  // Friendly early message only — the DB trigger is the real cap enforcement, and
  // it also catches the case where `existing` is stale.
  if ((existing?.length ?? 0) >= MAX_SLIDES) {
    throw new Error(`The strip is full at ${MAX_SLIDES} slides. Remove one first.`);
  }

  const { supabase } = await import("./supabase.js");
  const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = `${tenantId}/brief-slides/${crypto.randomUUID()}.${ext}`;
  const { error: upErr } = await supabase.storage.from("brand").upload(path, file, { contentType: file.type });
  if (upErr) throw upErr;

  const { data, error } = await supabase
    .from("brief_slides")
    .insert({ tenant_id: tenantId, image_path: path, caption: caption?.trim() || null })
    .select(COLUMNS)
    .single();
  if (error) {
    // The image made it to storage but the row didn't — remove the orphan rather than
    // leaving an invisible file, then report the real failure.
    await supabase.storage.from("brand").remove([path]).catch(() => {});
    throw error;
  }
  return data;
}

export async function removeSlide(slide) {
  const { supabase } = await import("./supabase.js");
  const { error } = await supabase.from("brief_slides").delete().eq("id", slide.id);
  if (error) throw error;
  // Best-effort: the row is the source of truth; a stray file in a public marketing
  // bucket is cosmetic, so a storage failure here does not fail the removal.
  // The position gap left behind is closed by the next insert's compaction.
  await supabase.storage.from("brand").remove([slide.image_path]).catch(() => {});
}

// Atomic reorder via the RPC. Returns false for a no-op move (edge of the strip).
export async function moveSlide(rows, slideId, direction) {
  const ids = reorderedIds(rows, slideId, direction);
  if (!ids) return false;
  const { supabase } = await import("./supabase.js");
  const { error } = await supabase.rpc("set_brief_slide_order", { p_ids: ids });
  if (error) throw error;
  return true;
}

export async function saveSlideCaption(slideId, caption) {
  const { supabase } = await import("./supabase.js");
  const { error } = await supabase.from("brief_slides")
    .update({ caption: caption?.trim() || null, updated_at: new Date().toISOString() })
    .eq("id", slideId);
  if (error) throw error;
}
