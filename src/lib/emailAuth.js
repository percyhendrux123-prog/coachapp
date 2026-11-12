// Email sign-in with a 6-digit code.
//
// Sign-ups can be open or closed in Supabase (Authentication > Sign In / Providers >
// "Allow new users to sign up"). Both must work for an invited client:
//
// - Open: signInWithOtp() sends the code. For an address with no account yet it also
//   creates one.
// - Closed: Supabase Auth (seen on GoTrue v2.197.0) refuses signInWithOtp() with
//   422 signup_disabled for every address that has no CONFIRMED account. That
//   includes an invited client, whose account the invite pre-created unconfirmed
//   (client-invite, release, checkout provisioning). So when the first call is
//   refused that way, ask Auth to resend the signup confirmation instead. /resend
//   creates nothing: for an unconfirmed invited account it emails the "Confirm
//   signup" message (which carries the code), and for an address with no account it
//   answers 200 and sends nothing. A stranger therefore still cannot create an
//   account, and the invited client still proves the mailbox: entering the code is
//   what sets email_confirmed_at, which claim_client_invite() requires.
//
// The caller cannot tell those two cases apart (and should not: that would reveal
// which addresses are invited), so the result carries via: "confirmation" and the
// screen says "if your coach invited this email".

function normalizedEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizedCode(token) {
  return String(token || "").replace(/\D/g, "");
}

// 422 from /otp when "Allow new users to sign up" is off. GoTrue v2.197 sends
// signup_disabled; otp_disabled is what it sends when create_user is false.
export function isSignupClosedError(error) {
  if (!error) return false;
  if (error.code === "signup_disabled" || error.code === "otp_disabled") return true;
  return error.status === 422 && /signups? not allowed/i.test(String(error.message || ""));
}

export async function requestEmailCode(auth, email, redirectTo) {
  const address = normalizedEmail(email);
  const first = await auth.signInWithOtp({
    email: address,
    options: { emailRedirectTo: redirectTo },
  });
  if (!first?.error || !isSignupClosedError(first.error)) return first;

  const second = await auth.resend({
    type: "signup",
    email: address,
    options: { emailRedirectTo: redirectTo },
  });
  if (second?.error) return second;
  return { data: second?.data ?? null, error: null, via: "confirmation" };
}

export async function verifyEmailCode(auth, email, token) {
  const code = normalizedCode(token);
  if (code.length !== 6) {
    throw new Error("Enter the 6-digit code from your email.");
  }

  return auth.verifyOtp({
    email: normalizedEmail(email),
    token: code,
    type: "email",
  });
}

// Calm, honest copy for the auth errors a real person is likely to hit.
export function friendlyAuthError(error) {
  if (error?.code === "over_email_send_rate_limit" || error?.status === 429) {
    return "We've hit our email limit for the moment. Please wait a few minutes and try again. This is a temporary limit, not a problem with your account.";
  }
  if (error?.code === "email_address_not_authorized" || /address not authorized/i.test(String(error?.message || ""))) {
    return "The app can't email this address yet. Ask your coach for a sign-in code instead.";
  }
  return error?.message || "Something went wrong. Please try again.";
}

// Shown with the code box when the code went out as a signup confirmation, because
// the app cannot (and should not) say whether this address was invited.
export const CONFIRMATION_SENT_HINT =
  "If your coach invited this email, the code is on its way. Nothing after a few minutes? Check spam, then ask your coach for a new invite or a sign-in code.";
