// coachPushTemplate — what a coach's phone shows when a client messages or checks in.
// Pure function; runs under plain `deno test`.
import { coachPushTemplate } from "./notification-brand.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("check-in: title names the client, opens the coach home", () => {
  const t = coachPushTemplate("checkin", "Kristopher M.");
  assert(t.title === "Kristopher M. checked in", `title was ${t.title}`);
  assert(t.url === "/coach", `url was ${t.url}`);
  assert(t.body.length > 0, "body must not be empty");
});

Deno.test("message: body is the first 90 chars, whitespace collapsed, opens the inbox", () => {
  const long = "hey  coach\n\n" + "x".repeat(200);
  const t = coachPushTemplate("message", "Dana", long);
  assert(t.title === "Dana messaged you", `title was ${t.title}`);
  assert(t.url === "/coach/inbox", `url was ${t.url}`);
  assert(t.body.startsWith("hey coach x"), `body was ${t.body.slice(0, 20)}`);
  assert(t.body.length === 90, `body length was ${t.body.length}`);
});

Deno.test("no name and no body still produce a usable notification (no blanks, no HTML)", () => {
  const t = coachPushTemplate("message", "<script>", "");
  assert(!t.title.includes("<"), "angle brackets must be stripped from the name");
  assert(t.body === "Tap to open the inbox.", `body was ${t.body}`);
  const u = coachPushTemplate("checkin", null);
  assert(u.title === "A client checked in", `title was ${u.title}`);
});
