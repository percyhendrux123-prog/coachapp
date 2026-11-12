// Video library data layer — the coach's bounded YouTube shelf, the assignments
// hung off it, and the client's replies. RLS scopes every call to the caller's
// tenant (and, for a client, to their own rows). See the migration
// 20260731060000_video_library.sql for the policy matrix.
import { supabase } from "./supabase";

// THE CAP. Twelve slots per coach, and the shelf is full at twelve.
//
// This is a curation device, not a storage limit. "Watch video 2 and post your
// favourite line" only works while a client can find video 2 without hunting,
// and past roughly a dozen a position stops being a landmark. Twelve is also
// one a month for a year, which is a refresh rhythm rather than a wall.
//
// Changing it means changing TWO things and only two: this constant, and the
// `coach_videos_slot_range` CHECK in the migration. The database is the real
// enforcement — slots are unique per tenant and constrained to 1..12, so there
// is no thirteenth slot for a bug or a direct API call to fill. This constant
// exists so the UI can say "full" before the database has to say "no".
export const MAX_SLOTS = 12;

const RESOLVER = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/youtube-resolve`;

// Columns the client app is allowed to read. Kept as one string so the coach
// and client reads cannot drift apart silently.
const VIDEO_COLUMNS =
  "id, slot, youtube_id, source_url, title, description, description_status, " +
  "channel_title, thumbnail_url, duration_seconds, embeddable, metadata_fetched_at";

// ---------------------------------------------------------------------------
// Shelf
// ---------------------------------------------------------------------------

export async function listVideos() {
  const { data, error } = await supabase
    .from("coach_videos")
    .select(VIDEO_COLUMNS)
    .order("slot", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// Ask the server what YouTube says about a pasted link.
//
// Returns { ok: true, video } or { ok: false, reason, message }. A failure to
// resolve is a normal, expected answer here — a coach pastes a wrong link, a
// video gets deleted — so it comes back as data with a sentence the coach can
// act on, not as a thrown error the UI has to guess how to phrase.
export async function resolveYouTube(url) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, reason: "signed_out", message: "Your session expired. Sign in again." };

  let res;
  try {
    res = await fetch(RESOLVER, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ url }),
    });
  } catch {
    return { ok: false, reason: "network", message: "Couldn't reach the server. Check your connection and try again." };
  }

  if (!res.ok) {
    // 401/403 from our own function, or a cold-start failure. Never dressed up
    // as a successful resolve with a blank title.
    return {
      ok: false,
      reason: "resolver_error",
      message: res.status === 403
        ? "Only a coach can add videos."
        : `The link checker didn't answer (HTTP ${res.status}). Try again in a moment.`,
    };
  }
  return await res.json();
}

// Add a resolved video to the next free slot.
//
// The slot is computed here from the current shelf rather than from a count, so
// a shelf with a gap (video 7 removed) refills the gap instead of failing at
// the ceiling.
export async function addVideo({ tenantId, video, title, description, createdBy }) {
  const current = await listVideos();
  if (current.length >= MAX_SLOTS) {
    throw new Error(`Your library is full at ${MAX_SLOTS} videos. Remove one to add another.`);
  }
  const taken = new Set(current.map((v) => v.slot));
  let slot = 1;
  while (taken.has(slot)) slot += 1;

  const cleanTitle = (title ?? video.title ?? "").trim();
  if (!cleanTitle) throw new Error("This video needs a title before it can be saved.");

  const cleanDesc = (description ?? video.description ?? "")?.trim() || null;
  // If the coach typed a description over an unavailable one, that is now a
  // written description and a later re-fetch must not silently replace it.
  const status = cleanDesc && cleanDesc !== (video.description ?? "").trim()
    ? "coach_written"
    : video.description_status ?? "unavailable";

  const { data, error } = await supabase
    .from("coach_videos")
    .insert({
      tenant_id: tenantId,
      slot,
      youtube_id: video.youtube_id,
      source_url: video.source_url ?? `https://www.youtube.com/watch?v=${video.youtube_id}`,
      title: cleanTitle,
      description: cleanDesc,
      description_status: status,
      channel_title: video.channel_title ?? null,
      thumbnail_url: video.thumbnail_url ?? null,
      duration_seconds: video.duration_seconds ?? null,
      embeddable: video.embeddable !== false,
      metadata_fetched_at: new Date().toISOString(),
      created_by: createdBy ?? null,
    })
    .select(VIDEO_COLUMNS)
    .single();

  if (error) {
    // Translate the two constraint violations a coach can actually cause.
    if (error.code === "23505" && /no_dupes/.test(error.message)) {
      throw new Error("That video is already in your library.");
    }
    if (error.code === "23514" && /slot_range/.test(error.message)) {
      throw new Error(`Your library is full at ${MAX_SLOTS} videos. Remove one to add another.`);
    }
    throw error;
  }
  return data;
}

