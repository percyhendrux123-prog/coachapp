import test from "node:test";
import assert from "node:assert/strict";
import {
  neutralBrand,
  ownerRouteDecision,
  challengeResultCopy,
  availableDraftStyles,
  resolveDraftStyle,
  notificationAppName,
  acceptsConnectorToken,
} from "./whiteLabelPolicy.js";

const owner = { slug: "owner" };
const outside = { slug: "outside-coach" };

test("authenticated outside tenants are redirected before owner route content can mount", () => {
  assert.deepEqual(ownerRouteDecision({ user: { id: "u" }, tenant: outside, role: "coach" }), { allow: false, redirectTo: "/coach/brief" });
  assert.deepEqual(ownerRouteDecision({ user: { id: "u" }, tenant: null, role: "client" }), { allow: false, redirectTo: "/client" });
});

test("OWNER members and public acquisition links retain owner routes", () => {
  assert.deepEqual(ownerRouteDecision({ user: { id: "u" }, tenant: owner, role: "client" }), { allow: true, redirectTo: null });
  assert.deepEqual(ownerRouteDecision({ user: null, tenant: null, role: null }), { allow: true, redirectTo: null });
});

test("unresolved branding is neutral rather than owner branded", () => {
  assert.deepEqual(neutralBrand(), { appName: "Coach App", title: "Coach App" });
});

test("challenge reward language follows actual rewarded status", () => {
  assert.equal(challengeResultCopy({ status: "completed", perfect_week: true }).rewarded, false);
  assert.match(challengeResultCopy({ status: "completed", perfect_week: true }).headline, /recorded/i);
  assert.equal(challengeResultCopy({ status: "rewarded", perfect_week: true }).rewarded, true);
  assert.match(challengeResultCopy({ status: "rewarded", perfect_week: true }).detail, /free month of Standard coaching/i);
});

test("the owner draft style is owner-only and stale outside selection fails to balanced", () => {
  assert.equal(availableDraftStyles(outside).some((style) => style.key === "signature"), false);
  assert.equal(resolveDraftStyle("signature", outside), "balanced");
  assert.equal(availableDraftStyles(owner).some((style) => style.key === "signature"), true);
  assert.equal(resolveDraftStyle("signature", owner), "signature");
});

test("notification branding uses configured name and neutral fallback", () => {
  assert.equal(notificationAppName("Riverside Coaching"), "Riverside Coaching");
  assert.equal(notificationAppName(null), "Your coaching app");
});

test("only current connector tokens are accepted as opaque connector credentials", () => {
  assert.equal(acceptsConnectorToken("coach_mcp_abc"), true);
  assert.equal(acceptsConnectorToken("legacy_mcp_abc"), false);
  assert.equal(acceptsConnectorToken("other_abc"), false);
});
