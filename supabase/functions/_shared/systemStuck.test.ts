// Run: deno test --no-check --allow-read supabase/functions/_shared/systemStuck.test.ts
// (--no-check to import the plain-JS console twin, same as effectiveDays.parity.test.ts)
import { STUCK_AFTER_HOURS, stuckLine, stuckReasons, stuckSystemBuyers, type SystemBuyerRow } from "./systemStuck.ts";
import * as spa from "../../../src/lib/systemStuck.js";

function assertEquals(actual: unknown, expected: unknown, msg = "") {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const NOW = new Date("2026-09-29T23:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600000).toISOString();

const base: SystemBuyerRow = {
  client_id: "e5e67b83-0000-0000-0000-000000000000",
  display_name: "Sam Rivera",
  email_masked: "s…m@example.com",
  intake_status: "submitted",
  intake_submitted_at: "2026-09-16T01:18:00Z",
  program_published: false,
  meal_plan_assigned: false,
  has_account: false,
  converted_client_id: null,
};

Deno.test("paid, submitted, nothing published, no account → stuck on all three", () => {
  assertEquals(stuckReasons(base, NOW), ["program", "meal plan", "sign-in account"]);
  const [s] = stuckSystemBuyers([base], NOW);
  assertEquals(stuckLine(s), "Sam Rivera — intake submitted 13 days ago; missing program, meal plan, sign-in account");
});

Deno.test("a healthy buyer is not stuck", () => {
  assertEquals(stuckReasons({ ...base, program_published: true, meal_plan_assigned: true, has_account: true }, NOW), []);
});

Deno.test("each missing piece alone is enough", () => {
  const ok = { ...base, program_published: true, meal_plan_assigned: true, has_account: true };
  assertEquals(stuckReasons({ ...ok, program_published: false }, NOW), ["program"]);
  assertEquals(stuckReasons({ ...ok, meal_plan_assigned: false }, NOW), ["meal plan"]);
  assertEquals(stuckReasons({ ...ok, has_account: false }, NOW), ["sign-in account"]);
});

Deno.test("under 24h since intake: not yet stuck; at 24h: stuck", () => {
  assertEquals(stuckReasons({ ...base, intake_submitted_at: hoursAgo(STUCK_AFTER_HOURS - 1) }, NOW), []);
  assertEquals(stuckReasons({ ...base, intake_submitted_at: hoursAgo(STUCK_AFTER_HOURS) }, NOW).length, 3);
});

Deno.test("intake not submitted, missing date, or bad date → not this alert", () => {
  assertEquals(stuckReasons({ ...base, intake_status: "pending" }, NOW), []);
  assertEquals(stuckReasons({ ...base, intake_status: "none", intake_submitted_at: null }, NOW), []);
  assertEquals(stuckReasons({ ...base, intake_submitted_at: "not a date" }, NOW), []);
});

Deno.test("moved to coaching → no longer a SYSTEM problem", () => {
  assertEquals(stuckReasons({ ...base, converted_client_id: "11111111-1111-1111-1111-111111111111" }, NOW), []);
});

Deno.test("list is oldest-stuck first and falls back to masked email for the name", () => {
  const rows = [
    { ...base, client_id: "a", display_name: null, intake_submitted_at: hoursAgo(30) },
    { ...base, client_id: "b" },
  ];
  const out = stuckSystemBuyers(rows, NOW);
  assertEquals(out.map((s) => s.client_id), ["b", "a"]);
  assertEquals(out[1].name, "s…m@example.com");
  assertEquals(stuckLine(out[1]), "s…m@example.com — intake submitted 1 day ago; missing program, meal plan, sign-in account");
});

Deno.test("parity: console (src/lib/systemStuck.js) and digest agree on every case", () => {
  assertEquals(spa.STUCK_AFTER_HOURS, STUCK_AFTER_HOURS, "threshold");
  const ok = { ...base, program_published: true, meal_plan_assigned: true, has_account: true };
  const cases: SystemBuyerRow[] = [
    base, ok,
    { ...ok, program_published: false }, { ...ok, meal_plan_assigned: false }, { ...ok, has_account: false },
    { ...base, intake_submitted_at: hoursAgo(23) }, { ...base, intake_submitted_at: hoursAgo(24) },
    { ...base, intake_status: "pending" }, { ...base, intake_submitted_at: null },
    { ...base, converted_client_id: "x" },
  ];
  for (const c of cases) assertEquals(spa.stuckReasons(c, NOW), stuckReasons(c, NOW), JSON.stringify(c));
});
