// Split a plain-text message into text and link parts so a URL in a coach message is a
// tappable link (the health-screen link has to open in one tap from the thread).
// Only http(s) is ever linked. Trailing sentence punctuation stays text.
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
const TRAILING = /[.,;:!?)\]]+$/;

export function linkParts(text) {
  const s = String(text ?? "");
  const out = [];
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    let url = m[0];
    const trail = url.match(TRAILING)?.[0] ?? "";
    if (trail) url = url.slice(0, -trail.length);
    if (m.index > last) out.push({ type: "text", value: s.slice(last, m.index) });
    out.push({ type: "link", value: url });
    last = m.index + url.length;
  }
  if (last < s.length) out.push({ type: "text", value: s.slice(last) });
  return out;
}

// A link to this same app opens in place (the PWA keeps its window); anything else opens
// in a new tab.
export function isSameOrigin(url, origin) {
  try { return new URL(url).origin === origin; } catch { return false; }
}
