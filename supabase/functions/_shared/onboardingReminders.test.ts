// deno test supabase/functions/_shared/onboardingReminders.test.ts
import {
  coachDigestLine, coachDigestPush, decide, fromHeader, idempotencyKey, reminderMessage,
  type Candidate,
} from "./onboardingReminders.ts";

const LINK = "https://app.example.com/intake?token=abc";

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  tenant_id: "t", tenant_slug: "owner", client_id: "c1", display_name: "Test Client",
  email: "client@example.com", template: "intake_reminder", threshold_day: 3, ref: "form-1",
  link_path: "/intake?token=abc", expires_at: null, since: "2026-09-01T00:00:00Z", days_since: 3,
  switch_on: true, sender_email: "coach@example.com", push_subscription: null, push_ok: false,
  ...over,
});
const VERIFIED = new Set(["example.com"]);

// ---------- copy: every approved template renders, none carries a hard-fail character ----------
const CASES: [Candidate["template"], number, string][] = [
  ["intake_reminder", 3, "Your intake is still open"],
  ["intake_reminder", 10, "Four days left on your intake link"],
  ["invite_reminder", 3, "Your app access is waiting"],
  ["invite_reminder", 10, "Four days left on your access link"],
  ["first_open_reminder", 2, "Day one is ready"],
];

for (const [tpl, day, subject] of CASES) {
  Deno.test(`copy: ${tpl} day ${day} — approved subject, no exclamation, no emoji, link present where approved`, () => {
    const m = reminderMessage(tpl, day, LINK);
    if (m.subject !== subject) throw new Error(`subject ${m.subject}`);
    const all = m.subject + m.text + (m.push?.body ?? "");
    if (/!/.test(all)) throw new Error("exclamation point in approved copy");
    if (/[\u{1F300}-\u{1FAFF}]/u.test(all)) throw new Error("emoji in approved copy");
    if (tpl !== "first_open_reminder" && !m.text.includes(LINK)) throw new Error("link missing from text");
    if (tpl !== "first_open_reminder" && !m.html.includes(`href="${LINK}"`)) throw new Error("link missing from html");
    if (tpl === "first_open_reminder" && m.text.includes(LINK)) throw new Error("first-open email must not carry a link");
  });
}

Deno.test("copy: first_open push = the last two lines, titled with the app name when there is one", () => {
  const m = reminderMessage("first_open_reminder", 2, LINK, "Riverside Coaching");
  if (!m.push || m.push.title !== "Riverside Coaching") throw new Error(JSON.stringify(m.push));
  if (m.push.body !== "Start the day marked Now. Log every set. That is the whole job this week.") throw new Error(m.push.body);
  if (m.push.url !== "/client") throw new Error(m.push.url);
});

Deno.test("copy: an unapproved template/day pair throws rather than improvising", () => {
  let threw = false;
  try { reminderMessage("intake_reminder", 7, LINK); } catch { threw = true; }
  if (!threw) throw new Error("day 7 has no approved copy and must not render");
});

Deno.test("copy: html escapes a hostile link and a hostile app name", () => {
  const m = reminderMessage("intake_reminder", 3, 'https://x.test/?a=<b>&c="d"');
  if (m.html.includes("<b>")) throw new Error("unescaped html in link");
  const p = reminderMessage("first_open_reminder", 2, LINK, "<script>x</script>\nY");
  if (p.push!.title.includes("<")) throw new Error("unescaped app name in push title");
});

// ---------- decision order ----------
Deno.test("decide: switch off wins over everything else", () => {
  const d = decide(cand({ switch_on: false, sender_email: null, email: null }), VERIFIED);
  if (d.action !== "skip" || d.status !== "skipped_switch_off") throw new Error(JSON.stringify(d));
});

Deno.test("decide: no sender → skipped_no_sender (white-label default)", () => {
  const d = decide(cand({ sender_email: null }), VERIFIED);
  if (d.action !== "skip" || d.status !== "skipped_no_sender") throw new Error(JSON.stringify(d));
});

Deno.test("decide: sender on an unverified domain → skipped_sender_unverified", () => {
  const d = decide(cand({ sender_email: "coach@example.test" }), VERIFIED);
  if (d.action !== "skip" || d.status !== "skipped_sender_unverified") throw new Error(JSON.stringify(d));
});

Deno.test("decide: no client email, or an invalid one → skipped_no_email", () => {
  for (const email of [null, "", "not-an-email", "a@@example.com"]) {
    const d = decide(cand({ email }), VERIFIED);
    if (d.action !== "skip" || d.status !== "skipped_no_email") throw new Error(`${email}: ${JSON.stringify(d)}`);
  }
});

Deno.test("decide: everything present → send by email; first_open adds push only when subscribed", () => {
  const a = decide(cand(), VERIFIED);
  if (a.action !== "send" || a.channels.join() !== "email") throw new Error(JSON.stringify(a));
  const b = decide(cand({ template: "first_open_reminder", threshold_day: 2, push_ok: true, push_subscription: {} }), VERIFIED);
  if (b.action !== "send" || b.channels.join() !== "email,push") throw new Error(JSON.stringify(b));
  const c = decide(cand({ template: "intake_reminder", push_ok: true, push_subscription: {} }), VERIFIED);
  if (c.action !== "send" || c.channels.join() !== "email") throw new Error("intake reminders are email only");
});

Deno.test("idempotency key carries template, day, client and the token ref", () => {
  const k = idempotencyKey(cand({ threshold_day: 10, ref: "form-9" }));
  if (k !== "onboarding-intake_reminder-10-c1-form-9") throw new Error(k);
});

Deno.test("fromHeader: display name attached only when present, header-injection characters stripped", () => {
  if (fromHeader("coach@example.com") !== "coach@example.com") throw new Error("bare");
  if (fromHeader("coach@example.com", "Sam Rivera") !== "Sam Rivera <coach@example.com>") throw new Error("named");
  const hostile = fromHeader("p@example.com", "Evil\r\nBcc: a@example.test <x>");
  if (/[\r\n]/.test(hostile) || hostile !== "Evil Bcc: a@example.test x <p@example.com>") throw new Error(hostile);
});

// ---------- coach digest ----------
Deno.test("coach digest line: approved shape, nothing when nothing is owed", () => {
  if (coachDigestLine({ owed: 0, buckets: [], longest: null, switch_on: true }) !== null) throw new Error("empty must be null");
  const line = coachDigestLine({
    owed: 4, switch_on: true,
    buckets: [{ key: "drafts_without_macros", label: "nutrition drafts without macros", n: 2 }, { key: "no_nutrition_plan", label: "no nutrition plan", n: 1 }, { key: "invite_not_sent", label: "invite not sent", n: 1 }],
    longest: { display_name: "Sam Rivera", days: 12 },
  });
  const want = "Owed by you, 3+ days: 2 nutrition drafts without macros · 1 no nutrition plan · 1 invite not sent. Longest waiting: Sam Rivera, 12 days. Open Clients → Stuck.";
  if (line !== want) throw new Error(line ?? "null");
  const push = coachDigestPush({ owed: 4, buckets: [], longest: null, switch_on: true });
  if (push?.body !== "4 things owed by you 3+ days. Open Clients → Stuck.") throw new Error(push?.body);
  if (coachDigestPush({ owed: 1, buckets: [], longest: null, switch_on: true })?.body !== "1 thing owed by you 3+ days. Open Clients → Stuck.") throw new Error("singular");
});
