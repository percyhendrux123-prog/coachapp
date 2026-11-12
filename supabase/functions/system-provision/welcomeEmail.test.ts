// deno test supabase/functions/system-provision/welcomeEmail.test.ts
import { welcomeEmail } from "./welcomeEmail.ts";
Deno.test("welcome email carries the intake link, plain voice, no hype", () => {
  const m = welcomeEmail({ intakeUrl: "https://x/intake?token=abc" });
  if (!m.text.includes("https://x/intake?token=abc")) throw new Error("link missing");
  if (!m.html.includes('href="https://x/intake?token=abc"')) throw new Error("html link missing");
  if (/!|🎉|crush|let's go|limited/i.test(m.text)) throw new Error("voice violation");
  if (m.subject.length > 60) throw new Error("subject too long");
});
