// Message personalisation for bulk sends. Pure, so the substitution rules are testable — a bug
// here goes out to the whole roster at once and cannot be recalled.

export const PLACEHOLDERS = ["{{display_name}}", "{{first_name}}"] as const;

/**
 * Substitute a recipient's name into a message body.
 *
 * A client with no display name on file is a real gap, not something to paper over with "there"
 * or "friend" — inventing a greeting is exactly the kind of plausible filler that stops anyone
 * noticing the record is incomplete. `personaliseMessage` returns the substituted body AND the
 * placeholders it could not fill, so the caller can refuse rather than send "Hi ,".
 */
export function personaliseMessage(
  body: string,
  displayName: string | null | undefined,
): { body: string; unfilled: string[] } {
  const name = String(displayName ?? "").trim();
  const first = name.split(/\s+/)[0] ?? "";
  const unfilled: string[] = [];
  if (!name) {
    for (const p of PLACEHOLDERS) if (body.includes(p)) unfilled.push(p);
  }
  return {
    body: body.replaceAll("{{display_name}}", name).replaceAll("{{first_name}}", first),
    unfilled,
  };
}

/** Placeholders used in a body that this surface does not know how to fill. */
export function unknownPlaceholders(body: string): string[] {
  const known = new Set<string>(PLACEHOLDERS);
  return [...new Set([...body.matchAll(/\{\{\s*[a-z_]+\s*\}\}/gi)].map((m) => m[0]))]
    .filter((p) => !known.has(p.replace(/\s+/g, "") as never));
}
