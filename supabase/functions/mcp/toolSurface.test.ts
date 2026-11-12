// Deno-only. Run: deno test --allow-read supabase/functions/mcp/toolSurface.test.ts
//
// Structural checks over the tool table in index.ts. These exist because the two ways this
// surface can quietly lose its guarantees are both invisible in review:
//
//   1. A tool that mutates but forgets `write: true` is callable by a READ-ONLY token. The
//      permission gate (canUseTool) keys off that one flag and nothing else.
//   2. A coach tool pasted into CLIENT_TOOLS hands a client's own AI the coach's surface.
//
// Source-text matching rather than importing the module, matching the existing convention in
// toolAnnotations.test.js and safety.test.ts — index.ts calls Deno.serve at import time.
import { AUDIT_RULES_TOOLS } from "./safety.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const source = await Deno.readTextFile("supabase/functions/mcp/index.ts");

function block(startMarker: string): string {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `could not find ${startMarker} — the tool table has been restructured`);
  const end = source.indexOf("\n];", start);
  assert(end > start, `could not find the end of ${startMarker}`);
  return source.slice(start, end);
}

type ToolEntry = { name: string; body: string; declaresWrite: boolean };

function tools(text: string): ToolEntry[] {
  const out: ToolEntry[] = [];
  const re = /\n  \{\n    name: "([a-z_]+)",/g;
  const starts: Array<{ name: string; at: number }> = [];
  for (let m = re.exec(text); m; m = re.exec(text)) starts.push({ name: m[1], at: m.index });
  for (let i = 0; i < starts.length; i += 1) {
    const body = text.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : text.length);
    out.push({ name: starts[i].name, body, declaresWrite: /\n    write: true,/.test(body) });
  }
  return out;
}

const coachTools = tools(block("const COACH_TOOLS: Tool[] = ["));
const clientTools = tools(block("const CLIENT_TOOLS: Tool[] = ["));

// Any call that can change stored state. `.update(`/`.upsert(`/`.delete(` also appear on the
// storage client, so the list is deliberately broad — a false positive costs one `write: true`,
// a false negative costs a read-only token the ability to write.
const MUTATION_CALLS = [
  "insTenant(", ".insert(", ".update(", ".upsert(", ".delete(", ".rpc(",
];
// RPCs that are pure reads (a SECURITY DEFINER SELECT wrapper). `.rpc(` is otherwise treated
// as a mutation because most RPCs here write. Add to this list ONLY for a function whose
// body is a single SELECT — verify in supabase/migrations before adding.
const READ_ONLY_RPCS = ["list_system_buyers", "client_onboarding_facts"];
// Strips the RPC-name prefix, not just the zero-argument call — an allowlisted RPC called with
// arguments (e.g. `.rpc("client_onboarding_facts", { p_tenant_id })`) must be stripped too, or
// the leftover `.rpc(` substring still trips the mutation check below.
const mutatingBody = (body: string) =>
  READ_ONLY_RPCS.reduce((b, name) => b.split(`.rpc("${name}"`).join(""), body);

// Guard against the whole file passing vacuously: if the parser stops matching (a formatting
// change, a restructure), every test below would report "ok" while checking nothing at all.
Deno.test("the tool table actually parsed", () => {
  assert(coachTools.length >= 30, `expected 30+ coach tools, parsed ${coachTools.length}`);
  assert(clientTools.length >= 9, `expected 9+ client tools, parsed ${clientTools.length}`);
  assert(coachTools.some((t) => t.declaresWrite), "no coach write tool was detected — the write flag parser is broken");
  assert(coachTools.some((t) => !t.declaresWrite), "no coach read tool was detected — the write flag parser is broken");
  assert(coachTools.some((t) => t.name === "get_client_activity_log"), "the newest tool is missing from the parse");
});

