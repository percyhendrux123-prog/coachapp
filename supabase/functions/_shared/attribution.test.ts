// deno test supabase/functions/_shared/attribution.test.ts
//
// What a Checkout Session carries about where the sale came from. Stripe is mocked — nothing
// here touches the live account, creates a session, or moves a cent.
import { sanitizeAttribution, attributionRef, withAttribution, type Attribution } from "./attribution.ts";
import { SYSTEM_ONE_TIME_PRICE, SYSTEM_CHECKOUT_KIND } from "./pricing.ts";
import { WHITE_LABEL_LICENSE_PRICE, HOSTING_MONTHLY_PRICE } from "./pricing.ts";

// ---------------------------------------------------------------------------
// Mock Stripe: records the parameters it was asked to create a session with.
// ---------------------------------------------------------------------------
type Recorded = Record<string, any>;
function mockStripe() {
  const calls: Recorded[] = [];
  return {
    calls,
    checkout: {
      sessions: {
        // deno-lint-ignore require-await
        create: async (params: Recorded) => {
          calls.push(params);
          return { id: "cs_test_mock", url: "https://checkout.stripe.test/cs_test_mock" };
        },
      },
    },
  };
}

// The parameters system-checkout builds, minus attribution — same shape as index.ts.
const systemBaseParams = () => ({
  mode: "payment",
  line_items: [{ price: SYSTEM_ONE_TIME_PRICE, quantity: 1 }],
  customer_creation: "always",
  customer_email: "buyer@example.com",
  automatic_tax: { enabled: false },
  success_url: "https://app.example.com/system/welcome?session_id={CHECKOUT_SESSION_ID}",
  cancel_url: "https://app.example.com/system",
  metadata: { kind: SYSTEM_CHECKOUT_KIND, screen_id: "screen-123" },
});

// The parameters license-checkout builds, minus attribution — same shape as index.ts.
const licenseBaseParams = () => ({
  mode: "subscription",
  line_items: [
    { price: HOSTING_MONTHLY_PRICE, quantity: 1 },
    { price: WHITE_LABEL_LICENSE_PRICE, quantity: 1 },
  ],
  allow_promotion_codes: true,
  success_url: "https://app.example.com/license?session_id={CHECKOUT_SESSION_ID}",
  cancel_url: "https://app.example.com/license?canceled=1",
  client_reference_id: "user-abc",
  metadata: { kind: "white_label_license", user_id: "user-abc" },
  subscription_data: { metadata: { kind: "white_label_hosting", user_id: "user-abc" } },
});

