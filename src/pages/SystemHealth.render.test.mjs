// P33 — the self-serve health outcomes and the free signup, rendered from the real components.
// Static render (renderToStaticMarkup), same harness as Placeholders.render.test.mjs.
import React from "react";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

globalThis.window = globalThis.window || { scrollTo() {}, location: { origin: "https://example.invalid" } };
// Placeholder values only so the Supabase client module can initialise; nothing is called.
process.env.VITE_SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.VITE_SUPABASE_ANON_KEY ||= "render-test-placeholder";
// Test-only: expose the Intake page's private Result without changing product code.
const exposeForTest = {
  name: "expose-intake-result",
  enforce: "post",
  transform(code, id) {
    if (!id.endsWith("/src/pages/Intake.jsx")) return null;
    return `${code}\nexport { Result as IntakeResult };\n`;
  },
};
const root = new URL("../..", import.meta.url).pathname;
const server = await createServer({ configFile: false, root, envDir: "/nonexistent-placeholder-env", logLevel: "error",
  plugins: [exposeForTest], appType: "custom", server: { middlewareMode: true, hmr: false }, esbuild: { jsx: "automatic" } });
after(() => server.close());
const { IntakeResult } = await server.ssrLoadModule("/src/pages/Intake.jsx");
const { HealthHoldView } = await server.ssrLoadModule("/src/components/HealthHold.jsx");
const { default: System } = await server.ssrLoadModule("/src/pages/System.jsx");
const { default: SystemStart, SignupSent, SignupPaused } = await server.ssrLoadModule("/src/pages/SystemStart.jsx");
const { default: SystemWelcome } = await server.ssrLoadModule("/src/pages/SystemWelcome.jsx");
const copy = await server.ssrLoadModule("/src/content/healthHoldCopy.js");

const html = (el, path = "/") => renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [path] }, el));
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

// Banned words in a self-serve health outcome. W4's own plain fact "There is no coach on this
// plan" is the one approved use of the word and is removed before the check.
function assertNoBannedWords(h, label) {
  const t = text(h).replace(copy.ALLOWED_COACH_SENTENCE, "");
  for (const w of copy.BANNED_OUTCOME_WORDS) {
    assert.doesNotMatch(t, new RegExp(`\\b${w}\\b`, "i"), `${label}: "${w}"`);
  }
}

const CLEAR_FLAGS = ["parq_chest_pain", "medication_disclosed"];

test("Intake result: doctor first shows the approved W4 text, the items in words, and Sign in", () => {
  const h = html(React.createElement(IntakeResult, { r: { status: "needs_clearance", mode: "self_serve", health_flags: CLEAR_FLAGS } }));
  assert.match(h, /ON HOLD/);
  assert.match(text(h), /Check with your doctor first\./);
  assert.match(text(h), /Chest pain with activity/);
  assert.match(text(h), /You listed a medication/);
  assert.doesNotMatch(h, /parq_|medication_disclosed/, "flag ids never appear on screen");
  assert.match(text(h), /Nobody here reviews health answers\./);
  assert.match(h, /href="\/login"/);
  assertNoBannedWords(h, "needs_clearance");
});

test("Intake result: pregnancy and eating-disorder history are not eligible, each with its approved text", () => {
  const p = html(React.createElement(IntakeResult, { r: { status: "blocked_health", mode: "self_serve", reason: "pregnancy" } }));
  assert.match(text(p), /This plan is not built for pregnancy\./);
  assert.match(p, /NOT THIS PLAN/);
  assertNoBannedWords(p, "pregnancy");
  const ed = html(React.createElement(IntakeResult, { r: { status: "blocked_health", mode: "self_serve", reason: "eating_disorder_history" } }));
  assert.match(text(ed), /This plan is not the right tool\./);
  assert.match(text(ed), /call your local emergency number/);
  assert.doesNotMatch(text(ed), /\d{3}[-. ]\d{3,4}/, "D5: no helpline number");
  assertNoBannedWords(ed, "eating_disorder_history");
  for (const h of [p, ed]) assert.match(h, /href="\/login"/);
});

test("Intake result: a published self-serve plan with failed nutrition points to Update my numbers, not a receipt", () => {
  const h = html(React.createElement(IntakeResult, { r: { status: "published", mode: "self_serve", meal_plan_error: "pool too thin" } }));
  assert.match(text(h), /Update my numbers/);
  assert.doesNotMatch(text(h), /receipt|charged|coach/i);
});

test("Intake result: coached held outcome is unchanged", () => {
  const h = html(React.createElement(IntakeResult, { r: { status: "held_medical", mode: "coached" } }));
  assert.match(text(h), /Your coach is on it\./);
});

