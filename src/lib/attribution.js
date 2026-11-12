// Where a sale came from. Browser half.
//
// A tagged link (…/system?src=ig&med=reel&camp=system-q4&cnt=2026-09-10-hook-01) is read on
// first load, sanitized, and kept first-party in localStorage for 30 days. Every checkout call
// carries the stored values, so the Stripe session — and therefore the payout row — names the
// post that sold it. Nothing is written to a cookie and nothing leaves the browser except on a
// checkout call.
//
// FIRST TOUCH WINS. An unexpired stored record is never overwritten: the post that earned the
// visit keeps the credit even if the buyer comes back later through a different link.
//
// UNTAGGED VISITS ARE NOT STORED. Someone arriving with no parameters has nothing worth
// remembering, so nothing is written — otherwise that empty "direct" record would sit in
// localStorage for 30 days and silently swallow the tagged click that follows it. Untagged
// checkouts still send a complete set of values; they are just resolved at send time and read
// src=direct.
//
// The Deno twin is supabase/functions/_shared/attribution.ts — the server re-sanitizes
// everything here, because a browser value is never trusted. attribution.parity.test.ts is the
// only thing keeping the two in step; change one, change the other.

export const ATTRIBUTION_KEY = "coachapp-attribution";
export const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const ATTRIBUTION_PARAMS = ["src", "med", "camp", "cnt"];

// Never blank. An unset field reads as a word, not an empty string, so an untagged sale is
// visibly untagged in Stripe rather than looking like a missing export.
export const ATTRIBUTION_DEFAULTS = Object.freeze({
  src: "direct",
  med: "none",
  camp: "none",
  cnt: "none",
});

// Stripe metadata values are strings; these are also read by humans scanning a payments list.
// Lowercase, trim, drop anything outside [a-z0-9._-], cap at 64. Characters are REMOVED, not
// replaced — "Hook 01" becomes "hook01". Tag links with hyphens, not spaces.
export function attributionToken(raw, fallback) {
  const clean = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 64);
  return clean || fallback;
}

// The page the visitor landed on, hostname only — no path, no query, so a tagged URL can never
// carry an email or a session id into Stripe metadata.
export function attributionHost(raw) {
  const clean = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "")
    .slice(0, 64);
  return clean || "none";
}

// Normalized to ISO so the stored value, the sent value, and the value in Stripe are one
// format. Unparseable input is "none" rather than a made-up date.
export function attributionStamp(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 40) return "none";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "none" : d.toISOString();
}

// The whole six-field record, sanitized and complete. Same shape on both sides of the wire.
export function sanitizeAttribution(input) {
  const o = input && typeof input === "object" ? input : {};
  return {
    src: attributionToken(o.src, ATTRIBUTION_DEFAULTS.src),
    med: attributionToken(o.med, ATTRIBUTION_DEFAULTS.med),
    camp: attributionToken(o.camp, ATTRIBUTION_DEFAULTS.camp),
    cnt: attributionToken(o.cnt, ATTRIBUTION_DEFAULTS.cnt),
    landing: attributionHost(o.landing),
    first_touch_at: attributionStamp(o.first_touch_at),
  };
}

// `${src}_${med}_${cnt}` — what shows in the Stripe payments list without opening a payment.
// Campaign is left out on purpose: the three that identify the post fit the column.
export function attributionRef(a) {
  return `${a.src}_${a.med}_${a.cnt}`.slice(0, 200);
}

function storage() {
  try { return window.localStorage; } catch { return null; } // private mode / blocked storage
}

function readStored(now) {
  const store = storage();
  if (!store) return null;
  let raw;
  try { raw = store.getItem(ATTRIBUTION_KEY); } catch { return null; }
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = sanitizeAttribution(parsed);
  if (rec.first_touch_at === "none") return null; // no clock on it — cannot age it, so drop it
  const age = now - new Date(rec.first_touch_at).getTime();
  if (!(age >= 0) || age > ATTRIBUTION_TTL_MS) return null; // expired, or dated in the future
  return rec;
}

// Read the four parameters off a query string. Returns null when the link carried none of them.
function taggedFrom(search) {
  let params;
  try { params = new URLSearchParams(search || ""); } catch { return null; }
  const present = ATTRIBUTION_PARAMS.some((k) => String(params.get(k) ?? "").trim() !== "");
  if (!present) return null;
  const out = {};
  for (const k of ATTRIBUTION_PARAMS) out[k] = attributionToken(params.get(k), ATTRIBUTION_DEFAULTS[k]);
  return out;
}

/**
 * Run once per page load. Stores a tagged visit if nothing unexpired is stored yet.
 * Returns the record that now applies. Safe to call anywhere — it never throws.
 *
 * @param {{ search?: string, hostname?: string, now?: number, store?: Storage }} [ctx]
 */
export function captureAttribution(ctx = {}) {
  const now = typeof ctx.now === "number" ? ctx.now : Date.now();
  const search = ctx.search ?? (typeof window !== "undefined" ? window.location.search : "");
  const hostname = ctx.hostname ?? (typeof window !== "undefined" ? window.location.hostname : "");

  const stored = readStored(now);
  if (stored) return stored; // first touch wins — do not overwrite an unexpired record

  const tagged = taggedFrom(search);
  if (!tagged) return sanitizeAttribution({ landing: hostname, first_touch_at: new Date(now).toISOString() });

  const rec = sanitizeAttribution({ ...tagged, landing: hostname, first_touch_at: new Date(now).toISOString() });
  const store = storage();
  if (store) {
    try { store.setItem(ATTRIBUTION_KEY, JSON.stringify(rec)); } catch { /* quota / private mode */ }
  }
  return rec;
}

/**
 * The six fields to put in a checkout request body. Resolves the same way on every call:
 * stored first touch if there is one, otherwise a complete direct record for right now.
 */
export function attributionBody(ctx = {}) {
  return captureAttribution(ctx);
}
