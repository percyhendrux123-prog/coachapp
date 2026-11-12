// Mailto composition — the app builds the message, the coach's own mail client sends it.
//
// WHY MAILTO AND NOT A SENDING SERVICE. Every alternative (Resend, Postmark, SES) means
// one sending identity for the whole product: a verified domain, SPF/DKIM records, and a
// From address that is ours rather than the coach's. On a white-label app that is exactly
// wrong — the client should hear from their coach, at their coach's address, and hit reply
// to reach that coach's real inbox. Handing the message to the coach's mail client gets
// all of that for free and puts zero deliverability surface on us. The button is a
// shortcut, not a sender: nothing leaves until the coach presses send.
//
// ENCODING IS THE WHOLE RISK. A malformed mailto does not error — the mail client silently
// truncates the body at the first character it cannot parse, so a client receives half an
// email and nobody finds out. encodeURIComponent is necessary but NOT sufficient: it
// leaves ! ' ( ) * unescaped, and those are RFC 3986 sub-delims that some handlers (and
// some link-rewriting mail gateways) treat as structural. An apostrophe in a body line or
// in a client's surname is enough. So every reserved character is escaped explicitly.

// Characters encodeURIComponent leaves alone but a mailto handler may not.
const RESERVED = { "!": "%21", "'": "%27", "(": "%28", ")": "%29", "*": "%2A" };

function encodeField(value) {
  return encodeURIComponent(String(value ?? "")).replace(/[!'()*]/g, (c) => RESERVED[c]);
}

// Line breaks must reach the mail client as CRLF (%0D%0A). A bare %0A is dropped or
// collapsed by some clients, which is how a formatted body arrives as one run-on line.
function encodeBody(body) {
  return encodeField(String(body ?? "").replace(/\r\n|\r|\n/g, "\r\n"));
}

/**
 * Build a mailto: URL with a pre-filled subject and plain-text body.
 * Mailto bodies cannot carry HTML — plain text only, by protocol.
 *
 * @param {{to?: string, subject?: string, body?: string}} parts
 * @returns {string} a fully-escaped mailto: URL
 */
export function buildMailto({ to = "", subject = "", body = "" } = {}) {
  // The address sits in the path, where "@" and "." are legal and expected. Encoding the
  // rest of it still guards against a stray space or quote in a pasted address.
  const address = encodeField(String(to).trim()).replace(/%40/g, "@");
  const query = [];
  if (subject) query.push(`subject=${encodeField(subject)}`);
  if (body) query.push(`body=${encodeBody(body)}`);
  return `mailto:${address}${query.length ? `?${query.join("&")}` : ""}`;
}

/**
 * Hand a mailto: URL to the operating system's mail client.
 *
 * iOS Safari and iPadOS are the constraint here. window.open() on a mailto: is treated as
 * a popup — blocked outright, or it leaves a blank tab behind. Assigning location.href is
 * a scheme navigation, which Safari hands straight to Mail and which keeps working after
 * an await (no transient-activation requirement, unlike the clipboard). Same assignment is
 * correct on macOS, Android and desktop browsers, so there is no per-platform branch.
 */
export function openMailClient(url) {
  window.location.href = url;
}

// First name only, for a greeting. A full "display_name" reads like a form letter, and an
// empty or whitespace-only name must degrade to no greeting rather than "Hi ,".
export function firstName(displayName) {
  const first = String(displayName ?? "").trim().split(/\s+/)[0] ?? "";
  return first;
}
