import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SLIDES, MAX_SLIDE_BYTES, orderSlides, validateSlideFile, reorderedIds,
} from "./briefSlides.js";

const s = (id, position, created_at = "2026-08-30T00:00:00Z") => ({ id, position, created_at });

test("orderSlides: position first, upload time breaks duplicate positions", () => {
  const rows = [
    s("late", 2, "2026-08-30T10:00:00Z"),
    s("dupe-new", 1, "2026-08-30T09:00:00Z"),
    s("dupe-old", 1, "2026-08-30T08:00:00Z"),
  ];
  assert.deepEqual(orderSlides(rows).map((r) => r.id), ["dupe-old", "dupe-new", "late"]);
});

test("validateSlideFile: images pass, video/oversize/nothing fail with a sentence", () => {
  assert.equal(validateSlideFile({ type: "image/jpeg", size: 1000 }).ok, true);
  assert.equal(validateSlideFile({ type: "image/webp", size: 1000 }).ok, true);
  assert.equal(validateSlideFile({ type: "video/mp4", size: 1000 }).ok, false);
  assert.equal(validateSlideFile({ type: "image/png", size: MAX_SLIDE_BYTES + 1 }).ok, false);
  assert.equal(validateSlideFile(null).ok, false);
});

test("byte cap is the 6MB MCP-parity value, not the old 8MB", () => {
  assert.equal(MAX_SLIDE_BYTES, 6 * 1024 * 1024);
  assert.equal(MAX_SLIDES, 12);
});

test("reorderedIds: swaps neighbours by render order, full list returned", () => {
  const rows = [s("a", 1), s("b", 2), s("c", 3)];
  assert.deepEqual(reorderedIds(rows, "b", "up"), ["b", "a", "c"]);
  assert.deepEqual(reorderedIds(rows, "b", "down"), ["a", "c", "b"]);
});

test("reorderedIds: null at the edges and for unknown ids", () => {
  const rows = [s("a", 1), s("b", 2), s("c", 3)];
  assert.equal(reorderedIds(rows, "a", "up"), null);
  assert.equal(reorderedIds(rows, "c", "down"), null);
  assert.equal(reorderedIds(rows, "ghost", "up"), null);
});

test("reorderedIds: duplicate positions (pre-migration data) still reorder by render order", () => {
  // The old model could leave two slides at one position. The RPC renumbers to
  // dense 1..n from whatever order we send, so a move between the duplicates must
  // produce a real, order-changing id list — the exact case the old swap made a no-op.
  const rows = [
    s("a", 1),
    s("b", 2, "2026-08-30T08:00:00Z"),
    s("c", 2, "2026-08-30T09:00:00Z"), // renders after b via created_at tiebreak
  ];
  assert.deepEqual(reorderedIds(rows, "c", "up"), ["a", "c", "b"]);
});
