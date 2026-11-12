// Deno-only. Run: deno test supabase/functions/mcp/briefSlides.test.ts
import {
  MAX_SLIDES, MAX_SLIDE_BASE64_CHARS, MAX_SLIDE_FILE_BYTES,
  validateSlideUpload, slideExt, slideStoragePath, idsWithSlideAt,
} from "./briefSlides.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("validateSlideUpload: images pass with a real size, everything else fails with a sentence", () => {
  const ok = validateSlideUpload({ mime_type: "image/jpeg", content_base64: "aGVsbG8=" });
  assert(ok.ok && ok.sizeBytes === 5, "expected 5 real bytes from 'aGVsbG8='");
  assert(!validateSlideUpload({ mime_type: "application/pdf", content_base64: "aGVsbG8=" }).ok, "pdf must fail");
  assert(!validateSlideUpload({ mime_type: "image/jpeg", content_base64: "" }).ok, "empty must fail");
  assert(!validateSlideUpload({ mime_type: "image/jpeg", content_base64: "not base64!!!" }).ok, "garbage must fail");
  assert(!validateSlideUpload({ mime_type: "image/jpeg", content_base64: "A".repeat(MAX_SLIDE_BASE64_CHARS + 4) }).ok, "oversize must fail");
});

Deno.test("the base64 cap is exactly the 6MB file cap re-expressed", () => {
  assert(MAX_SLIDE_FILE_BYTES === 6 * 1024 * 1024, "file cap is 6MB");
  assert(MAX_SLIDE_BASE64_CHARS === (MAX_SLIDE_FILE_BYTES / 3) * 4, "b64 cap derived, not hand-set");
  assert(MAX_SLIDES === 12, "count cap");
});

Deno.test("slide paths land under <tenant>/brief-slides/ with the right extension", () => {
  assert(slideExt("image/png") === "png" && slideExt("image/webp") === "webp" && slideExt("image/jpeg") === "jpg", "ext mapping");
  assert(slideStoragePath("t1", "u1", "image/png") === "t1/brief-slides/u1.png", "path shape");
});

Deno.test("idsWithSlideAt: moves within the list, clamps out-of-range targets, rejects unknown ids", () => {
  const ids = ["a", "b", "c", "d"];
  assert(JSON.stringify(idsWithSlideAt(ids, "d", 1)) === JSON.stringify(["d", "a", "b", "c"]), "move to front");
  assert(JSON.stringify(idsWithSlideAt(ids, "a", 3)) === JSON.stringify(["b", "c", "a", "d"]), "move to middle");
  assert(JSON.stringify(idsWithSlideAt(ids, "a", 12)) === JSON.stringify(["b", "c", "d", "a"]), "over-range clamps to last");
  assert(idsWithSlideAt(ids, "ghost", 2) === null, "unknown id is null");
});
