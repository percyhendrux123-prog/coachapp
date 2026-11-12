// Reminders on onboarding stalls. Shared by onboarding-nudge (the sender) and send-digest
// (the coach section). Review template changes before sending them to clients.
//
// This file holds no I/O. Everything in it is a pure function so the decision a run makes
// for each candidate is unit-testable without a database or Resend.

export type Template = "intake_reminder" | "invite_reminder" | "first_open_reminder";

export type Candidate = {
  tenant_id: string;
  tenant_slug: string;
  client_id: string;
  display_name: string | null;
  email: string | null;
  template: Template;
  threshold_day: number;
  ref: string;
  link_path: string;
  expires_at: string | null;
  since: string;
  days_since: number;
  switch_on: boolean;
  sender_email: string | null;
  push_subscription: unknown | null;
  push_ok: boolean;
};

export type Message = { subject: string; text: string; html: string; push?: { title: string; body: string; url: string } };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(lines: string[], link: string | null): { text: string; html: string } {
  const text = lines.join("\n");
  const html = lines.map((l) => {
    if (link && l === link) return `<p><a href="${esc(link)}">${esc(link)}</a></p>`;
    return `<p>${l ? esc(l) : "&nbsp;"}</p>`;
  }).join("");
  return { text, html };
}

// The four approved templates. {link} is the full URL (origin + link_path).
export function reminderMessage(template: Template, thresholdDay: number, link: string, appName?: string | null): Message {
  if (template === "intake_reminder" && thresholdDay === 3) {
    return { subject: "Your intake is still open", ...render([
      "Your program gets built from this. About eight minutes.",
      link,
      "If something is in the way, reply and tell me what.",
    ], link) };
  }
  if (template === "intake_reminder" && thresholdDay === 10) {
    return { subject: "Four days left on your intake link", ...render([
      "This link stops working in four days.",
      link,
      "After that I send a new one, and nothing gets built in between. Do it today.",
    ], link) };
  }
  if (template === "invite_reminder" && thresholdDay === 3) {
    return { subject: "Your app access is waiting", ...render([
      "Your program is released. It is sitting in the app.",
      link,
      "Open it, enter this email address, type the code. No password.",
    ], link) };
  }
  if (template === "invite_reminder" && thresholdDay === 10) {
    return { subject: "Four days left on your access link", ...render([
      link,
      "This link dies in four days. Open it today and the program is yours.",
    ], link) };
  }
  if (template === "first_open_reminder") {
    const title = String(appName || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 80) || "Your coach";
    return {
      subject: "Day one is ready",
      ...render([
        "You are in. The program is on the Train tab.",
        "Start the day marked Now. Log every set.",
        "That is the whole job this week.",
      ], null),
      // Push, if subscribed, = the last two lines.
      push: { title, body: "Start the day marked Now. Log every set. That is the whole job this week.", url: "/client" },
    };
  }
  throw new Error(`no approved copy for ${template} day ${thresholdDay}`);
}

// The coach digest line (send-digest, operational register). Not a separate email.
export type CoachDigest = {
  owed: number;
  buckets: { key: string; label: string; n: number }[];
  longest: { display_name: string; days: number } | null;
  switch_on: boolean;
};

export function coachDigestLine(d: CoachDigest): string | null {
  if (!d || d.owed === 0) return null;
  const parts = d.buckets.filter((b) => b.n > 0).map((b) => `${b.n} ${b.label}`).join(" · ");
  const longest = d.longest ? ` Longest waiting: ${d.longest.display_name}, ${d.longest.days} days.` : "";
  return `Owed by you, 3+ days: ${parts}.${longest} Open Clients → Stuck.`;
}

export function coachDigestPush(d: CoachDigest): { title: string; body: string; url: string } | null {
  if (!d || d.owed === 0) return null;
  return { title: "Onboarding", body: `${d.owed} thing${d.owed === 1 ? "" : "s"} owed by you 3+ days. Open Clients → Stuck.`, url: "/coach/clients?stuck=1" };
}

// ---------- the decision per candidate ----------
// Returned in the order a reader would ask: is it switched on → is there a sender → is the
// sender's domain verified → is there an address to send to. The first "no" is the log row.
export type Decision =
  | { action: "send"; channels: ("email" | "push")[] }
  | { action: "skip"; status: "skipped_switch_off" | "skipped_no_sender" | "skipped_sender_unverified" | "skipped_no_email" };

export function decide(c: Candidate, verifiedDomains: Set<string>): Decision {
  if (!c.switch_on) return { action: "skip", status: "skipped_switch_off" };
  const sender = String(c.sender_email || "").trim().toLowerCase();
  if (!sender) return { action: "skip", status: "skipped_no_sender" };
  const domain = sender.split("@")[1] || "";
  if (!verifiedDomains.has(domain)) return { action: "skip", status: "skipped_sender_unverified" };
  const email = String(c.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { action: "skip", status: "skipped_no_email" };
  const channels: ("email" | "push")[] = ["email"];
  if (c.template === "first_open_reminder" && c.push_ok) channels.push("push");
  return { action: "send", channels };
}

// Resend idempotency key: the same tuple the notification_log unique index enforces.
export const idempotencyKey = (c: Candidate) => `onboarding-${c.template}-${c.threshold_day}-${c.client_id}-${c.ref}`;

// The from header. A display name is only attached when the tenant has one; the bare
// address is a valid sender on its own.
export function fromHeader(senderEmail: string, coachDisplayName?: string | null): string {
  const name = String(coachDisplayName || "").replace(/[\r\n<>"]/g, " ").replace(/\s+/g, " ").trim();
  return name ? `${name} <${senderEmail}>` : senderEmail;
}
