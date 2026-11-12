import test from "node:test";
import assert from "node:assert/strict";
import { authChangeNeedsHydration, subscribeToAuthChanges, withTimeout } from "./authLifecycle.js";

test("auth subscription returns synchronously before profile work begins", async () => {
  let callback;
  let unsubscribed = false;
  const auth = {
    onAuthStateChange(fn) {
      callback = fn;
      return { data: { subscription: { unsubscribe: () => { unsubscribed = true; } } } };
    },
  };
  const sessions = [];
  const scheduled = [];
  const unsubscribe = subscribeToAuthChanges(
    auth,
    (session) => sessions.push(session),
    (fn) => scheduled.push(fn),
  );

  const session = { user: { id: "client-1" } };
  const result = callback("SIGNED_IN", session);

  assert.equal(result, undefined);
  assert.deepEqual(sessions, []);
  assert.equal(scheduled.length, 1);

  scheduled[0]();
  assert.deepEqual(sessions, [session]);

  unsubscribe();
  assert.equal(unsubscribed, true);
});

test("initial session event is left to the explicit bootstrap", () => {
  let callback;
  const scheduled = [];
  const auth = {
    onAuthStateChange(fn) {
      callback = fn;
      return { data: { subscription: { unsubscribe() {} } } };
    },
  };
  subscribeToAuthChanges(auth, () => {}, (fn) => scheduled.push(fn));

  callback("INITIAL_SESSION", { user: { id: "client-1" } });

  assert.deepEqual(scheduled, []);
});

test("resume-time auth events keep the mounted client screen for the same user", () => {
  assert.equal(authChangeNeedsHydration("TOKEN_REFRESHED", "client-1", "client-1"), false);
  assert.equal(authChangeNeedsHydration("SIGNED_IN", "client-1", "client-1"), false);
  assert.equal(authChangeNeedsHydration("SIGNED_IN", "client-1", "client-2"), true);
  assert.equal(authChangeNeedsHydration("SIGNED_OUT", "client-1", null), true);
});

test("boot work rejects when it exceeds the deadline", async () => {
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });

  await assert.rejects(
    withTimeout(stalled, 5, "session boot"),
    /session boot timed out/,
  );

  release();
});
