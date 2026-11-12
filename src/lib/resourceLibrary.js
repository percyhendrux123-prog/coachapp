// Coach resources library — data layer for the client-facing Resources tab.
// A tenant-wide shelf (title + optional description + a PDF upload or a link),
// coach-managed. Mirrors src/lib/videoLibrary.js in shape: list / add / update /
// remove / reorder, plus one storage helper. See
// supabase/migrations/20260826120000_resource_library.sql for the schema and
// the RLS/storage-policy matrix this relies on.
import { supabase } from "./supabase";

const BUCKET = "resources";
export const RESOURCE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB, matches meal-plan PDFs
const SIGNED_URL_TTL = 3600; // 1 hour, matches getMealPlan() in mealPlan.js

const ROW_COLUMNS = "id, tenant_id, title, description, type, file_url, sort, created_at";

const libraryPath = (tenantId, resourceId) => `${tenantId}/library/${resourceId}.pdf`;

// Coach: every resource in the tenant, in display order.
export async function listResourcesForCoach() {
  const { data, error } = await supabase
    .from("resources")
    .select(ROW_COLUMNS)
    .order("sort", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// Coach: add one resource. Exactly one of `file` (pdf) or `url` (video/link) is
// expected — the caller decides which by `type`, this function does not infer it.
export async function addResource({ tenantId, title, description, type, file, url }) {
  const cleanTitle = (title ?? "").trim();
  if (!cleanTitle) throw new Error("This resource needs a title before it can be saved.");
  const cleanDesc = (description ?? "").trim() || null;

  if (type === "pdf") {
    if (!file) throw new Error("Choose a PDF file to upload.");
    if (file.type !== "application/pdf") throw new Error("Please choose a PDF file.");
    if (file.size > RESOURCE_MAX_BYTES) {
      throw new Error("That PDF is over 20 MB — please upload a smaller file.");
    }
  } else {
    if (!url || !url.trim()) throw new Error("Paste a link before saving.");
  }

  // Sort goes to the end of the current list — a coach adding a resource expects it
  // to land last, then reorder if they want it higher, same as the video library.
  const current = await listResourcesForCoach();
  const nextSort = current.length
    ? Math.max(...current.map((r) => r.sort)) + 1
    : 0;

  // Insert first to get the id (needed for the storage path), then upload, then
  // patch file_url to the storage path. A pdf row is briefly inconsistent between
  // these two calls; if the upload fails the row is deleted so nothing dangling
  // survives a failed upload.
  if (type === "pdf") {
    const { data: inserted, error: insertErr } = await supabase
      .from("resources")
      .insert({
        tenant_id: tenantId, title: cleanTitle, description: cleanDesc,
        type: "pdf", file_url: "pending", sort: nextSort,
      })
      .select(ROW_COLUMNS)
      .single();
    if (insertErr) throw insertErr;

    const path = libraryPath(tenantId, inserted.id);
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, file, { contentType: "application/pdf", upsert: true });
    if (uploadErr) {
      await supabase.from("resources").delete().eq("id", inserted.id);
      throw uploadErr;
    }

    const { data: updated, error: updateErr } = await supabase
      .from("resources")
      .update({ file_url: path })
      .eq("id", inserted.id)
      .select(ROW_COLUMNS)
      .single();
    if (updateErr) throw updateErr;
    return updated;
  }

  const { data, error } = await supabase
    .from("resources")
    .insert({
      tenant_id: tenantId, title: cleanTitle, description: cleanDesc,
      type, file_url: url.trim(), sort: nextSort,
    })
    .select(ROW_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

// Coach: title/description only. Changing the file or link is a remove-and-readd —
// this mirrors updateVideo(), which is title/description-only for the same reason:
// the underlying asset identity (a slot, here a row+path) should not silently swap.
export async function updateResource(id, { title, description }) {
  const cleanTitle = (title ?? "").trim();
  if (!cleanTitle) throw new Error("A resource needs a title.");
  const cleanDesc = (description ?? "").trim() || null;

  const { error } = await supabase
    .from("resources")
    .update({ title: cleanTitle, description: cleanDesc })
    .eq("id", id);
  if (error) throw error;
}

// Coach: remove a resource. A pdf-type row also deletes its storage object —
// leaving it behind would be an orphaned file no UI ever points to again.
export async function removeResource(id) {
  const { data: row, error: readErr } = await supabase
    .from("resources")
    .select("id, tenant_id, type")
    .eq("id", id)
    .maybeSingle();
  if (readErr) throw readErr;

  const { error } = await supabase.from("resources").delete().eq("id", id);
  if (error) throw error;

  // The row is gone — that is the user-facing effect and it already succeeded.
  // Storage cleanup is best-effort from here: log rather than throw, so a
  // cleanup failure never looks like the remove itself failed. It must not be
  // swallowed silently either — see res_coach_delete in the resource_library
  // migration for the RLS gap this used to hit before that policy existed.
  if (row?.type === "pdf") {
    const { error: removeErr } = await supabase.storage
      .from(BUCKET)
      .remove([libraryPath(row.tenant_id, id)]);
    if (removeErr) {
      console.warn(`resourceLibrary: failed to delete storage file for resource ${id}`, removeErr);
    }
  }
}

// Coach: rewrite the whole order. Takes every id in the new order; a partial list
// would leave duplicate/gapped sort values, so this writes sort = index for each row.
export async function reorderResources(orderedIds) {
  await Promise.all(
    orderedIds.map((id, index) =>
      supabase.from("resources").update({ sort: index }).eq("id", id)
        .then(({ error }) => { if (error) throw error; })),
  );
}

// Shared by the coach list (Open link) and the client Resources tab: a pdf row
// stores a storage PATH in file_url (not a URL — signed URLs expire and cannot be
// persisted), so it needs a fresh signed URL on every render. video/link rows
// already hold a real URL and pass through unchanged.
export async function resolveResourceUrl(row) {
  if (row.type !== "pdf") return row.file_url;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.file_url, SIGNED_URL_TTL);
  if (error) throw error;
  return data.signedUrl;
}