export async function updateVideo(id, { title, description }) {
  const cleanTitle = (title ?? "").trim();
  if (!cleanTitle) throw new Error("A video needs a title.");
  const cleanDesc = (description ?? "").trim() || null;

  const { error } = await supabase
    .from("coach_videos")
    .update({
      title: cleanTitle,
      description: cleanDesc,
      // Anything the coach saves by hand is coach-written from then on. Without
      // this an edited description would still be labelled 'fetched' and a
      // future re-fetch would be entitled to overwrite it.
      description_status: cleanDesc ? "coach_written" : "unavailable",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

export async function removeVideo(id) {
  const { error } = await supabase.from("coach_videos").delete().eq("id", id);
  if (error) throw error;
}

// Rewrite the whole order in one transaction. Takes the complete list of ids in
// their new order — a partial list is rejected server-side rather than half
// applied, because a half-applied reorder leaves duplicate slot numbers.
export async function reorderVideos(orderedIds) {
  const { error } = await supabase.rpc("video_library_reorder", { p_ordered_ids: orderedIds });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Assignments — coach side
// ---------------------------------------------------------------------------

const ASSIGNMENT_COLUMNS =
  "id, client_id, video_id, video_youtube_id, video_title, prompt, assigned_at, due_on";

export async function listAssignmentsForClient(clientId) {
  const { data, error } = await supabase
    .from("video_assignments")
    .select(`${ASSIGNMENT_COLUMNS}, video_assignment_responses (id, body, submitted_at, coach_seen)`)
    .eq("client_id", clientId)
    .order("assigned_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function assignVideo({ tenantId, clientId, video, prompt, dueOn, assignedBy }) {
  const cleanPrompt = (prompt ?? "").trim();
  if (!cleanPrompt) throw new Error("Give the client something to do with the video.");

  const { data, error } = await supabase
    .from("video_assignments")
    .insert({
      tenant_id: tenantId,
      client_id: clientId,
      video_id: video.id,
      // Snapshotted on purpose: pulling the video off the shelf later must not
      // erase what this client was asked to watch, or orphan their reply.
      video_youtube_id: video.youtube_id,
      video_title: video.title,
      prompt: cleanPrompt,
      due_on: dueOn || null,
      assigned_by: assignedBy ?? null,
    })
    .select(ASSIGNMENT_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

export async function unassignVideo(assignmentId) {
  const { error } = await supabase.from("video_assignments").delete().eq("id", assignmentId);
  if (error) throw error;
}

export async function markResponseSeen(responseId) {
  const { error } = await supabase
    .from("video_assignment_responses")
    .update({ coach_seen: true })
    .eq("id", responseId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Assignments — client side
// ---------------------------------------------------------------------------

// A client's own assignments, each with their reply if they have written one.
// RLS restricts this to current_client_id(); no client filter is needed or
// trusted here.
export async function listMyAssignments() {
  const { data, error } = await supabase
    .from("video_assignments")
    .select(`${ASSIGNMENT_COLUMNS}, video_assignment_responses (id, body, submitted_at)`)
    .order("assigned_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function submitResponse({ tenantId, clientId, assignmentId, body }) {
  const clean = (body ?? "").trim();
  if (!clean) throw new Error("Write something before you send it.");

  const { error } = await supabase.from("video_assignment_responses").insert({
    tenant_id: tenantId,
    client_id: clientId,
    assignment_id: assignmentId,
    body: clean,
    // coach_seen is deliberately not set: the insert policy requires false, and
    // only the coach can flip it.
  });
  if (error) {
    if (error.code === "23505") throw new Error("You've already answered this one.");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

export const embedUrl = (youtubeId) =>
  `https://www.youtube-nocookie.com/embed/${youtubeId}`;

export const watchUrl = (youtubeId) =>
  `https://www.youtube.com/watch?v=${youtubeId}`;

export const thumbFor = (v) =>
  v.thumbnail_url || `https://i.ytimg.com/vi/${v.youtube_id}/hqdefault.jpg`;

export function formatDuration(seconds) {
  // null means "we don't know", which is not the same as 0:00 and must not
  // render as a time. The caller shows nothing at all.
  if (seconds == null) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// The one place that decides how a missing description reads. Two empty states,
// two different subjects, and they must never look alike:
//   'empty_on_youtube' — a fact about the video. It genuinely has no blurb.
//   'unavailable'      — a fact about us. We could not fetch one, and that is
//                        the coach's gap to close, not a property of the video.
// YouTube blurbs run to hundreds of lines. Coach settings already clamped;
// the client Videos tab did not, and a long description shoved the Android
// bottom nav off the glass.
export function clampDescription(text, max = 220) {
  if (!text) return "";
  const t = String(text).trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

// YouTube titles arrive ALL CAPS with leftover **markdown**. Display only —
// Settings still stores the raw title so a rename there is the source of truth.
export function displayTitle(text) {
  if (!text) return "";
  let t = String(text).replace(/\*\*?/g, "").replace(/[_`]/g, "").trim();
  t = t.replace(/\s+/g, " ");
  const letters = t.replace(/[^A-Za-z]/g, "");
  const upperShare = letters ? [...letters].filter((c) => c === c.toUpperCase()).length / letters.length : 0;
  if (upperShare < 0.72) return t;
  return t
    .toLowerCase()
    .replace(/(^|[\s\-:/])([a-z])/g, (_, p, c) => `${p}${c.toUpperCase()}`);
}

export function describeDescriptionState(video) {
  if (video.description) return null;
  if (video.description_status === "empty_on_youtube") {
    return { tone: "neutral", text: "This video has no description on YouTube." };
  }
  if (video.description_status === "unavailable") {
    return { tone: "warn", text: "Description couldn't be pulled from YouTube — add one yourself." };
  }
  return { tone: "neutral", text: "No description yet." };
}
