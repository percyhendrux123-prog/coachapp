import test from "node:test";
import assert from "node:assert/strict";
import { parsePromoUrl, validateReelFile, uploadedReelPath, MAX_REEL_BYTES } from "./promo.js";

test("parsePromoUrl still plays direct files — uploads reuse this path untouched", () => {
  assert.equal(parsePromoUrl("https://x.supabase.co/storage/v1/object/public/brand/t1/brief-video/a.mp4").kind, "file");
  assert.equal(parsePromoUrl("https://youtu.be/abc123").kind, "youtube");
});

test("validateReelFile: mp4/webm clean, mov passes with a cross-device warning", () => {
  assert.equal(validateReelFile({ type: "video/mp4", size: 1000 }).ok, true);
  assert.equal(validateReelFile({ type: "video/mp4", size: 1000 }).warning, null);
  assert.equal(validateReelFile({ type: "video/webm", size: 1000 }).ok, true);
  const mov = validateReelFile({ type: "video/quicktime", size: 1000 });
  assert.equal(mov.ok, true);
  assert.match(mov.warning, /mp4/);
});

test("validateReelFile: wrong type and oversize fail with a sentence", () => {
  assert.equal(validateReelFile({ type: "image/gif", size: 1000 }).ok, false);
  assert.equal(validateReelFile({ type: "video/mp4", size: MAX_REEL_BYTES + 1 }).ok, false);
  assert.equal(validateReelFile(null).ok, false);
});

test("uploadedReelPath: only OUR brief-video uploads are cleanup candidates", () => {
  assert.equal(
    uploadedReelPath("https://x.supabase.co/storage/v1/object/public/brand/t1/brief-video/a.mp4"),
    "t1/brief-video/a.mp4",
  );
  // Never touch: pasted links, other brand files (logos!), other buckets, garbage.
  assert.equal(uploadedReelPath("https://youtu.be/abc123"), null);
  assert.equal(uploadedReelPath("https://x.supabase.co/storage/v1/object/public/brand/t1/logo-99.png"), null);
  assert.equal(uploadedReelPath("https://x.supabase.co/storage/v1/object/public/resources/t1/brief-video/a.mp4"), null);
  assert.equal(uploadedReelPath(""), null);
  assert.equal(uploadedReelPath("not a url"), null);
  assert.equal(uploadedReelPath(null), null);
});
