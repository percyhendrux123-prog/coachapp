// Emails for the free self-serve signup. One job each, short lines, plain language. No price,
// no receipt, no payment words (copyGuard.test.ts).
const signature = () => `— ${Deno.env.get("SYSTEM_EMAIL_SIGNATURE") || "Self-serve plan"}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function toHtml(text: string, link: string, label: string) {
  return text.split("\n").map((l) => l === link
    ? `<p><a href="${esc(link)}">${esc(label)}</a></p>`
    : `<p>${l ? esc(l) : "&nbsp;"}</p>`).join("");
}

// A new signup (or one who has not submitted the intake yet): get them into the intake.
export function welcomeEmail({ intakeUrl }: { intakeUrl: string }) {
  const subject = "Self-serve plan — your intake link";
  const text = [
    "You're in.",
    "",
    "Next step is a short intake. Your training week and your nutrition targets are built from what you enter. About eight minutes.",
    "",
    intakeUrl,
    "",
    "When it's done, sign in with this email address and your program is waiting.",
    "",
    "The self-serve plan gives you the structure. It won't hold you to it.",
    "",
    "If you did not ask for this, ignore this email. Nothing happens without the intake.",
    "",
    signature(),
  ].join("\n");
  return { subject, text, html: toHtml(text, intakeUrl, "Open your intake") };
}

// Someone who already started: no new intake link from a public form. They sign in.
export function signInEmail({ loginUrl }: { loginUrl: string }) {
  const subject = "Self-serve plan — sign in";
  const text = [
    "This email address already has a self-serve plan.",
    "",
    "Sign in with this address to open it. To change your numbers, use Settings → Update my numbers once you are in.",
    "",
    loginUrl,
    "",
    "If you did not ask for this, ignore this email.",
    "",
    signature(),
  ].join("\n");
  return { subject, text, html: toHtml(text, loginUrl, "Sign in") };
}
