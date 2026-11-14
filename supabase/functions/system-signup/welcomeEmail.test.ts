// deno test supabase/functions/system-signup/welcomeEmail.test.ts
import { signInEmail, welcomeEmail } from "./welcomeEmail.ts";
Deno.test("welcome email carries the intake link, plain voice, no hype", () => {
  const m = welcomeEmail({ intakeUrl: "https://x/intake?token=abc" });
  if (!m.text.includes("https://x/intake?token=abc")) throw new Error("link missing");
  if (!m.html.includes('href="https://x/intake?token=abc"')) throw new Error("html link missing");
  if (/!|🎉|crush|let's go|limited/i.test(m.text)) throw new Error("voice violation");
  if (m.subject.length > 60) throw new Error("subject too long");
});
Deno.test("sign-in email carries the login link and no intake token", () => {
  const m = signInEmail({ loginUrl: "https://x/login" });
  if (!m.text.includes("https://x/login")) throw new Error("link missing");
  if (/token=/.test(m.text + m.html)) throw new Error("no intake token in a sign-in email");
  if (m.subject.length > 60) throw new Error("subject too long");
});
Deno.test("neither email sells coaching", () => {
  for (const m of [welcomeEmail({ intakeUrl: "https://x/i" }), signInEmail({ loginUrl: "https://x/l" })]) {
    if (/coach/i.test(m.text)) throw new Error("coaching line in a self-serve email");
  }
});
