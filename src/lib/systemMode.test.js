// src/lib/systemMode.test.js — run: node --test src/lib/systemMode.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { COPY, copyFor, isSelfServe } from "./systemMode.js";

test("every key has both twins and the self-serve twin never mentions a coach", () => {
  for (const [key, twins] of Object.entries(COPY)) {
    assert.ok(typeof twins.coached === "string" && twins.coached.length > 0, `${key}.coached`);
    assert.ok(typeof twins.self_serve === "string" && twins.self_serve.length > 0, `${key}.self_serve`);
    assert.ok(!/coach/i.test(twins.self_serve), `${key}.self_serve mentions a coach: "${twins.self_serve}"`);
  }
});

test("copyFor falls back to coached for any mode that is not self_serve", () => {
  assert.equal(copyFor(undefined, "no_program"), COPY.no_program.coached);
  assert.equal(copyFor("self_serve", "no_program"), COPY.no_program.self_serve);
});

test("isSelfServe reads branding.mode and nothing else", () => {
  assert.equal(isSelfServe({ mode: "self_serve" }), true);
  assert.equal(isSelfServe({ mode: "coached" }), false);
  assert.equal(isSelfServe(null), false);
});
