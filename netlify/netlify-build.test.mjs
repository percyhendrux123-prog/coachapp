// Tests for the one-click deploy pieces: scripts/netlify-build.mjs and the generated
// supabase/setup/database.sql. Run with `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkSettings, listFunctions, projectRefFromUrl, rewriteWellKnown } from "../scripts/netlify-build.mjs";

const jwt = (payload) =>
  [{ alg: "HS256" }, payload].map((p) => Buffer.from(JSON.stringify(p)).toString("base64url")).concat("sig").join(".");

test("projectRefFromUrl accepts only a bare Supabase project URL", () => {
  assert.equal(projectRefFromUrl("https://abcdefghijklmnopqrst.supabase.co"), "abcdefghijklmnopqrst");
  assert.equal(projectRefFromUrl("https://abcdefghijklmnopqrst.supabase.co/"), "abcdefghijklmnopqrst");
  assert.equal(projectRefFromUrl(" https://abcdefghijklmnopqrst.supabase.co "), "abcdefghijklmnopqrst");
  assert.equal(projectRefFromUrl("https://abcdefghijklmnopqrst.supabase.co/rest/v1"), null);
  assert.equal(projectRefFromUrl("http://abcdefghijklmnopqrst.supabase.co"), null);
  assert.equal(projectRefFromUrl("abcdefghijklmnopqrst"), null);
  assert.equal(projectRefFromUrl(""), null);
});

test("checkSettings passes a correct pair", () => {
  assert.deepEqual(checkSettings({
    VITE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    VITE_SUPABASE_ANON_KEY: jwt({ role: "anon" }),
  }), []);
});

test("checkSettings explains each wrong value in plain words", () => {
  const empty = checkSettings({});
  assert.equal(empty.length, 2);
  assert.match(empty[0], /VITE_SUPABASE_URL is empty/);
  assert.match(empty[1], /VITE_SUPABASE_ANON_KEY is empty/);

  const url = "https://abcdefghijklmnopqrst.supabase.co";
  assert.match(checkSettings({ VITE_SUPABASE_URL: "https://example.com", VITE_SUPABASE_ANON_KEY: jwt({ role: "anon" }) })[0],
    /does not look like a Supabase Project URL/);
  assert.match(checkSettings({ VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: jwt({ role: "service_role" }) })[0],
    /SECRET key/);
  assert.match(checkSettings({ VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: "sb_secret_abc" })[0], /SECRET key/);
  assert.match(checkSettings({ VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: "sb_publishable_abc" })[0],
    /Legacy API Keys/);
});

test("listFunctions splits functions by their verify_jwt config", () => {
  const dir = mkdtempSync(join(tmpdir(), "fns-"));
  for (const [name, cfg] of [["open-hook", "[verify_jwt]\nenabled = false\n"], ["needs-user", null], ["_shared", null]]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "index.ts"), "");
    if (cfg) writeFileSync(join(dir, name, "config.toml"), cfg);
  }
  mkdirSync(join(dir, "no-index"));
  assert.deepEqual(listFunctions(dir), { verify: ["needs-user"], noVerify: ["open-hook"] });
});

test("the repo's functions keep the gateway settings the code expects", () => {
  const { verify, noVerify } = listFunctions();
  // Called by Stripe, scheduled jobs, public pages or non-session tokens: must stay open at the gateway.
  for (const name of ["stripe-webhook", "license-reconcile", "challenge-enroll", "client-invite", "notify-coach", "onboarding-nudge", "send-digest"]) {
    assert.ok(noVerify.includes(name), `${name} should deploy with --no-verify-jwt`);
  }
  assert.ok(verify.includes("mcp"));
  assert.equal(verify.length + noVerify.length, 27);
});

test("rewriteWellKnown puts the site address into the discovery files", () => {
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  mkdirSync(join(dist, ".well-known"));
  writeFileSync(join(dist, ".well-known", "oauth-protected-resource"),
    JSON.stringify({ resource: "https://app.example.com/mcp", authorization_servers: ["https://app.example.com"] }));
  assert.deepEqual(rewriteWellKnown(dist, "https://coach-site.netlify.app/"), ["oauth-protected-resource"]);
  const doc = JSON.parse(readFileSync(join(dist, ".well-known", "oauth-protected-resource"), "utf8"));
  assert.equal(doc.resource, "https://coach-site.netlify.app/mcp");
  assert.deepEqual(doc.authorization_servers, ["https://coach-site.netlify.app"]);
  assert.deepEqual(rewriteWellKnown(dist, ""), []);
});

test("netlify-build stops with a readable message when settings are missing", () => {
  const r = spawnSync(process.execPath, ["scripts/netlify-build.mjs", "--dry-run"], {
    env: { PATH: process.env.PATH, NETLIFY: "true", CONTEXT: "production" },
    encoding: "utf8",
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SETUP PROBLEM/);
  assert.match(r.stderr, /VITE_SUPABASE_URL is empty/);
});

test("supabase/setup/database.sql matches the migrations (regenerate with node scripts/build-setup-sql.mjs)", () => {
  const r = spawnSync(process.execPath, ["scripts/build-setup-sql.mjs", "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("supabase/setup/database.sql fits the Supabase SQL editor in one paste", async () => {
  const { SQL_EDITOR_SAFE_BYTES } = await import("../scripts/build-setup-sql.mjs");
  const size = readFileSync("supabase/setup/database.sql").length;
  assert.ok(size <= SQL_EDITOR_SAFE_BYTES, `${size} bytes`);
  assert.ok(SQL_EDITOR_SAFE_BYTES < 0.98 * 1048576);
});
