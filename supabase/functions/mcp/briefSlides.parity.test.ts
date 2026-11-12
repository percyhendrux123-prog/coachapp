// Parity test between src/lib/briefSlides.js and its hand-maintained Deno twin,
// briefSlides.ts. There's no automated sync between the two — this is the only thing
// that catches drift when one changes without the other (the mealMacros pattern,
// applied from the twin's first week instead of after an incident). Run with:
//   deno test --no-check supabase/functions/mcp/briefSlides.parity.test.ts
//
// @ts-nocheck
import { MAX_SLIDES as jsMax, MAX_SLIDE_BYTES as jsBytes, validateSlideFile }
  from "../../../src/lib/briefSlides.js";
import { MAX_SLIDES as tsMax, MAX_SLIDE_FILE_BYTES as tsBytes, MAX_SLIDE_BASE64_CHARS, validateSlideUpload }
  from "./briefSlides.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("count cap and byte cap agree between the JS and TS twins", () => {
  assert(jsMax === tsMax, `MAX_SLIDES drifted: js=${jsMax} ts=${tsMax}`);
  assert(jsBytes === tsBytes, `byte caps drifted: js=${jsBytes} ts=${tsBytes} — an in-app slide must round-trip through MCP`);
  assert(MAX_SLIDE_BASE64_CHARS === (tsBytes / 3) * 4, "ts base64 cap is no longer derived from the file cap");
});

Deno.test("the mime allowlists accept and reject the same types", () => {
  for (const type of ["image/jpeg", "image/png", "image/webp"]) {
    assert(validateSlideFile({ type, size: 1000 }).ok, `js rejects ${type}`);
    assert(validateSlideUpload({ mime_type: type, content_base64: "aGVsbG8=" }).ok, `ts rejects ${type}`);
  }
  for (const type of ["image/gif", "image/heic", "video/mp4", "application/pdf"]) {
    assert(!validateSlideFile({ type, size: 1000 }).ok, `js accepts ${type}`);
    assert(!validateSlideUpload({ mime_type: type, content_base64: "aGVsbG8=" }).ok, `ts accepts ${type}`);
  }
});

Deno.test("a file at the exact byte cap passes both twins; one byte over fails both", () => {
  assert(validateSlideFile({ type: "image/jpeg", size: jsBytes }).ok, "js rejects at-cap file");
  assert(!validateSlideFile({ type: "image/jpeg", size: jsBytes + 1 }).ok, "js accepts over-cap file");
  // A base64 payload of exactly the cap decodes to exactly the file cap (no padding).
  const atCap = "A".repeat(MAX_SLIDE_BASE64_CHARS);
  const overCap = "A".repeat(MAX_SLIDE_BASE64_CHARS + 4);
  assert(validateSlideUpload({ mime_type: "image/jpeg", content_base64: atCap }).ok, "ts rejects at-cap payload");
  assert(!validateSlideUpload({ mime_type: "image/jpeg", content_base64: overCap }).ok, "ts accepts over-cap payload");
});
