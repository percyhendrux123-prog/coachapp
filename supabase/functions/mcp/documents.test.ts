// Deno-only. Run: deno test supabase/functions/mcp/documents.test.ts
import { documentStoragePath, MAX_DOCUMENT_BASE64_CHARS, validateDocumentUpload } from "./documents.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const eq = (actual: unknown, expected: unknown, message: string) =>
  assert(Object.is(actual, expected), `${message} — expected ${String(expected)}, got ${String(actual)}`);

const VALID = { kind: "parq", filename: "parq-signed.pdf", mime_type: "application/pdf", content_base64: "aGVsbG8=" };

Deno.test("a well-formed upload validates and reports a real byte size", () => {
  const result = validateDocumentUpload(VALID);
  assert(result.ok, "expected ok");
  if (result.ok) eq(result.sizeBytes, 5, "'hello' base64-encoded is 5 bytes"); // aGVsbG8= -> "hello"
});

Deno.test("an unknown kind is refused, not silently coerced", () => {
  const result = validateDocumentUpload({ ...VALID, kind: "passport" });
  assert(!result.ok, "expected rejection");
  if (!result.ok) assert(result.error.includes("kind must be one of"), "names the allowlist");
});

Deno.test("an unlisted mime type is refused", () => {
  const result = validateDocumentUpload({ ...VALID, mime_type: "application/zip" });
  assert(!result.ok, "expected rejection");
  if (!result.ok) assert(result.error.includes("mime_type must be one of"), "names the allowlist");
});

Deno.test("a missing filename is refused", () => {
  const result = validateDocumentUpload({ ...VALID, filename: "   " });
  assert(!result.ok, "expected rejection");
});

Deno.test("empty content is refused rather than treated as a zero-byte file", () => {
  const result = validateDocumentUpload({ ...VALID, content_base64: "" });
  assert(!result.ok, "expected rejection");
  if (!result.ok) assert(result.error.includes("required"), "names the gap");
});

Deno.test("payload over the size cap is refused before anything decodes it", () => {
  const oversized = "A".repeat(MAX_DOCUMENT_BASE64_CHARS + 1);
  const result = validateDocumentUpload({ ...VALID, content_base64: oversized });
  assert(!result.ok, "expected rejection");
  if (!result.ok) assert(result.error.includes("too large"), "names the size problem");
});

Deno.test("payload at exactly the cap is accepted", () => {
  const atCap = "A".repeat(MAX_DOCUMENT_BASE64_CHARS);
  const result = validateDocumentUpload({ ...VALID, content_base64: atCap });
  assert(result.ok, "the boundary itself must not be refused");
});

Deno.test("non-base64 content is refused rather than silently truncated at decode time", () => {
  const result = validateDocumentUpload({ ...VALID, content_base64: "not base64!! ??" });
  assert(!result.ok, "expected rejection");
  if (!result.ok) assert(result.error.includes("not valid base64"), "names the actual problem");
});

Deno.test("the storage path is tenant then client then kind, matching the existing bucket convention", () => {
  const path = documentStoragePath("t1", "c1", "parq", "signed.pdf", "2026-08-26T19:00:00.000Z");
  eq(path, "t1/c1/parq/2026-08-26T19-00-00-000Z-signed.pdf", "segments in the expected order");
});

Deno.test("a filename with path-hostile characters is sanitized, not rejected or passed through raw", () => {
  const path = documentStoragePath("t1", "c1", "id", "../../etc/passwd.jpg", "2026-08-26T19:00:00.000Z");
  assert(!path.includes(".."), "no directory traversal survives");
  assert(!path.includes("/etc/"), "no raw path separators from the filename survive");
});

Deno.test("a filename that sanitizes to nothing still produces a usable path", () => {
  const path = documentStoragePath("t1", "c1", "other", "", "2026-08-26T19:00:00.000Z");
  assert(path.endsWith("-file"), "falls back to a literal name rather than an empty segment");
});

Deno.test("a filename of symbols only sanitizes to underscores rather than disappearing", () => {
  const path = documentStoragePath("t1", "c1", "other", "###", "2026-08-26T19:00:00.000Z");
  assert(path.endsWith("-___"), "symbol characters become underscores, and the segment is not empty");
});
