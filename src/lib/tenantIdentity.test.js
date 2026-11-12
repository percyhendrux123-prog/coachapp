import test from "node:test";
import assert from "node:assert/strict";
import { isOwnerTenant, whiteLabelOwnedSurfaces } from "./tenantIdentity.js";

const OWNER = { slug: "owner" };
const OUTSIDE = { slug: "outside-coach" };

test("OWNER retains its owned Content and Knowledge surfaces", () => {
  assert.equal(isOwnerTenant(OWNER), true);
  assert.deepEqual(whiteLabelOwnedSurfaces(OWNER), { content: true, knowledge: true });
});

test("outside white-label tenants never inherit OWNER Content or Knowledge", () => {
  assert.equal(isOwnerTenant(OUTSIDE), false);
  assert.deepEqual(whiteLabelOwnedSurfaces(OUTSIDE), { content: false, knowledge: false });
  assert.deepEqual(whiteLabelOwnedSurfaces(null), { content: false, knowledge: false });
});
