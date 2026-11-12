// claudeInstall.js — the one-tap Connect-to-Claude link. Pure module, plain `node --test`.
import test from "node:test";
import assert from "node:assert/strict";
import { claudeInstallUrl, CLAUDE_CONNECTORS_URL } from "./claudeInstall.js";

test("builds Anthropic's documented prefill link with the URL percent-encoded", () => {
  const url = claudeInstallUrl({ name: "Self-serve plan", endpoint: "https://app.example.com/mcp" });
  assert.equal(
    url,
    `${CLAUDE_CONNECTORS_URL}?modal=add-custom-connector&connectorName=Self-serve+plan&connectorUrl=https%3A%2F%2Fapp.example.com%2Fmcp`,
  );
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("modal"), "add-custom-connector");
  assert.equal(parsed.searchParams.get("connectorName"), "Self-serve plan");
  assert.equal(parsed.searchParams.get("connectorUrl"), "https://app.example.com/mcp");
});

test("refuses to build a half-link when the name or endpoint is missing", () => {
  assert.equal(claudeInstallUrl({ name: "", endpoint: "https://x.test/mcp" }), null);
  assert.equal(claudeInstallUrl({ name: "X", endpoint: "" }), null);
  assert.equal(claudeInstallUrl({}), null);
});

test("trims whitespace so a padded app name still round-trips cleanly", () => {
  const url = claudeInstallUrl({ name: "  Law Fitness  ", endpoint: " https://app.example/mcp " });
  assert.equal(new URL(url).searchParams.get("connectorName"), "Law Fitness");
  assert.equal(new URL(url).searchParams.get("connectorUrl"), "https://app.example/mcp");
});