test("HealthHold: doctor first renders the three boxes, the name field and a disabled button", () => {
  const h = html(React.createElement(HealthHoldView, { hold: { state: "needs_clearance", intake_id: "i", flags: CLEAR_FLAGS, has_live_plan: false } }));
  assert.equal((h.match(/type="checkbox"/g) || []).length, 3);
  assert.match(text(h), /After you have talked to them/);
  assert.match(text(h), /Type your full name/);
  assert.match(h, /<button type="submit" disabled=""[^>]*>Build my plan<\/button>/);
  assert.match(text(h), /four training days at most/);
  assertNoBannedWords(h, "hold needs_clearance");
});

test("HealthHold: button turns on only with all three boxes and a name", () => {
  const view = (checks, name) => html(React.createElement(HealthHoldView, { hold: { state: "needs_clearance", intake_id: "i", flags: CLEAR_FLAGS }, checks, name }));
  assert.match(view([true, true, false], "Test Person"), /disabled=""[^>]*>Build my plan/);
  assert.match(view([true, true, true], " "), /disabled=""[^>]*>Build my plan/);
  assert.doesNotMatch(view([true, true, true], "Test Person"), /disabled=""[^>]*>Build my plan/);
});

test("HealthHold: not eligible has no controls; a live plan gets the W10 banner and is left alone", () => {
  const h = html(React.createElement(HealthHoldView, { hold: { state: "blocked", reason: "pregnancy", has_live_plan: true } }));
  assert.doesNotMatch(h, /type="checkbox"|Build my plan/);
  assert.match(text(h), /This plan was built before that answer\./);
  assertNoBannedWords(h, "hold blocked");
});

test("HealthHold: a failed read shows the failed state with Retry, never an empty one", () => {
  const h = html(React.createElement(HealthHoldView, { failed: true, onRetry() {} }));
  assert.match(h, /data-health-hold="failed"/);
  assert.match(text(h), /failed read/);
  assert.match(h, />Retry</);
  assert.equal(html(React.createElement(HealthHoldView, { hold: { state: "none" } })), "");
});

test("System page: free, the W1 footer, no price or payment words", () => {
  const h = text(html(React.createElement(System)));
  assert.match(h, /Free\. Open source\./);
  assert.match(h, /Some mean this plan is not built for you\./);
  assert.doesNotMatch(h, /\$\d|payment|charged|receipt|Stripe|checkout|coaching/i);
});

test("Signup page: email only, then check-your-email or paused", () => {
  const start = html(React.createElement(SystemStart));
  assert.equal((start.match(/<input/g) || []).length, 1, "one field: email");
  assert.doesNotMatch(text(start), /payment|Stripe|\$\d|receipt/i);
  assert.match(text(html(React.createElement(SignupSent))), /Check your email\./);
  assert.match(text(html(React.createElement(SignupPaused))), /paused/);
});

test("Welcome page: an old payment-return link is told the plan is free now", () => {
  const old = text(html(React.createElement(SystemWelcome), "/system/welcome?session_id=cs_fixture"));
  assert.match(old, /This plan is free now\. Enter your email to get your link\./);
  assert.doesNotMatch(text(html(React.createElement(SystemWelcome), "/system/welcome")), /payment|Stripe|receipt/i);
});

// 2.2.8 copy guard: no price, payment, charge, receipt or Stripe in the self-serve surfaces.
test("copy guard: self-serve sources never mention a price or payment", () => {
  const files = ["src/pages/System.jsx", "src/pages/SystemStart.jsx", "src/pages/SystemWelcome.jsx", "src/lib/systemMode.js",
    "src/content/healthHoldCopy.js", "src/components/HealthHold.jsx", "supabase/functions/system-signup/welcomeEmail.ts"];
  const guard = /\$47|\bpayment\b|\bcharged\b|\breceipt\b|Stripe/i;
  for (const f of files) {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8")
      .replace(/^\s*\/\/.*$/gm, "") // comments may name what was removed
      .replace(/"(?:charged|receipt)",?/g, ""); // the banned-word list itself
    assert.doesNotMatch(src, guard, f);
  }
  // Intake.jsx: only its self-serve strings are guarded (the Result's self-serve branches).
  const intake = readFileSync(new URL("../../src/pages/Intake.jsx", import.meta.url), "utf8");
  const ss = intake.slice(intake.indexOf("function Result"), intake.indexOf('const held = r.status === "held_medical"'));
  assert.doesNotMatch(ss, guard, "Intake.jsx self-serve result");
});
