// deno test --allow-env supabase/functions/_shared/coachingProvision.test.ts
import { gateCoachingSession, coachingWelcomeEmail, maskEmail } from "./coachingProvision.ts";
import { COACHING_TIER_BY_PRODUCT } from "./pricing.ts";

const STANDARD_PRODUCT = "prod_test_standard";
const ENTRY_PRODUCT = "prod_test_entry";
const ARCHITECT_PRODUCT = "prod_test_architect";
Deno.env.set("STRIPE_PRODUCTS_ENTRY", ENTRY_PRODUCT);
Deno.env.set("STRIPE_PRODUCTS_STANDARD", `${STANDARD_PRODUCT},${ARCHITECT_PRODUCT}`);

const paidSession = (over: any = {}) => ({
  status: "complete", payment_status: "paid", mode: "subscription",
  customer_details: { email: "  Buyer@Example.com " },
  line_items: { data: [{ price: { id: "price_test_standard", product: STANDARD_PRODUCT } }] },
  ...over,
});

Deno.test("gate: paid standard subscription → ok, tier standard, email lowercased", () => {
  const g = gateCoachingSession(paidSession());
  if (!g.ok) throw new Error(g.reason);
  if (g.tier !== "standard" || g.email !== "buyer@example.com") throw new Error(JSON.stringify(g));
});

Deno.test("gate: the configured entry product maps to entry tier", () => {
  const g = gateCoachingSession(paidSession({ line_items: { data: [{ price: { id: "price_test_entry", product: ENTRY_PRODUCT } }] } }));
  if (!g.ok || g.tier !== "entry") throw new Error(JSON.stringify(g));
});

Deno.test("gate: a brand-new legacy rate on a known product still passes (price rotates, product does not)", () => {
  const g = gateCoachingSession(paidSession({ line_items: { data: [{ price: { id: "price_test_rotated", product: STANDARD_PRODUCT, unit_amount: 12345 } }] } }));
  if (!g.ok || g.tier !== "standard") throw new Error(JSON.stringify(g));
});

Deno.test("gate: expanded product object is accepted too", () => {
  const g = gateCoachingSession(paidSession({ line_items: { data: [{ price: { id: "price_test_architect", product: { id: ARCHITECT_PRODUCT, name: "Architect plan" } } }] } }));
  if (!g.ok || g.tier !== "standard") throw new Error(JSON.stringify(g));
});

Deno.test("gate: every configured product passes with its mapped tier", () => {
  for (const [product, tier] of Object.entries(COACHING_TIER_BY_PRODUCT)) {
    const g = gateCoachingSession(paidSession({ line_items: { data: [{ price: { id: "price_test_any", product } }] } }));
    if (!g.ok || g.tier !== tier) throw new Error(`${product}: ${JSON.stringify(g)}`);
  }
  if (Object.keys(COACHING_TIER_BY_PRODUCT).length !== 3) throw new Error("Fixture config lists three products");
});

Deno.test("gate: 100%-off promo (no_payment_required) still counts as paid", () => {
  const g = gateCoachingSession(paidSession({ payment_status: "no_payment_required" }));
  if (!g.ok) throw new Error(g.reason);
});

Deno.test("gate: open session → not paid, pending flag", () => {
  const g = gateCoachingSession(paidSession({ status: "open", payment_status: "unpaid" }));
  if (g.ok || !g.pending) throw new Error(JSON.stringify(g));
});

Deno.test("gate: SYSTEM price is refused even when paid", () => {
  const g = gateCoachingSession(paidSession({ mode: "payment", line_items: { data: [{ price: { id: "price_test_self_serve", product: "prod_test_self_serve" } }] } }));
  if (g.ok) throw new Error("SYSTEM purchase passed the coaching gate");
});

Deno.test("gate: unknown product is refused — never by amount", () => {
  const g = gateCoachingSession(paidSession({ line_items: { data: [{ price: { id: "price_test_other", product: "prod_test_unknown", unit_amount: 12345 } }] } }));
  if (g.ok) throw new Error("unknown product passed");
});

Deno.test("gate: one-time purchase of a coaching product is refused (mode=payment)", () => {
  const g = gateCoachingSession(paidSession({ mode: "payment", line_items: { data: [{ price: { id: "price_test_once", product: STANDARD_PRODUCT } }] } }));
  if (g.ok) throw new Error("one-time passed");
});

Deno.test("gate: no email → refused with a named reason", () => {
  const g = gateCoachingSession(paidSession({ customer_details: {}, customer_email: null }));
  if (g.ok || !/no email/.test(g.reason)) throw new Error(JSON.stringify(g));
});

Deno.test("gate: null session → not found", () => {
  const g = gateCoachingSession(null);
  if (g.ok) throw new Error("null passed");
});

Deno.test("welcome email carries the intake link, plain voice, no hype, says 'you hear from me'", () => {
  const m = coachingWelcomeEmail({ intakeUrl: "https://app.example.com/intake?token=abc" });
  if (!m.text.includes("https://app.example.com/intake?token=abc")) throw new Error("link missing");
  if (!m.html.includes('href="https://app.example.com/intake?token=abc"')) throw new Error("html link missing");
  if (/!|🎉|crush|let's go|limited|grind/i.test(m.text)) throw new Error("voice violation");
  if (m.subject.length > 60) throw new Error("subject too long");
  if (/system/i.test(m.text)) throw new Error("coaching email must not say SYSTEM");
});

Deno.test("maskEmail hides the middle", () => {
  if (maskEmail("sam@example.com") !== "s…m@example.com") throw new Error(maskEmail("sam@example.com"));
});

Deno.test("welcome email uses configured coach signature with a neutral fallback", () => {
  const previous = Deno.env.get("COACH_SIGNATURE");
  try {
    Deno.env.delete("COACH_SIGNATURE");
    const fallback = coachingWelcomeEmail({ intakeUrl: "https://app.example.com/intake" });
    if (!fallback.text.endsWith("— Your coach")) throw new Error("neutral signature missing");
    Deno.env.set("COACH_SIGNATURE", "Sam Rivera <Coach>");
    const configured = coachingWelcomeEmail({ intakeUrl: "https://app.example.com/intake" });
    if (!configured.text.endsWith("— Sam Rivera <Coach>")) throw new Error("configured signature missing");
    if (!configured.html.includes("Sam Rivera &lt;Coach&gt;")) throw new Error("signature must be HTML escaped");
  } finally {
    if (previous === undefined) Deno.env.delete("COACH_SIGNATURE");
    else Deno.env.set("COACH_SIGNATURE", previous);
  }
});
