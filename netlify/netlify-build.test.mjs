// Tests for the one-click deploy pieces: scripts/netlify-build.mjs and the generated
// supabase/setup/database.sql. Run with `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkSettings, listFunctions, projectRefFromUrl, rewriteWellKnown } from "../scripts/netlify-build.mjs";
import { createClient } from "@supabase/supabase-js";

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

test("checkSettings accepts a publishable public key without requiring legacy keys", () => {
  assert.deepEqual(checkSettings({
    VITE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    VITE_SUPABASE_ANON_KEY: "sb_publishable_test-key_123",
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
  assert.match(checkSettings({ VITE_SUPABASE_URL: url, VITE_SUPABASE_ANON_KEY: "sbp_test-access-token" })[0],
    /must be a publishable key/);
});

test("checkSettings rejects malformed public keys and JWTs that are not legacy anon keys", () => {
  for (const key of [
    "sb_publishable_", "sb_publishable_test key", "random-text", "eyJnot-a-jwt",
    jwt({ role: "authenticated" }), jwt({}),
  ]) {
    const problems = checkSettings({
      VITE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      VITE_SUPABASE_ANON_KEY: key,
    });
    assert.equal(problems.length, 1, `must reject ${key}`);
    assert.match(problems[0], /must be a publishable key/);
  }
});

test("checkSettings never echoes secret keys in its problem messages", () => {
  for (const key of ["sb_secret_test-only-secret", jwt({ role: "service_role" })]) {
    const problems = checkSettings({
      VITE_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
      VITE_SUPABASE_ANON_KEY: key,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /SECRET key/);
    assert.ok(!problems[0].includes(key));
  }
});

// Characterize the real locked SDK's outgoing headers, not a hosted gateway response.
// The response below is a local stub; no request leaves the test process.
for (const [format, key] of [["publishable", "sb_publishable_test-key_123"], ["legacy anon", jwt({ role: "anon" })]]) {
  test(`the SDK preserves the ${format} public-key and user-token boundary`, async () => {
    const url = "https://abcdefghijklmnopqrst.supabase.co";
    for (const userToken of [null, jwt({ role: "authenticated", sub: "test-user" })]) {
      const calls = [];
      const client = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        ...(userToken ? { accessToken: async () => userToken } : {}),
        global: { fetch: async (input, init) => {
          calls.push({ url: String(input), headers: new Headers(init.headers) });
          return Response.json({ localStub: true });
        } },
      });
      const { error } = await client.functions.invoke("intake-submit", { body: { token: "test-token" } });
      assert.equal(error, null);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${url}/functions/v1/intake-submit`);
      assert.equal(calls[0].headers.get("apikey"), key);
      assert.equal(calls[0].headers.get("authorization"), `Bearer ${userToken || key}`);
    }
  });
}

test("the MCP proxy keeps public keys separate from connector credentials for both formats", async (t) => {
  const values = {
    SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-only-not-a-real-service-key",
    SUPABASE_ANON_KEY: "",
    VITE_SUPABASE_ANON_KEY: "",
    MCP_UPSTREAM: "https://abcdefghijklmnopqrst.supabase.co/functions/v1/mcp",
  };
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  Object.assign(process.env, values);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init.headers) });
    return Response.json({ localStub: true });
  });
  for (const [format, key] of [["publishable", "sb_publishable_test-key_123"], ["legacy", jwt({ role: "anon" })]]) {
    process.env.VITE_SUPABASE_ANON_KEY = key;
    const { default: proxy } = await import(`./functions/mcp-oauth.mjs?key-format-test=${format}`);
    const before = calls.length;
    const missing = await proxy(new Request("https://app.example.com/mcp"));
    assert.equal(missing.status, 401, "a configured public key does not authorize a connector");
    assert.equal(calls.length, before);
    const response = await proxy(new Request("https://app.example.com/mcp", {
      method: "POST",
      headers: { authorization: "Bearer coach_mcp_test-connector", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }));
    assert.equal(response.status, 200);
    assert.equal(calls.length, before + 1);
    assert.equal(calls[before].url, values.MCP_UPSTREAM);
    assert.equal(calls[before].headers.get("apikey"), key);
    assert.equal(calls[before].headers.get("authorization"), `Bearer ${key}`);
    assert.equal(calls[before].headers.get("x-api-key"), "coach_mcp_test-connector");
  }
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
  // 26: dm-inbound (an Instagram-DM sales pipeline whose tables no migration ever created)
  // was removed from the open-source copy.
  assert.equal(verify.length + noVerify.length, 26);
  assert.ok(!verify.includes("dm-inbound") && !noVerify.includes("dm-inbound"));
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
