import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const auth = read("../context/AuthContext.jsx");
const client = read("../pages/Client.jsx");
const clientBrief = read("../components/ClientBrief.jsx");
const coachBrief = read("../pages/CoachBrief.jsx");
const login = read("../pages/Login.jsx");
const claim = read("../pages/Claim.jsx");
const app = read("../App.jsx");
const challenge = read("../pages/Challenge.jsx");
const challengeRun = read("../components/ChallengeRun.jsx");
const landing = read("../pages/Landing.jsx");
const oauth = read("../../netlify/functions/mcp-oauth.mjs");
const edgeOauth = read("../../supabase/functions/mcp/index.ts");
const connector = read("./connector.js");
const clientTabs = read("./clientTabs.js");

test("authenticated tenant context carries the stable slug ownership boundary", () => {
  assert.match(auth, /tenants\(id, slug, status, subscription_status\)/);
});

test("non-OWNER clients cannot navigate or deep-link into OWNER-owned Content", () => {
  // The More-sheet entry moved from an inline array literal in Client.jsx into
  // clientTabs.js's moreTabsFor() (2026-09 system-mode work) — same ownedContent gate,
  // new location. The other two guards (deep-link default, tab render) are untouched.
  assert.match(clientTabs, /!self && ownedContent \? \{ id: "content", label: "Content" \} : null/);
  assert.match(client, /wanted !== "content" \|\| ownedSurfaces\.content/);
  assert.match(client, /tab === "content" && ownedSurfaces\.content && <ContentTab/);
});

test("OWNER Knowledge cards are tenant-owned on coach and client Brief", () => {
  assert.match(client, /showKnowledge=\{ownedSurfaces\.knowledge\}/);
  assert.match(clientBrief, /showKnowledge && <KnowledgeCard/);
  assert.match(coachBrief, /isOwnerTenant\(tenant\) && <KnowledgeCard/);
});

test("shared login and claim instructions do not call an outside tenant OWNER", () => {
  for (const source of [login, claim]) {
    assert.doesNotMatch(source, /Keep OWNER|installed OWNER|If OWNER is|kicker="OWNER"/);
  }
  // Tenant-branded login must read its name from the tenant, never the owner.
  assert.match(login, /brand\.coach_display_name \|\| brand\.app_name/);
  assert.doesNotMatch(login + claim, /(?:kicker|title)=["'](?:OWNER|Coach App)["']/);
  assert.match(login, /coaching app window open/);
  assert.match(claim, /coaching app open/);
});

test("shared boot, route loading, landing and challenge auth copy are neutral", () => {
  for (const source of [app, landing, challenge]) {
    assert.doesNotMatch(source, /Keep OWNER|If OWNER|kicker">OWNER|in OWNER/);
  }
  assert.doesNotMatch(landing, /Open challenges|\.from\("challenges"\)/);
});

test("challenge reward is rendered only from rewarded server status", () => {
  assert.doesNotMatch(challenge, /free month of Standard coaching/);
  assert.match(challengeRun, /run\.status === "rewarded"/);
  assert.match(challengeRun, /rewarded \? \(/);
});

test("owner routes are wrapped by fail-closed route policy", () => {
  assert.match(app, /path="\/knowledge" element=\{<OwnerRoute><Knowledge \/><\/OwnerRoute>\}/);
  assert.match(app, /path="\/resources\/:slug" element=\{<OwnerRoute><Framework \/><\/OwnerRoute>\}/);
});

test("connector branding is neutral and uses current credentials", () => {
  assert.match(connector, /"coach_mcp_"/);
  for (const source of [oauth, edgeOauth]) {
    assert.doesNotMatch(source, /Connect your AI to OWNER|placeholder="owner_mcp_|starts with <code>owner_mcp_/);
  }
});
