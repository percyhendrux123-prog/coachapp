import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function source(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("mobile More starts closed on a More destination and is independent of desktop", () => {
  const src = source("src/components/CoachTabs.jsx");

  assert.match(src, /\[desktopMoreOpen,\s*setDesktopMoreOpen\]\s*=\s*useState\(onMore\)/);
  assert.match(src, /\[mobileMoreOpen,\s*setMobileMoreOpen\]\s*=\s*useState\(false\)/);
  assert.match(src, /desktopMoreOpen\s*&&/);
  assert.match(src, /mobileMoreOpen\s*&&/);
  assert.match(src, /setDesktopMoreOpen\(\(v\)\s*=>\s*!v\)/);
  assert.match(src, /setMobileMoreOpen\(\(v\)\s*=>\s*!v\)/);
  assert.match(src, /id="coach-more-nav"[\s\S]*setDesktopMoreOpen\(false\)/);
  assert.match(src, /id="coach-more-nav-mobile"[\s\S]*setMobileMoreOpen\(false\)/);
  assert.match(src, /onMore\s*\|\|\s*mobileMoreOpen/);
  assert.doesNotMatch(src, /const \[moreOpen,\s*setMoreOpen\]/);
  assert.doesNotMatch(src, /if\s*\(onMore\)\s*setMoreOpen\(true\)/);
  assert.doesNotMatch(src, /if\s*\(onMore\)\s*setMobileMoreOpen\(true\)/);
  assert.match(src, /useLocation/);
  assert.match(src, /__preview\/coach-cockpit\?preview=unseen/);
 });