Deno.test("every tool that can change stored state declares write: true", () => {
  for (const tool of [...coachTools, ...clientTools]) {
    const mutates = MUTATION_CALLS.some((call) => mutatingBody(tool.body).includes(call));
    if (mutates && !tool.declaresWrite) {
      throw new Error(
        `${tool.name} performs a mutating call but is not marked write: true — ` +
        "canUseTool() keys the entire permission gate off that flag, so a read-only token could call it",
      );
    }
  }
});

Deno.test("no tool is declared write: true without actually writing", () => {
  for (const tool of [...coachTools, ...clientTools]) {
    if (!tool.declaresWrite) continue;
    const mutates = MUTATION_CALLS.some((call) => tool.body.includes(call)) ||
      tool.body.includes("markThreadReadCore") || tool.body.includes("closeDayCore");
    assert(mutates, `${tool.name} is marked write: true but performs no mutating call — the flag is misleading`);
  }
});

Deno.test("the client token surface stays comms-and-logging only", () => {
  const allowed = new Set([
    "my_profile", "my_program", "my_workouts", "my_checkins", "my_messages",
    // Added 2026-08-30: my_schedule (calendar view) and my_progress (weight/lift
    // trends + consistency) are reads over the client's own already-readable data
    // (assignments/programs/checkins/progress_weights/workout_logs/
    // client_checkin_schedule) — no new capability, just a merged view of tools
    // this surface already had. Neither declares write:true.
    "my_schedule", "my_progress",
    "message_coach", "flag_issue", "log_workout_sets", "complete_current_day",
    // Full-control (owner) tokens for self-serve
    // buyers with no coach — enforced by the database trigger.
    // These five touch ONLY the token's own client_id-pinned rows and are additionally gated
    // by canUseTool()'s scope==="owner" check — a comms-scope client token cannot call them.
    "update_my_program", "set_my_macros", "set_my_meals", "add_my_meal", "regenerate_my_plan",
  ]);
  for (const tool of clientTools) {
    assert(
      allowed.has(tool.name),
      `${tool.name} appeared on the CLIENT token surface. A client's own AI must never gain a coach tool — ` +
      "add it to COACH_TOOLS, or widen this list deliberately with a written reason",
    );
  }
  const coachNames = new Set(coachTools.map((t) => t.name));
  for (const tool of clientTools) {
    assert(!coachNames.has(tool.name), `${tool.name} exists on both surfaces`);
  }
});

Deno.test("owner-scope tools are all write:true, scope:\"owner\", and never leak into COACH_TOOLS", () => {
  const OWNER_PREFIXES = ["update_my_", "set_my_", "add_my_", "regenerate_my_"];
  for (const tool of clientTools) {
    if (!OWNER_PREFIXES.some((p) => tool.name.startsWith(p))) continue;
    assert(tool.declaresWrite, `${tool.name} is an owner-scope tool but is not write: true`);
    assert(/\n    write: true, scope: "owner",/.test(tool.body), `${tool.name} must declare scope: "owner"`);
  }
  for (const tool of coachTools) {
    assert(!/scope: "owner"/.test(tool.body), `${tool.name} is a coach tool but declares scope: "owner" — owner scope is client-only`);
  }
});

Deno.test("every tool taking an id or a limit records it in the audit trail", () => {
  const known = new Set(AUDIT_RULES_TOOLS);
  for (const tool of [...coachTools, ...clientTools]) {
    const schema = tool.body.match(/inputSchema: obj\(([\s\S]*?)\n    \),?/)?.[0] ??
      tool.body.match(/inputSchema: obj\([^\n]*\),/)?.[0] ?? "";
    const takesIdOrLimit = /S\.id|S\.limit/.test(schema);
    if (takesIdOrLimit) {
      assert(
        known.has(tool.name),
        `${tool.name} accepts an id or a limit but has no AUDIT_RULES entry — its audit rows will be blank, ` +
        "which is exactly why the get_support_queue failure went a week undiagnosed",
      );
    }
  }
});

