// src/lib/clientTabs.test.js — run: node --test src/lib/clientTabs.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { PRIMARY_TABS, primaryTabsFor, moreTabsFor } from "./clientTabs.js";

const ids = (tabs) => tabs.map((t) => t.id);

test("coached primary tabs are unchanged", () => {
  assert.deepEqual(ids(primaryTabsFor("coached")), ["program", "nutrition", "check-in", "brief"]);
  assert.deepEqual(primaryTabsFor("coached"), PRIMARY_TABS);
});

test("self-serve drops Brief from the primary bar", () => {
  assert.deepEqual(ids(primaryTabsFor("self_serve")), ["program", "nutrition", "check-in"]);
});

test("unknown or missing mode renders as coached (fail closed to today's UI)", () => {
  assert.deepEqual(ids(primaryTabsFor(undefined)), ids(primaryTabsFor("coached")));
  assert.deepEqual(ids(primaryTabsFor("garbage")), ids(primaryTabsFor("coached")));
});

test("coached more-sheet keeps every surface", () => {
  const got = ids(moreTabsFor({ mode: "coached", messagingOn: true, ownedContent: true }));
  assert.deepEqual(got, ["messages", "activity", "history", "progress", "videos", "resources", "content", "community", "profile", "settings", "about"]);
});

test("self-serve more-sheet has no coach surface", () => {
  const got = ids(moreTabsFor({ mode: "self_serve", messagingOn: true, ownedContent: true }));
  assert.deepEqual(got, ["activity", "history", "progress", "profile", "settings"]);
  for (const banned of ["messages", "videos", "resources", "content", "community", "about", "brief"]) {
    assert.ok(!got.includes(banned), `${banned} must not appear in self-serve`);
  }
});
