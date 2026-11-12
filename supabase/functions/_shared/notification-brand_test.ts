import { notificationAppName, pushTemplate } from "./notification-brand.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
};

Deno.test("configured tenant app name brands push and SMS", () => {
  assertEquals(pushTemplate("message", "Riverside Coaching").title, "Riverside Coaching");
  assertEquals(notificationAppName("Riverside Coaching"), "Riverside Coaching");
});

Deno.test("missing or unsafe app name uses neutral branding", () => {
  assertEquals(pushTemplate("checkin_due", null).title, "Your coach");
  assertEquals(notificationAppName(null), "Your coaching app");
  assertEquals(notificationAppName("A&B <Coaching>"), "AandB Coaching");
});
