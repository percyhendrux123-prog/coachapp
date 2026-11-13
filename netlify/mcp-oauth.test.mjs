// run: node --test netlify/mcp-oauth.test.mjs
// Pure helpers behind the connect-your-AI sign-in page. The DB trigger is the real authority
// on scope vs tenant mode; these tests pin the page's OFFER to the same rule so a buyer is
// never shown a card the database will refuse.
import test from "node:test";
import assert from "node:assert/strict";
import { scopeOptionsFor, scopeAllowed, normalizeEmail, otpCodeFrom, EMAIL_RE } from "./functions/mcp-oauth.mjs";

test("self-serve offers read + owner; coached offers read + comms; never both", () => {
  assert.deepEqual(scopeOptionsFor("self_serve").map((o) => o.value), ["read", "owner"]);
  assert.deepEqual(scopeOptionsFor("coached").map((o) => o.value), ["read", "comms"]);
  assert.deepEqual(scopeOptionsFor(undefined).map((o) => o.value), ["read", "comms"], "unknown mode falls back to the coached offer");
  assert.equal(scopeAllowed("self_serve", "comms"), false, "no coach to message on self-serve");
  assert.equal(scopeAllowed("coached", "owner"), false, "full control is self-serve only");
  assert.equal(scopeAllowed("self_serve", "owner"), true);
  assert.equal(scopeAllowed("coached", "read"), true);
});

test("the self-serve card never mentions a coach", () => {
  for (const o of scopeOptionsFor("self_serve")) assert.ok(!/coach/i.test(o.detail), o.label);
});

test("email and code normalisation match the app's sign-in", () => {
  assert.equal(normalizeEmail("  Sam@Example.COM "), "sam@example.com");
  assert.ok(EMAIL_RE.test("sam@example.com"));
  assert.ok(!EMAIL_RE.test("not an email"));
  assert.equal(otpCodeFrom("46 41 99"), "464199");
  // New Supabase projects send 8-digit codes; the connector screen must take them whole.
  assert.equal(otpCodeFrom("4641 9921"), "46419921");
  assert.equal(otpCodeFrom("12345678901234"), "1234567890", "more than 10 digits are cut, not accepted");
  assert.equal(otpCodeFrom("abc"), "");
});