function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}\n  got:      ${a}\n  expected: ${b}`);
}

const FULL_BODY = {
  email: "buyer@example.com",
  src: "ig",
  med: "reel",
  camp: "system-q4",
  cnt: "2026-09-10-hook-01",
  landing: "app.example.com",
  first_touch_at: "2026-09-08T14:24:00.000Z",
};

// ---------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------
Deno.test("no attribution in the body → the defaults, never blank", () => {
  const a = sanitizeAttribution({ email: "buyer@example.com" });
  eq(a, {
    src: "direct", med: "none", camp: "none", cnt: "none",
    landing: "none", first_touch_at: "none",
  }, "empty body should default every field");
  eq(attributionRef(a), "direct_none_none", "reference string for an untagged sale");
});

Deno.test("a garbage body cannot produce a blank or a broken field", () => {
  for (const body of [null, undefined, "not an object", 42, [], { src: "", med: "   ", camp: "!!!", cnt: null }]) {
    const a = sanitizeAttribution(body);
    for (const [k, v] of Object.entries(a)) {
      if (typeof v !== "string" || v === "") throw new Error(`${k} came back blank for ${JSON.stringify(body)}`);
    }
  }
});

Deno.test("values are lowercased, trimmed, stripped to [a-z0-9._-], and capped at 64", () => {
  const a = sanitizeAttribution({
    src: "  IG  ",
    med: "Re el",                        // spaces removed, not replaced
    camp: "sys<script>tem",              // injection characters do not survive
    cnt: "c".repeat(200),
    landing: "APP.Example.com",
    first_touch_at: "2026-09-08T14:24:00Z",
  });
  eq(a.src, "ig", "src lowercased and trimmed");
  eq(a.med, "reel", "spaces stripped");
  eq(a.camp, "sysscripttem", "angle brackets stripped");
  eq(a.cnt.length, 64, "capped at 64 characters");
  eq(a.landing, "app.example.com", "hostname lowercased");
  eq(a.first_touch_at, "2026-09-08T14:24:00.000Z", "timestamp normalized to ISO");
});

Deno.test("an unparseable first_touch_at becomes 'none', not an invented date", () => {
  eq(sanitizeAttribution({ first_touch_at: "last tuesday" }).first_touch_at, "none", "junk date");
  eq(sanitizeAttribution({ first_touch_at: "" }).first_touch_at, "none", "empty date");
});

Deno.test("the reference string can never exceed Stripe's 200-character limit", () => {
  const a = sanitizeAttribution({ src: "s".repeat(90), med: "m".repeat(90), cnt: "c".repeat(90) });
  if (attributionRef(a).length > 200) throw new Error("client_reference_id would be rejected by Stripe");
});

// ---------------------------------------------------------------------------
// system-checkout — payment mode, client_reference_id free
// ---------------------------------------------------------------------------
Deno.test("system-checkout, untagged visitor: source reads direct and the reference is direct_none_none", async () => {
  const stripe = mockStripe();
  const a = sanitizeAttribution({ email: "buyer@example.com" });
  await stripe.checkout.sessions.create(withAttribution(systemBaseParams(), a));
  const sent = stripe.calls[0];

  eq(sent.metadata.src, "direct", "src defaults to direct");
  eq(sent.client_reference_id, "direct_none_none", "reference string");
  eq(sent.payment_intent_data.metadata, { src: "direct", med: "none", camp: "none", cnt: "none" }, "charge metadata");
});

Deno.test("system-checkout, tagged link: all six on the session, the four on the charge", async () => {
  const stripe = mockStripe();
  await stripe.checkout.sessions.create(withAttribution(systemBaseParams(), sanitizeAttribution(FULL_BODY)));
  const sent = stripe.calls[0];

  eq(sent.metadata, {
    src: "ig", med: "reel", camp: "system-q4", cnt: "2026-09-10-hook-01",
    landing: "app.example.com", first_touch_at: "2026-09-08T14:24:00.000Z",
    kind: SYSTEM_CHECKOUT_KIND, screen_id: "screen-123",
  }, "session metadata: six attribution fields merged onto what was already there");

  eq(sent.client_reference_id, "ig_reel_2026-09-10-hook-01", "reference string is src_med_cnt");
  eq(sent.payment_intent_data.metadata, {
    src: "ig", med: "reel", camp: "system-q4", cnt: "2026-09-10-hook-01",
  }, "payment_intent_data carries the four campaign fields");
});

Deno.test("system-checkout: existing metadata keys survive — kind and screen_id are untouched", async () => {
  const stripe = mockStripe();
  // A hostile body trying to overwrite the keys system-provision depends on.
  const hostile = { ...FULL_BODY, kind: "free", screen_id: "someone-elses-screen" };
  await stripe.checkout.sessions.create(withAttribution(systemBaseParams(), sanitizeAttribution(hostile)));
  const sent = stripe.calls[0];

  eq(sent.metadata.kind, SYSTEM_CHECKOUT_KIND, "self-serve checkout kind is preserved");
  eq(sent.metadata.screen_id, "screen-123", "screen_id is the row this function inserted");
});

Deno.test("system-checkout: nothing else about the session changed", async () => {
  const stripe = mockStripe();
  await stripe.checkout.sessions.create(withAttribution(systemBaseParams(), sanitizeAttribution(FULL_BODY)));
  const sent = stripe.calls[0];
  const base = systemBaseParams();

  for (const key of ["mode", "line_items", "customer_creation", "customer_email", "automatic_tax", "success_url", "cancel_url"]) {
    eq(sent[key], (base as Recorded)[key], `${key} unchanged`);
  }
  eq(sent.subscription_data, undefined, "payment mode does not get subscription_data");
  eq(sent.metadata.attribution_ref, undefined, "a free client_reference_id means no attribution_ref key");
});

// ---------------------------------------------------------------------------
// license-checkout — subscription mode, client_reference_id already spoken for
// ---------------------------------------------------------------------------
Deno.test("license-checkout: the user id keeps client_reference_id; the source goes to attribution_ref", async () => {
  const stripe = mockStripe();
  await stripe.checkout.sessions.create(withAttribution(licenseBaseParams(), sanitizeAttribution(FULL_BODY)));
  const sent = stripe.calls[0];

  eq(sent.client_reference_id, "user-abc", "ownership binding untouched — license-provision reads this");
  eq(sent.metadata.attribution_ref, "ig_reel_2026-09-10-hook-01", "source string moved to metadata");
});

Deno.test("license-checkout, untagged: attribution_ref reads direct_none_none", async () => {
  const stripe = mockStripe();
  await stripe.checkout.sessions.create(withAttribution(licenseBaseParams(), sanitizeAttribution({})));
  const sent = stripe.calls[0];

  eq(sent.metadata.src, "direct", "src defaults to direct");
  eq(sent.metadata.attribution_ref, "direct_none_none", "reference string");
  eq(sent.client_reference_id, "user-abc", "still the user id");
});

Deno.test("license-checkout: subscription_data carries the four, and keeps kind + user_id", async () => {
  const stripe = mockStripe();
  await stripe.checkout.sessions.create(withAttribution(licenseBaseParams(), sanitizeAttribution(FULL_BODY)));
  const sent = stripe.calls[0];

  eq(sent.subscription_data.metadata, {
    src: "ig", med: "reel", camp: "system-q4", cnt: "2026-09-10-hook-01",
    kind: "white_label_hosting", user_id: "user-abc",
  }, "subscription metadata merged, not replaced");
  eq(sent.payment_intent_data, undefined, "subscription mode never gets payment_intent_data");
});

Deno.test("license-checkout: existing session metadata keys survive", async () => {
  const stripe = mockStripe();
  const hostile = { ...FULL_BODY, kind: "free", user_id: "someone-else" };
  await stripe.checkout.sessions.create(withAttribution(licenseBaseParams(), sanitizeAttribution(hostile)));
  const sent = stripe.calls[0];

  eq(sent.metadata.kind, "white_label_license", "kind untouched");
  eq(sent.metadata.user_id, "user-abc", "user_id untouched");
  eq(sent.allow_promotion_codes, true, "the comp-code mechanism is untouched");
});

Deno.test("license-checkout: nothing else about the session changed", async () => {
  const stripe = mockStripe();
  await stripe.checkout.sessions.create(withAttribution(licenseBaseParams(), sanitizeAttribution(FULL_BODY)));
  const sent = stripe.calls[0];
  const base = licenseBaseParams();

  for (const key of ["mode", "line_items", "allow_promotion_codes", "success_url", "cancel_url"]) {
    eq(sent[key], (base as Recorded)[key], `${key} unchanged`);
  }
});

// ---------------------------------------------------------------------------
// Stripe's own limits
// ---------------------------------------------------------------------------
Deno.test("every metadata key and value stays inside Stripe's limits", async () => {
  const long: Attribution = sanitizeAttribution({
    src: "s".repeat(200), med: "m".repeat(200), camp: "c".repeat(200), cnt: "n".repeat(200),
    landing: "h".repeat(200), first_touch_at: "2026-09-08T14:24:00.000Z",
  });
  const stripe = mockStripe();
  await stripe.checkout.sessions.create(withAttribution(systemBaseParams(), long));
  const sent = stripe.calls[0];

  for (const [k, v] of Object.entries(sent.metadata as Record<string, string>)) {
    if (k.length > 40) throw new Error(`metadata key too long for Stripe: ${k}`);
    if (String(v).length > 500) throw new Error(`metadata value too long for Stripe: ${k}`);
  }
  if (String(sent.client_reference_id).length > 200) throw new Error("client_reference_id too long for Stripe");
});
