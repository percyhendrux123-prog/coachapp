// Run: deno test --allow-read supabase/functions/system-clearance/flow.test.ts
import { checkCaller, parseInput, runClearance, type Deps } from "./flow.ts";

const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
const env = { serviceKey: "service-key-fixture", anonKey: "anon-key-fixture" };

Deno.test("refuses without a user JWT", () => {
  eq(checkCaller(null, env).ok, false, "no header");
  eq(checkCaller("Bearer ", env).ok, false, "empty");
  eq(checkCaller("Basic abc", env).ok, false, "not bearer");
});
Deno.test("refuses a connector token, the service key and the anon key", () => {
  eq(checkCaller("Bearer cat_live_0123456789abcdef", env).ok, false, "connector token (not a JWT)");
  eq(checkCaller("Bearer service-key-fixture", env).ok, false, "service key");
  eq(checkCaller("Bearer anon-key-fixture", env).ok, false, "anon key");
  eq(checkCaller(`Bearer ${jwt({ role: "service_role" })}`, env).ok, false, "service-role JWT");
  eq(checkCaller(`Bearer ${jwt({ role: "anon" })}`, env).ok, false, "anon JWT");
  eq(checkCaller(`Bearer ${jwt({ role: "authenticated" })}`, env).ok, false, "no sub");
});
Deno.test("accepts a signed-in person's JWT shape (signature is checked by the gateway and auth.getUser)", () => {
  const r = checkCaller(`Bearer ${jwt({ role: "authenticated", sub: "u-1" })}`, env);
  eq(r.ok && r.sub, "u-1", "sub");
});
Deno.test("input is validated", () => {
  eq(parseInput({}).ok, false, "empty");
  eq(parseInput({ intake_id: "x", seen_flags: [], statement_version: "v", typed_name: "A B" }).ok, false, "bad uuid");
  eq(parseInput({ intake_id: "00000000-0000-4000-8000-000000000001", seen_flags: [1], statement_version: "v", typed_name: "A B" }).ok, false, "non-string flag");
  eq(parseInput({ intake_id: "00000000-0000-4000-8000-000000000001", seen_flags: ["parq_chest_pain"], statement_version: "v", typed_name: "A B" }).ok, true, "ok");
});

const NO = { parq_heart_condition: false, parq_chest_pain: true, parq_dizziness: false, parq_bone_joint: false,
  parq_bp_meds: false, parq_other_reason: false, pregnant: false, eating_disorder_history: false };
const answers = { goal: "maintain", sex: "male", age: 50, height_cm: 180, weight_kg: 90, experience: "advanced",
  days_per_week: 6, equipment: "full_gym", injuries: ["none"], ...NO };
const input = { intake_id: "00000000-0000-4000-8000-000000000001", seen_flags: ["parq_chest_pain"], statement_version: "2026-11-14.1", typed_name: "Test Person" };

function fakeDeps(over: Partial<Deps> = {}) {
  const calls: string[] = [];
  let published: { draft_id: string; program_id: string } | null = null;
  let claimed = false;
  const deps: Deps = {
    attest: async () => { calls.push("attest"); return { ok: true, row: { attestation_id: "a-1", intake_id: input.intake_id, client_id: "c-1", flags: ["parq_chest_pain"] } }; },
    loadIntake: async () => { calls.push("load"); return { id: input.intake_id, tenant_id: "t-1", client_id: "c-1", answers }; },
    findPublished: async () => { calls.push("find"); return published; },
    claim: async () => { calls.push("claim"); if (claimed) return "taken"; claimed = true; return "claimed"; },
    release: async () => { calls.push("release"); claimed = false; },
    build: async (_i, plan) => {
      calls.push("build");
      if ((plan as any).frequency.training_days > 4) throw new Error("not conservative");
      published = { draft_id: "d-1", program_id: "p-1" };
      return { ok: true, built: { draft_id: "d-1", program_id: "p-1", meal_plan_id: "m-1", meal_plan_error: null } };
    },
    finish: async () => { calls.push("finish"); },
    ...over,
  };
  return { deps, calls };
}

Deno.test("the database refusal stops everything: no build", async () => {
  const { deps, calls } = fakeDeps({ attest: async () => ({ ok: false, status: 400, error: "refused: blocking" }) });
  const r = await runClearance(deps, input);
  eq(r.status, 400, "status"); eq(calls.includes("build"), false, "no build");
});
Deno.test("first call builds a conservative plan; a second call builds nothing new", async () => {
  const { deps, calls } = fakeDeps();
  const first = await runClearance(deps, input);
  eq([first.status, first.body.status, first.body.program_id], [200, "built", "p-1"], "first");
  const second = await runClearance(deps, input);
  eq([second.status, second.body.already_built, second.body.program_id], [200, true, "p-1"], "second");
  eq(calls.filter((c) => c === "build").length, 1, "built once");
});
Deno.test("two taps at once: the second sees the claim and does not build", async () => {
  const { deps, calls } = fakeDeps({ claim: async () => "taken" });
  const r = await runClearance(deps, input);
  eq(r.status, 409, "in progress"); eq(calls.includes("build"), false, "no build");
});
Deno.test("a failed build releases the claim so a retry can run", async () => {
  const { deps, calls } = fakeDeps({ build: async () => ({ ok: false, error: "publish failed" }) });
  const r = await runClearance(deps, input);
  eq(r.status, 500, "status"); eq(calls.includes("release"), true, "released"); eq(calls.includes("finish"), false, "not finished");
});
Deno.test("a mismatch between the screen and the confirmed flags builds nothing", async () => {
  const { deps, calls } = fakeDeps({ attest: async () => ({ ok: true, row: { attestation_id: "a", intake_id: input.intake_id, client_id: "c-1", flags: ["parq_dizziness"] } }) });
  const r = await runClearance(deps, input);
  eq(r.status, 422, "refused"); eq(calls.includes("build"), false, "no build"); eq(calls.includes("release"), true, "released");
});
