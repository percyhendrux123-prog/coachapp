// Client document uploads (signed PAR-Q forms, waivers, IDs, medical notes). Pure validation and
// path logic, so the size cap, the kind allowlist and the base64 handling are testable without a
// live storage bucket — a bug here either loses a real client's file or lets an oversized payload
// through to the edge function's memory.

export const DOCUMENT_KINDS = ["parq", "waiver", "id", "medical", "other"] as const;
export type DocumentKind = typeof DOCUMENT_KINDS[number];

export const DOCUMENT_MIME_ALLOWLIST = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
] as const;

// A JSON-RPC tool call has no multipart path — base64 in the arguments is the only way a file's
// bytes reach this surface. 8 MB of base64 text is ~6 MB of real file: generous for a scanned
// PDF or a photo of an ID, small enough that a single tool call cannot make the request body the
// bottleneck.
export const MAX_DOCUMENT_BASE64_CHARS = 8 * 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type DocumentUploadInput = {
  kind: string;
  filename: string;
  mime_type: string;
  content_base64: string;
};

export type DocumentUploadValidation =
  | { ok: true; sizeBytes: number }
  | { ok: false; error: string };

/**
 * Validate an upload_client_document call before anything touches storage or the database.
 * Returns the real file size in bytes (derived from the base64 length, not by decoding it —
 * decoding purely to measure would double the memory footprint of a payload already sized to
 * the maximum this surface accepts).
 */
export function validateDocumentUpload(input: DocumentUploadInput): DocumentUploadValidation {
  if (!DOCUMENT_KINDS.includes(input.kind as DocumentKind)) {
    return { ok: false, error: `kind must be one of: ${DOCUMENT_KINDS.join(", ")}` };
  }
  if (!DOCUMENT_MIME_ALLOWLIST.includes(input.mime_type as (typeof DOCUMENT_MIME_ALLOWLIST)[number])) {
    return { ok: false, error: `mime_type must be one of: ${DOCUMENT_MIME_ALLOWLIST.join(", ")}` };
  }
  if (!input.filename || !input.filename.trim()) {
    return { ok: false, error: "filename is required" };
  }
  const b64 = input.content_base64 ?? "";
  if (!b64) {
    return { ok: false, error: "content_base64 is required and was empty" };
  }
  if (b64.length > MAX_DOCUMENT_BASE64_CHARS) {
    return {
      ok: false,
      error: `file too large — base64 payload is ${b64.length} characters, max ${MAX_DOCUMENT_BASE64_CHARS} (~6 MB of real file)`,
    };
  }
  if (!BASE64_RE.test(b64)) {
    return { ok: false, error: "content_base64 is not valid base64" };
  }
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const sizeBytes = Math.floor((b64.length * 3) / 4) - padding;
  return { ok: true, sizeBytes };
}

/**
 * Storage path for one document: <tenant>/<client>/<kind>/<timestamp>-<safe filename>.
 * Same segment convention as the progress-photos and resources buckets (tenant, then client),
 * so the existing RLS shape (current_tenant_id() + current_client_id() / coach role) applies
 * without inventing a new one.
 */
export function documentStoragePath(
  tenantId: string,
  clientId: string,
  kind: string,
  filename: string,
  timestampIso: string,
): string {
  const stamp = timestampIso.replace(/[:.]/g, "-");
  // Two passes: first collapse anything outside a plain-filename charset, then collapse any run
  // of 2+ dots that survives (object storage keys are opaque strings, not filesystem paths, so
  // "../" cannot actually escape a segment here — but a filename that visibly reads as a
  // traversal attempt has no reason to be preserved either).
  const safeName = filename
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .slice(-120) || "file";
  return `${tenantId}/${clientId}/${kind}/${stamp}-${safeName}`;
}
