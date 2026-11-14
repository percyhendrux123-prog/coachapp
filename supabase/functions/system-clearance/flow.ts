// system-clearance, the testable half. index.ts wires the real database calls in.
//
// The order is the safety property:
//   1. the caller must be a signed-in person (a user JWT with role "authenticated"). The
//      service key, the anon key and connector tokens are refused before anything runs;
//   2. the DATABASE decides whether the confirmation is allowed: attest_my_health_screen() runs
//      with the caller's own JWT, so the function can never confirm for someone else;
//   3. only after the database accepted it is a plan built, with the conservative profile;
//   4. a plan already built for this screen is returned as it is (a second tap builds nothing).
import { generateConservativePlan } from "../intake-submit/generate.ts";

export const W7_TEXT = "Your week is built. It starts conservative. Sign in with the email you used and open Program.";

// ---------- 1. caller ----------
export type CallerCheck = { ok: true; jwt: string; sub: string } | { ok: false; status: number; error: string };

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    const pad = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    const v = JSON.parse(atob(pad));
    return v && typeof v === "object" ? v : null;
  } catch { return null; }
}

// Shape and role only. The signature is checked twice elsewhere: by the platform gateway
// (verify_jwt is on for this function) and by auth.getUser() in index.ts.
export function checkCaller(authorization: string | null, env: { serviceKey?: string; anonKey?: string }): CallerCheck {
  const raw = authorization ?? "";
  if (!raw.startsWith("Bearer ")) return { ok: false, status: 401, error: "sign in first" };
  const jwt = raw.slice(7).trim();
  if (!jwt) return { ok: false, status: 401, error: "sign in first" };
  if ((env.serviceKey && jwt === env.serviceKey) || (env.anonKey && jwt === env.anonKey)) {
    return { ok: false, status: 403, error: "only the signed-in person can confirm their own health screen" };
  }
  const parts = jwt.split(".");
  if (parts.length !== 3) return { ok: false, status: 403, error: "only the signed-in person can confirm their own health screen" };
  const claims = b64urlJson(parts[1]);
  if (!claims || claims.role !== "authenticated" || typeof claims.sub !== "string" || !claims.sub) {
    return { ok: false, status: 403, error: "only the signed-in person can confirm their own health screen" };
  }
  return { ok: true, jwt, sub: claims.sub };
}

// ---------- 2. input ----------
export type ClearanceInput = { intake_id: string; seen_flags: string[]; statement_version: string; typed_name: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseInput(body: unknown): { ok: true; input: ClearanceInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.intake_id !== "string" || !UUID.test(b.intake_id)) return { ok: false, error: "intake_id required" };
  if (!Array.isArray(b.seen_flags) || b.seen_flags.some((f) => typeof f !== "string")) return { ok: false, error: "seen_flags required" };
  if (typeof b.statement_version !== "string" || !b.statement_version) return { ok: false, error: "statement_version required" };
  if (typeof b.typed_name !== "string") return { ok: false, error: "typed_name required" };
  return { ok: true, input: { intake_id: b.intake_id, seen_flags: b.seen_flags as string[], statement_version: b.statement_version, typed_name: b.typed_name } };
}

// ---------- 3-4. the flow ----------
export type Attested = { attestation_id: string; intake_id: string; client_id: string; flags: string[] };
export type Intake = { id: string; tenant_id: string; client_id: string; answers: Record<string, unknown> };
export type Published = { draft_id: string; program_id: string };
export type Built = { draft_id: string; program_id: string; meal_plan_id: string | null; meal_plan_error: string | null };

export type Deps = {
  attest: (input: ClearanceInput) => Promise<{ ok: true; row: Attested } | { ok: false; status: number; error: string }>;
  loadIntake: (intakeId: string, clientId: string) => Promise<Intake | null>;
  findPublished: (intakeId: string) => Promise<Published | null>;
  claim: (attestationId: string, intakeId: string) => Promise<"claimed" | "taken">;
  release: (attestationId: string) => Promise<void>;
  build: (intake: Intake, plan: ReturnType<typeof generateConservativePlan>) => Promise<{ ok: true; built: Built } | { ok: false; error: string }>;
  finish: (attestationId: string, intakeId: string, draftId: string) => Promise<void>;
};

export type FlowResult = { status: number; body: Record<string, unknown> };

export async function runClearance(deps: Deps, input: ClearanceInput): Promise<FlowResult> {
  const att = await deps.attest(input);
  if (!att.ok) return { status: att.status, body: { error: att.error } };
  const row = att.row;

  const already = await deps.findPublished(row.intake_id);
  if (already) return { status: 200, body: { status: "built", already_built: true, ...already, message: W7_TEXT } };

  const intake = await deps.loadIntake(row.intake_id, row.client_id);
  if (!intake) return { status: 404, body: { error: "health screen not found" } };

  if ((await deps.claim(row.attestation_id, row.intake_id)) === "taken") {
    const now = await deps.findPublished(row.intake_id);
    if (now) return { status: 200, body: { status: "built", already_built: true, ...now, message: W7_TEXT } };
    return { status: 409, body: { error: "Your plan is already being built. Wait a moment, then reload." } };
  }

  let plan: ReturnType<typeof generateConservativePlan>;
  try { plan = generateConservativePlan(intake.answers as never, row.flags); }
  catch (e) { await deps.release(row.attestation_id); return { status: 422, body: { error: (e as Error).message } }; }

  const res = await deps.build(intake, plan);
  if (!res.ok) { await deps.release(row.attestation_id); return { status: 500, body: { error: "build: " + res.error } }; }
  await deps.finish(row.attestation_id, row.intake_id, res.built.draft_id);
  return { status: 200, body: { status: "built", conservative: true, ...res.built, message: W7_TEXT } };
}
