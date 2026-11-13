import test from "node:test";
import assert from "node:assert/strict";
import { friendlyAuthError, isSignupClosedError, requestEmailCode, verifyEmailCode } from "./emailAuth.js";

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

  await assert.rejects(() => verifyEmailCode(auth, "user@example.com", "123"), /whole code/);
  await assert.rejects(() => verifyEmailCode(auth, "user@example.com", "12345678901"), /whole code/);
  assert.equal(called, false);
});

// Sign-ups closed (GoTrue v2.197): /otp refuses every address without a CONFIRMED
// account with 422 signup_disabled, including an invited client whose account the
// invite pre-created unconfirmed. The request falls back to /resend type "signup",
// which emails the code to an existing unconfirmed account and creates nothing.
function closedAuth(calls) {
  return {
    signInWithOtp: async (value) => {
      calls.push(["otp", value]);
      return { data: null, error: { status: 422, code: "signup_disabled", message: "Signups not allowed for this instance" } };
    },
    resend: async (value) => {
      calls.push(["resend", value]);
      return { data: {}, error: null };
    },
  };
}

test("requestEmailCode falls back to a signup confirmation when sign-ups are closed", async () => {
  const calls = [];
  const res = await requestEmailCode(closedAuth(calls), " Client@Example.com ", "https://example.test/claim?token=t");
  assert.equal(res.error, null);
  assert.equal(res.via, "confirmation");
  assert.deepEqual(calls[1], ["resend", {
    type: "signup",
    email: "client@example.com",
    options: { emailRedirectTo: "https://example.test/claim?token=t" },
  }]);
});

test("requestEmailCode never resends when the first request worked", async () => {
  const calls = [];
  const auth = {
    signInWithOtp: async (v) => { calls.push(v); return { data: {}, error: null }; },
    resend: async () => { throw new Error("must not be called"); },
  };
  const res = await requestEmailCode(auth, "a@example.com", "https://example.test/auth/callback");
  assert.equal(res.error, null);
  assert.equal(res.via, undefined);
  assert.equal(calls.length, 1);
});

test("requestEmailCode passes other errors through without a fallback", async () => {
  const auth = {
    signInWithOtp: async () => ({ error: { status: 429, code: "over_email_send_rate_limit", message: "rate" } }),
    resend: async () => { throw new Error("must not be called"); },
  };
  const res = await requestEmailCode(auth, "a@example.com");
  assert.equal(res.error.code, "over_email_send_rate_limit");
});

test("requestEmailCode reports a failed fallback instead of claiming a code was sent", async () => {
  const auth = {
    signInWithOtp: async () => ({ error: { status: 422, code: "signup_disabled", message: "Signups not allowed for this instance" } }),
    resend: async () => ({ data: null, error: { status: 429, code: "over_email_send_rate_limit", message: "rate" } }),
  };
  const res = await requestEmailCode(auth, "a@example.com");
  assert.equal(res.error.code, "over_email_send_rate_limit");
  assert.equal(res.via, undefined);
});

test("isSignupClosedError recognises both closed-sign-up codes and the bare 422 message", () => {
  assert.equal(isSignupClosedError({ code: "signup_disabled" }), true);
  assert.equal(isSignupClosedError({ code: "otp_disabled" }), true);
  assert.equal(isSignupClosedError({ status: 422, message: "Signups not allowed for otp" }), true);
  assert.equal(isSignupClosedError({ status: 422, message: "Invalid email" }), false);
  assert.equal(isSignupClosedError(null), false);
});

test("friendlyAuthError explains the default-mailer refusal and the rate limit", () => {
  assert.match(friendlyAuthError({ code: "email_address_not_authorized", message: "Email address not authorized" }), /sign-in code/);
  assert.match(friendlyAuthError({ status: 429 }), /email limit/);
  assert.equal(friendlyAuthError({ message: "Token has expired or is invalid" }), "Token has expired or is invalid");
});

// New hosted projects default to 8-digit email codes (measured: mailer_otp_length = 8 on a
// project created 2026-11-12). The app used to refuse anything but 6 digits, so nobody on a
// new project could sign in.
test("verifyEmailCode accepts the 8-digit codes new Supabase projects send", async () => {
  let payload;
  const auth = { verifyOtp: async (v) => { payload = v; return { error: null }; } };
  await verifyEmailCode(auth, "user@example.com", "1234 5678");
  assert.equal(payload.token, "12345678");
  await verifyEmailCode(auth, "user@example.com", "1234567890");
  assert.equal(payload.token, "1234567890");
});
