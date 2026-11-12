// Day-0 email: one job — get them into the intake. Short lines, plain language.
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
    "The self-serve plan gives you the structure. It won't hold you to it. That's coaching.",
    "",
    `— ${Deno.env.get("COACH_SIGNATURE") || "Your coach"}`,
  ].join("\n");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = text.split("\n").map((l) => l === intakeUrl
    ? `<p><a href="${esc(intakeUrl)}">Open your intake</a></p>`
    : `<p>${l ? esc(l) : "&nbsp;"}</p>`).join("");
  return { subject, text, html };
}
