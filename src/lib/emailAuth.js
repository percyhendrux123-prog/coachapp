function normalizedEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizedCode(token) {
  return String(token || "").replace(/\D/g, "");
}

export function requestEmailCode(auth, email, redirectTo) {
  return auth.signInWithOtp({
    email: normalizedEmail(email),
    options: { emailRedirectTo: redirectTo },
  });
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
