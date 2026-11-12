import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (rel) => readFileSync(join(root, rel), "utf8");

test("client preview is explicitly gated and mutation-free", () => {
  const app = source("src/App.jsx");
  const preview = source("src/pages/ClientPreview.jsx");
  assert.match(app, /PREVIEW_ROUTES_ENABLED && \([\s\S]*path="\/__preview\/client"/);
  assert.match(preview, /PREVIEW_ROUTES_ENABLED/);
  assert.doesNotMatch(preview, /supabase|submit|sendMessage|logSet|upsert/i);
  assert.match(preview, /Not live data/);
  assert.match(preview, /Demo Client A/);
});
