// Render guard for the coach client detail page (/coach/clients/<id>).
//
// Why: a handler referenced out of scope in AccountInviteButton threw a
// ReferenceError on every client detail render while lint and unit tests stayed
// green, because nothing mounted the page. This test server-renders the real
// ClientDetail (with its invite button row) from a fixture client. Effects do not
// run during SSR, so no network or database calls happen.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

// Placeholder values only so the Supabase client module can initialise; nothing is called.
process.env.VITE_SUPABASE_URL ||= "http://127.0.0.1:54321";
process.env.VITE_SUPABASE_ANON_KEY ||= "render-test-placeholder";

// Test-only: expose the page's private components without changing product code.
const exposeForTest = {
  name: "expose-coach-client-detail",
  enforce: "post",
  transform(code, id) {
    if (!id.endsWith("/src/pages/CoachClients.jsx")) return null;
    return `${code}\nexport { ClientDetail as __ClientDetail, AccountInviteButton as __AccountInviteButton, IntakeInviteButton as __IntakeInviteButton };\n`;
  },
};

const server = await createServer({
  configFile: false,
  root: new URL("../..", import.meta.url).pathname,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false },
  esbuild: { jsx: "automatic" },
  plugins: [exposeForTest],
});
after(() => server.close());

const page = await server.ssrLoadModule("/src/pages/CoachClients.jsx");

const fixture = {
  id: "00000000-0000-4000-8000-000000000001",
  display_name: "Render Fixture",
  email: "fixture@example.com",
  tier: "online",
  status: "active",
  client_type: "general",
  user_id: null,
};

function render(el) {
  return renderToString(h(MemoryRouter, { initialEntries: [`/coach/clients/${fixture.id}`] }, el));
}

test("AccountInviteButton renders without throwing", () => {
  const html = render(h(page.__AccountInviteButton, { client: fixture }));
  assert.match(html, /Copy invite link/);
  assert.doesNotMatch(html, /health screen \+ waiver/, "screen link belongs to IntakeInviteButton only");
});

test("IntakeInviteButton renders and offers the screen + waiver link", () => {
  const html = render(h(page.__IntakeInviteButton, { client: fixture, tenantId: "t-fixture" }));
  assert.match(html, /Copy health screen \+ waiver link/);
});

test("ClientDetail (the /coach/clients/<id> view) renders with the invite row", () => {
  const html = render(h(page.__ClientDetail, {
    client: fixture,
    tenantId: "t-fixture",
    onChanged: () => {},
    onRemoved: () => {},
    initialTab: null,
    onDeepTabConsumed: () => {},
  }));
  assert.match(html, /Render Fixture/);
  assert.match(html, /Copy invite link/);
  assert.match(html, /Copy health screen \+ waiver link/);
});
