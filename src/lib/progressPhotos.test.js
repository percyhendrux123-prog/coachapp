import test from "node:test";
import assert from "node:assert/strict";
import { defaultComparePair, emptyPhotosReason } from "./progressPhotos.js";

const p = (id, taken_at) => ({ id, taken_at, photo_url: `t/c/${id}.jpg` });

test("compare pair: earliest vs latest from a newest-first list", () => {
  const photos = [p("c", "2026-08-29"), p("b", "2026-07-01"), p("a", "2026-05-01")];
  const pair = defaultComparePair(photos);
  assert.equal(pair.before.id, "a");
  assert.equal(pair.after.id, "c");
  assert.equal(pair.single, false);
});

test("compare pair: one photo is single, empty is null", () => {
  assert.equal(defaultComparePair([]), null);
  assert.equal(defaultComparePair(null), null);
  const pair = defaultComparePair([p("only", "2026-08-01")]);
  assert.equal(pair.single, true);
  assert.equal(pair.before.id, "only");
});

// THE GATE's twin-facts rule: zero (client fact) vs not_tracked (system fact) vs
// unknown (settings unreadable) must never collapse into each other.
test("empty reason: prompts on -> zero (a fact about the client)", () => {
  assert.equal(emptyPhotosReason({ tenantPhotosOn: true, checkinFieldsPhotos: true }), "zero");
});

test("empty reason: either switch off -> not_tracked (a fact about the system)", () => {
  assert.equal(emptyPhotosReason({ tenantPhotosOn: false, checkinFieldsPhotos: true }), "not_tracked");
  assert.equal(emptyPhotosReason({ tenantPhotosOn: true, checkinFieldsPhotos: false }), "not_tracked");
  assert.equal(emptyPhotosReason({ tenantPhotosOn: false, checkinFieldsPhotos: false }), "not_tracked");
});

test("empty reason: unreadable settings -> unknown, never guessed either way", () => {
  assert.equal(emptyPhotosReason({ tenantPhotosOn: null, checkinFieldsPhotos: true }), "unknown");
  assert.equal(emptyPhotosReason({ tenantPhotosOn: true, checkinFieldsPhotos: null }), "unknown");
  assert.equal(emptyPhotosReason({ tenantPhotosOn: undefined, checkinFieldsPhotos: undefined }), "unknown");
});
