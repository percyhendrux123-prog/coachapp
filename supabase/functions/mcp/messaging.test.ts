// Deno-only. Run: deno test supabase/functions/mcp/messaging.test.ts
import { personaliseMessage, unknownPlaceholders } from "./messaging.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const eq = (actual: unknown, expected: unknown, message: string) =>
  assert(Object.is(actual, expected), `${message} — expected ${String(expected)}, got ${String(actual)}`);

Deno.test("personalisation substitutes both placeholders", () => {
  const out = personaliseMessage("{{first_name}} — full name on file is {{display_name}}.", "Marcus Webb");
  eq(out.body, "Marcus — full name on file is Marcus Webb.", "both placeholders filled");
  eq(out.unfilled.length, 0, "nothing unfilled");
});

Deno.test("a missing name is reported as a gap, never filled with a friendly stand-in", () => {
  const out = personaliseMessage("Hi {{first_name}}, quick update.", null);
  eq(out.unfilled.length, 1, "the unfillable placeholder is reported");
  eq(out.unfilled[0], "{{first_name}}", "and named");
  // The substituted body is still produced (the caller decides what to do), but it visibly
  // reads wrong — which is the point. It must never read as if a real name went out.
  eq(out.body, "Hi , quick update.", "no invented greeting is substituted in");
});

Deno.test("a body with no placeholders sends to a nameless client without complaint", () => {
  const out = personaliseMessage("The app moves to the new address on Monday.", "");
  eq(out.unfilled.length, 0, "nothing to fill means nothing missing");
});

Deno.test("whitespace-only and single-word names behave", () => {
  eq(personaliseMessage("{{first_name}}", "   ").unfilled.length, 1, "whitespace is not a name");
  eq(personaliseMessage("{{first_name}}", "Cher").body, "Cher", "a single-word name fills first_name");
  eq(personaliseMessage("{{display_name}}", "  Ava  Stone ").body, "Ava  Stone", "outer whitespace trimmed");
});

Deno.test("an unknown placeholder is caught before anything is sent", () => {
  const unknown = unknownPlaceholders("Hi {{first_name}}, your {{tier}} renews {{renewal_date}}.");
  eq(unknown.length, 2, "two unknown placeholders");
  assert(unknown.includes("{{tier}}"), "tier is flagged");
  assert(unknown.includes("{{renewal_date}}"), "renewal_date is flagged");
  eq(unknownPlaceholders("Hi {{display_name}}").length, 0, "known placeholders are not flagged");
});

Deno.test("the same placeholder appearing twice is substituted every time", () => {
  const out = personaliseMessage("{{first_name}}, {{first_name}}, listen.", "Dev Patel");
  eq(out.body, "Dev, Dev, listen.", "replaceAll, not replace");
});
