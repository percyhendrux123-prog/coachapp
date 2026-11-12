// Where a sale came from. Server half.
//
// The browser (src/lib/attribution.js) remembers the tagged link a buyer arrived on and sends
// six fields with every checkout call. Nothing that arrives here is trusted: every value is
// re-sanitized before it touches a Stripe Checkout Session, because the body of these calls is
// a public trust boundary — system-checkout takes a stranger's POST, and anyone can hand it
// whatever they like.
//
// The result is written onto the session so the money row itself names the post that sold it:
//   metadata            — the full six, MERGED into whatever the function already sets
//   client_reference_id — src_med_cnt, the column visible in the Stripe payments list
//   payment_intent_data / subscription_data metadata — the four campaign fields, so the charge
//                         (not just the session) carries them into payouts and exports
//
// Hand-maintained twin of src/lib/attribution.js. attribution.parity.test.ts is the only thing
// keeping the two in step; change one, change the other.

export const ATTRIBUTION_DEFAULTS = {
  src: "direct",
  med: "none",
  camp: "none",
  cnt: "none",
} as const;

export type Attribution = {
  src: string;
  med: string;
  camp: string;
  cnt: string;
  landing: string;
  first_touch_at: string;
};

// Lowercase, trim, drop anything outside [a-z0-9._-], cap at 64. Characters are REMOVED, not
// replaced. Empty after cleaning falls back to the default — never a blank string.
export function attributionToken(raw: unknown, fallback: string): string {
  const clean = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 64);
  return clean || fallback;
}

// Hostname only. A path or query never reaches Stripe metadata this way.
export function attributionHost(raw: unknown): string {
  const clean = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "")
    .slice(0, 64);
  return clean || "none";
}

// Normalized to ISO. Unparseable input is "none", not an invented date.
export function attributionStamp(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 40) return "none";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "none" : d.toISOString();
}

// The whole six-field record, sanitized and complete. Pass it a raw request body.
export function sanitizeAttribution(input: unknown): Attribution {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    src: attributionToken(o.src, ATTRIBUTION_DEFAULTS.src),
    med: attributionToken(o.med, ATTRIBUTION_DEFAULTS.med),
    camp: attributionToken(o.camp, ATTRIBUTION_DEFAULTS.camp),
    cnt: attributionToken(o.cnt, ATTRIBUTION_DEFAULTS.cnt),
    landing: attributionHost(o.landing),
    first_touch_at: attributionStamp(o.first_touch_at),
  };
}

// `${src}_${med}_${cnt}`, capped at Stripe's 200-character limit for client_reference_id.
export function attributionRef(a: Attribution): string {
  return `${a.src}_${a.med}_${a.cnt}`.slice(0, 200);
}

// All six, for the session's own metadata. Merge this into the existing metadata object —
// never replace it, or `kind` and `screen_id` (which provisioning depends on) disappear.
export function attributionMetadata(a: Attribution): Record<string, string> {
  return { src: a.src, med: a.med, camp: a.camp, cnt: a.cnt, landing: a.landing, first_touch_at: a.first_touch_at };
}

// The four campaign fields, for payment_intent_data.metadata (payment mode) or
// subscription_data.metadata (subscription mode). Landing and first touch stay on the session:
// the charge only needs to answer "which post".
export function conversionMetadata(a: Attribution): Record<string, string> {
  return { src: a.src, med: a.med, camp: a.camp, cnt: a.cnt };
}

// Deliberately loose: the only thing this module needs to know about a Checkout Session is
// that these five fields may exist. Typed `unknown` so Stripe's own SessionCreateParams
// satisfies it as-is — that keeps full Stripe type-checking at the call sites and means no
// cast is needed there. (npm:stripe cannot be resolved from this repo's node_modules, so
// `deno check` on the checkout functions is not available locally either way.)
type SessionParams = {
  mode?: unknown;
  metadata?: unknown;
  client_reference_id?: unknown;
  payment_intent_data?: unknown;
  subscription_data?: unknown;
};

// Take the Checkout Session parameters a function was already going to send, and give back the
// same parameters carrying the source. This is the whole merge, in one place, so both checkout
// functions cannot drift apart — and so it can be tested without a live Stripe call.
//
// Three rules, each protecting something that already works:
//
//   1. Existing metadata WINS. Attribution is spread underneath, so `kind`, `screen_id`,
//      `user_id` — the keys provisioning reads — can never be displaced.
//   2. An existing client_reference_id is LEFT ALONE (license-checkout binds license ownership
//      through it). When it is already set, the source string goes to metadata.attribution_ref
//      instead. Only a session with that column free gets the source string in it.
//   3. The charge is stamped on whichever object the session's mode actually uses:
//      subscription mode → subscription_data.metadata, otherwise payment_intent_data.metadata.
//      Existing keys there win too.
export function withAttribution<T extends SessionParams>(params: T, a: Attribution): T {
  const ref = attributionRef(a);
  const existingRef = params.client_reference_id;
  const hasRefColumn = typeof existingRef === "string" && existingRef.trim() !== "";
  const mode = params.mode as string | undefined;

  const out: Record<string, unknown> = {
    ...params,
    metadata: {
      ...attributionMetadata(a),
      ...(hasRefColumn ? { attribution_ref: ref } : {}),
      ...((params.metadata as Record<string, string>) ?? {}),
    },
    ...(hasRefColumn ? {} : { client_reference_id: ref }),
  };

  const key = mode === "subscription" ? "subscription_data" : "payment_intent_data";
  const existing = ((mode === "subscription" ? params.subscription_data : params.payment_intent_data) ??
    {}) as Record<string, unknown>;
  out[key] = {
    ...existing,
    metadata: { ...conversionMetadata(a), ...((existing.metadata as Record<string, string>) ?? {}) },
  };

  return out as T;
}
