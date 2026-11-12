// The owner-content placeholders (Knowledge card, Knowledge page, resource pages) ship
// empty in the open-source copy. They must read as intentional placeholders, never as
// leftover copy from someone else's business or as a broken page.
import React from "react";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";

globalThis.window = globalThis.window || { scrollTo() {}, location: { origin: "https://example.invalid" } };
globalThis.window.scrollTo = () => {};
const server = await createServer({ configFile: false, root: new URL("../..", import.meta.url).pathname,
  envDir: "/nonexistent-placeholder-env", logLevel: "error", appType: "custom",
  server: { middlewareMode: true, hmr: false }, esbuild: { jsx: "automatic" } });
after(() => server.close());
const { default: KnowledgeCard } = await server.ssrLoadModule("/src/components/KnowledgeCard.jsx");
const { default: Knowledge } = await server.ssrLoadModule("/src/pages/Knowledge.jsx");
const { default: Framework } = await server.ssrLoadModule("/src/pages/Framework.jsx");

const html = (el, path = "/") => renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [path] }, el));
const at = (path) => html(React.createElement(Routes, null,
  React.createElement(Route, { path: "/resources/:slug", element: React.createElement(Framework) })), path);
const LEFTOVER = /signaling molecules|not a shop|peptide/i;

test("Knowledge card, full and compact, says what it is in neutral words", () => {
  for (const compact of [false, true]) {
    const out = html(React.createElement(KnowledgeCard, { compact }));
    assert.doesNotMatch(out, LEFTOVER);
    assert.match(out, /Knowledge/);
  }
  assert.match(html(React.createElement(KnowledgeCard)), /placeholder for your own articles/);
});

test("Knowledge page is an explicit placeholder", () => {
  const out = html(React.createElement(Knowledge));
  assert.match(out, /No articles have been published yet/);
  assert.doesNotMatch(out, LEFTOVER);
});

test("every linked resource page is a labelled placeholder", () => {
  for (const slug of ["appetite-framework", "system-framework", "structure-framework", "standard-framework", "declassified-identity-scripting"]) {
    const out = at(`/resources/${slug}`);
    assert.match(out, /Resource placeholder/, slug);
    assert.match(out, /The app owner can add/, slug);
  }
});

test("an unknown resource address reads as not found, not as a broken build", () => {
  const out = at("/resources/no-such-page");
  assert.match(out, /Page not found/);
  assert.doesNotMatch(out, /not built|route that does not exist/);
});

test("the community empty state speaks to whoever is looking", async () => {
  const { communityCopy } = await server.ssrLoadModule("/src/lib/communityCopy.js");
  assert.match(communityCopy("coach").empty, /Write the first one/);
  assert.doesNotMatch(communityCopy("coach").empty, /your coach writes/);
  assert.match(communityCopy("client").empty, /When your coach writes/);
});