Deno.test("no tool reads a table with select('*')", () => {
  for (const tool of [...coachTools, ...clientTools]) {
    // sel(ctx, "assignments", "*") is the one deliberate exception: closeDayCore needs the whole
    // row for the cycle handoff, and it is the client's OWN assignment, client_id-pinned.
    const wildcards = [...tool.body.matchAll(/sel\(ctx, "([a-z_]+)", "\*"\)/g)].map((m) => m[1]);
    for (const table of wildcards) {
      assert(
        tool.name === "log_workout_sets" || tool.name === "complete_current_day" || table === "assignments",
        `${tool.name} selects * from ${table} — field allowlists exist so a new column cannot silently start serializing`,
      );
    }
  }
});

// The Netlify proxy keeps a hand-maintained allowlist of read-only tool names, used to decide
// whether a gateway 502 is safe to retry. It has drifted from index.ts before. A write tool
// leaking into it means a failed write could be replayed — a message sent twice, a set logged
// twice. A read tool missing from it only costs a retry, which is the safe direction.
Deno.test("the Netlify proxy's retry allowlist matches the real tool surface", async () => {
  const proxy = await Deno.readTextFile("netlify/functions/mcp-oauth.mjs");
  const listed = new Set(
    [...(proxy.match(/const READ_TOOLS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "")
      .matchAll(/"([a-z_]+)"/g)].map((m) => m[1]),
  );
  assert(listed.size > 20, `parsed only ${listed.size} names from the proxy allowlist — the parser is broken`);

  for (const tool of [...coachTools, ...clientTools]) {
    if (tool.declaresWrite) {
      assert(
        !listed.has(tool.name),
        `${tool.name} is a WRITE tool but appears in the proxy's retry allowlist — a gateway failure could ` +
        "replay it, sending a message or logging a set twice",
      );
    } else {
      assert(
        listed.has(tool.name),
        `${tool.name} is a read tool missing from the proxy's retry allowlist — harmless (it just never ` +
        "retries) but it means the two files have drifted, which is how a write ends up in there",
      );
    }
  }
});

Deno.test("progress photos are always signed, never returned as bare storage paths", () => {
  for (const tool of coachTools) {
    if (!/progress_photos|photo_urls/.test(tool.body)) continue;
    if (tool.name === "get_client_activity_log") continue; // returns ids and timestamps only, no paths
    assert(
      tool.body.includes("signPhotoPaths"),
      `${tool.name} returns photo data without signing it — a private-bucket storage path is a dead string ` +
      "to every caller, which is exactly what list_progress_photos shipped as",
    );
  }
});

Deno.test("exactly the coach-relay tools are marked needsCoach (hidden on self-serve tenants)", () => {
  // message_coach / flag_issue write into the coach inbox. On a self-serve tenant there is
  // no coach, so index.ts hides them from tools/list and refuses tools/call. The marker is
  // the only thing that gating keys off — a new relay tool without it would report `sent`
  // into a void again (found live 2026-09-03).
  const client = tools(block("const CLIENT_TOOLS"));
  const marked = client.filter((t) => /\n    needsCoach: true,/.test(t.body)).map((t) => t.name).sort();
  assert(JSON.stringify(marked) === JSON.stringify(["flag_issue", "message_coach"]),
    `needsCoach must mark exactly flag_issue + message_coach, got ${marked.join(", ") || "none"}`);
  const coach = tools(block("const COACH_TOOLS"));
  assert(coach.every((t) => !/needsCoach/.test(t.body)), "needsCoach is a client-surface marker only");
  assert(/\.filter\(\(t\) => !hiddenWithoutCoach\(ctx\.selfServe, t\.needsCoach\)\)/.test(source), "tools/list must apply hiddenWithoutCoach");
  assert(/if \(hiddenWithoutCoach\(ctx\.selfServe, tool\.needsCoach\)\)/.test(source), "tools/call must refuse via hiddenWithoutCoach");
});
