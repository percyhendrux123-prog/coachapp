// Brief slide validation and path logic for the MCP surface — pure, so the mime
// allowlist and the base64 cap are testable without a live bucket. The frontend twin
// is src/lib/briefSlides.js; briefSlides.parity.test.ts asserts the shared constants
// (count cap, byte cap, mime allowlist) never drift — shared validation applied from
// day one this time.
//
// Position logic deliberately does NOT live here (or in the JS twin) any more: since
// migration 20260830190000, position density and the 12-count cap are database
// invariants (insert trigger + set_brief_slide_order RPC + deferrable unique). The
// twins only phrase errors early; they cannot drift on enforcement they no longer own.

export const SLIDE_MIME_ALLOWLIST = ["image/jpeg", "image/png", "image/webp"] as const;
export type SlideMime = typeof SLIDE_MIME_ALLOWLIST[number];

export const MAX_SLIDES = 12;

// One truth for the size cap, stated in real file bytes; the base64 cap is derived
// (4 chars per 3 bytes). 6 MB of image is generous for a still that renders in a
// 16:9 plate, and matches src/lib/briefSlides.js MAX_SLIDE_BYTES exactly.
export const MAX_SLIDE_FILE_BYTES = 6 * 1024 * 1024;
export const MAX_SLIDE_BASE64_CHARS = (MAX_SLIDE_FILE_BYTES / 3) * 4;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type SlideUploadValidation =
  | { ok: true; sizeBytes: number }
  | { ok: false; error: string };

export function validateSlideUpload(input: { mime_type: string; content_base64: string }): SlideUploadValidation {
  if (!SLIDE_MIME_ALLOWLIST.includes(input.mime_type as SlideMime)) {
    return { ok: false, error: `mime_type must be one of: ${SLIDE_MIME_ALLOWLIST.join(", ")}` };
  }
  const b64 = input.content_base64 ?? "";
  if (!b64) return { ok: false, error: "content_base64 is required and was empty" };
  if (b64.length > MAX_SLIDE_BASE64_CHARS) {
    return { ok: false, error: `image too large — base64 payload is ${b64.length} characters, max ${MAX_SLIDE_BASE64_CHARS} (6 MB of real file)` };
  }
  if (!BASE64_RE.test(b64)) return { ok: false, error: "content_base64 is not valid base64" };
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return { ok: true, sizeBytes: Math.floor((b64.length * 3) / 4) - padding };
}

export function slideExt(mime: string): string {
  return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}

export function slideStoragePath(tenantId: string, uuid: string, mime: string): string {
  return `${tenantId}/brief-slides/${uuid}.${slideExt(mime)}`;
}

// Pure. The full id list with one slide moved to a target 1-based position — the
// shape set_brief_slide_order wants. Null when the slide is not in the list; the
// target index is clamped into range rather than rejected (an agent asking for
// position 12 in a 5-slide strip means "last").
export function idsWithSlideAt(orderedIds: string[], slideId: string, position: number): string[] | null {
  const i = orderedIds.indexOf(slideId);
  if (i < 0) return null;
  const rest = orderedIds.filter((id) => id !== slideId);
  const j = Math.max(0, Math.min(rest.length, position - 1));
  return [...rest.slice(0, j), slideId, ...rest.slice(j)];
}
