import test from "node:test";
import assert from "node:assert/strict";
import { readOutcome } from "./readOutcome.js";

test("readOutcome preserves a successful empty result", async () => {
  assert.deepEqual(await readOutcome(Promise.resolve(null)), {
    state: "ready",
    value: null,
  });
});

test("readOutcome marks a rejected read as failed instead of empty", async () => {
  const error = new Error("offline");
  const result = await readOutcome(Promise.reject(error));
  assert.equal(result.state, "failed");
  assert.equal(result.error, error);
  assert.equal("value" in result, false);
});
