import test from "node:test";
import assert from "node:assert/strict";
import { requestEmailCode, verifyEmailCode } from "./emailAuth.js";

test("requestEmailCode keeps the fallback magic link on the current app origin", async () => {
  let payload;
  const auth = {
    signInWithOtp: async (value) => {
      payload = value;
      return { error: null };
    },
  };

  await requestEmailCode(auth, "  USER@Example.com ", "https://example.test/auth/callback");

  assert.deepEqual(payload, {
    email: "user@example.com",
    options: { emailRedirectTo: "https://example.test/auth/callback" },
  });
});

test("verifyEmailCode creates the session in the browser that entered the code", async () => {
  let payload;
  const auth = {
    verifyOtp: async (value) => {
      payload = value;
      return { data: { session: { access_token: "present" } }, error: null };
    },
  };

  await verifyEmailCode(auth, " USER@Example.com ", " 12 34-56 ");

  assert.deepEqual(payload, {
    email: "user@example.com",
    token: "123456",
    type: "email",
  });
});

test("verifyEmailCode rejects an incomplete code before calling Supabase", async () => {
  let called = false;
  const auth = {
    verifyOtp: async () => {
      called = true;
      return { error: null };
    },
  };

  await assert.rejects(() => verifyEmailCode(auth, "user@example.com", "123"), /6-digit code/);
  assert.equal(called, false);
});
