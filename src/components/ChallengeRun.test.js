// node --test src/components/ChallengeRun.test.js
// Structural contract for the participant challenge surfaces (the behavioral proof of
// the flow itself is src/lib/challengeRunFlow.test.js against the synthetic server).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (rel) => readFileSync(join(root, rel), "utf8");

test("the run view never closes a day in the same press that logs it — it goes through saveDay / tryAdvance", () => {
  const run = source("src/components/ChallengeRun.jsx");
  assert.match(run, /from "\.\.\/lib\/challengeRunFlow"/);
  assert.match(run, /saveDay\(\{/);
  assert.match(run, /tryAdvance\(\{/);
  assert.doesNotMatch(run, /await logDay\([^\n]*\n\s*await closeDay\(/, "log-then-close in one handler is the bug");
  assert.doesNotMatch(run, /closeDay\(run\.id\)/, "closeDay is only reached through the flow's gate handling");
});

test("the run view renders the locked state from the server's next_allowed_at, and a failed log read as a failed read", () => {
  const run = source("src/components/ChallengeRun.jsx");
  assert.match(run, /lockedUntil/);
  assert.match(run, /formatUnlock\(/);
  assert.match(run, /logsFailed/);
  assert.match(run, /failed read, not/i);
});

test("the run view takes an injectable api so previews and tests never reach Supabase", () => {
  const run = source("src/components/ChallengeRun.jsx");
  assert.match(run, /api = participantApi/);
});

test("the challenge page tells a failed read apart from not-found and from not-enrolled", () => {
  const page = source("src/pages/Challenge.jsx");
  assert.match(page, /state === "failed"/);
  assert.match(page, /runState/);
  assert.match(page, /failed read/i);
  assert.doesNotMatch(page, /catch \{ setState\("not-found"\); \}/, "a thrown read must not render as not-found");
});

test("participant invoke errors carry the function's status and body fields (next_allowed_at)", () => {
  const lib = source("src/lib/participant.js");
  assert.match(lib, /functionError\(/);
  assert.match(lib, /next_allowed_at/);
});

test("the challenge preview is gated, synthetic, and mutation-free", () => {
  const app = source("src/App.jsx");
  const preview = source("src/pages/ChallengePreview.jsx");
  assert.match(app, /PREVIEW_ROUTES_ENABLED && \([\s\S]*path="\/__preview\/challenge"/);
  assert.match(preview, /PREVIEW_ROUTES_ENABLED/);
  assert.doesNotMatch(preview, /supabase|participant"/i);
  assert.match(preview, /createSyntheticChallenge/);
  assert.match(preview, /Synthetic data/);
});
