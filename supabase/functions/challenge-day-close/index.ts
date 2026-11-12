// challenge-day-close — close out the run's current day and advance. Idempotent.
// On the final day, computes perfect_week (every day all_standards_met).
//
// A perfect week creates NO Stripe customer and NO Stripe subscription. Conversion
// to a paying client happens later, through the coach's own commitment-call / checkout
// flow — never automatically from challenge completion.
//
// Writes via service role. (verify_jwt=false; auth self-handled.)
//
// POST { run_id }  (Bearer JWT required, participant must own the run)
// GET → health check.
import { admin, callerUserId, loadOwnedRun, json, CORS } from "../_shared/challenge.ts";
import { OWNER_TENANT_SLUG } from "../_shared/owner.ts";

// Convert the participant (a prospect auth user) into a client record, or update the
// existing one, so the coach sees them on the roster and can make the commitment call.
// No billing fields are touched here — nothing is charged and nothing claims to be.
async function linkClient(db: any, challenge: any, run: any, email?: string): Promise<string> {
  const tenantId = challenge.tenant_id;
  const fields = {
    tenant_id: tenantId, client_user_id: run.participant_user_id, email: email ?? null,
  };
  // Find an existing client by auth user → email (in that order).
  let client = (await db.from("clients").select("id").eq("tenant_id", tenantId).eq("client_user_id", run.participant_user_id).maybeSingle()).data;
  if (!client && email) client = (await db.from("clients").select("id").eq("tenant_id", tenantId).eq("email", email).maybeSingle()).data;

  if (client) {
    await db.from("clients").update(fields).eq("id", client.id);
    return client.id;
  }
  const ins = await db.from("clients").insert({
    ...fields, status: "invited", display_name: email ? String(email).split("@")[0] : "Challenge Winner",
  }).select("id").single();
  if (ins.error) throw new Error("client link: " + ins.error.message);
  return ins.data.id;
}

// Notify (best-effort) that a perfect week was earned — the coach's cue to make the
// commitment call. client_id is NOT NULL on notification_log and does not exist until
// settleReward's linkClient resolves one — this must only ever be called after that,
// with the real id, never before.
async function notifyRewardEarned(db: any, challenge: any, runId: string, clientId: string) {
  const { error } = await db.from("notification_log").insert({
    tenant_id: challenge.tenant_id, client_id: clientId, channel: "push",
    template: "challenge_reward_earned", status: "recorded",
    consent_snapshot: { run_id: runId, reward: challenge.reward_type },
  });
  if (error) console.error("notifyRewardEarned: notification_log insert failed:", error.message);
}

// The perfect-week roster conversion is reserved for the owner tenant;
// other coaches retain their own challenge configuration. Gated on the tenant slug
// (not a hardcoded id). Throws on a
// real lookup error so the caller's catch treats it as retryable (never provisions).
async function isOwnerTenant(db: any, tenantId: string): Promise<boolean> {
  const { data, error } = await db.from("tenants").select("slug").eq("id", tenantId).maybeSingle();
  if (error) throw new Error("tenant lookup: " + error.message);
  return data?.slug === OWNER_TENANT_SLUG;
}

// Convert the participant to a roster client + notify. No Stripe involved. Returns response
// additions.
async function settleReward(db: any, challenge: any, run: any) {
  try {
    // Non-owner tenant: record the perfect week but skip the roster-conversion step.
    // Terminal 'completed' (not 'perfect_week') so it isn't picked up by the retry path.
    if (!(await isOwnerTenant(db, challenge.tenant_id))) {
      await db.from("challenge_runs").update({ status: "completed" }).eq("id", run.id);
      return { status: "completed", reward: null, reward_skipped: "non_owner_tenant" };
    }
    const { data: u } = await admin().auth.admin.getUserById(run.participant_user_id);
    const email = u?.user?.email ?? undefined;
    const clientId = await linkClient(db, challenge, run, email);
    await db.from("challenge_runs").update({ status: "rewarded", client_id: clientId }).eq("id", run.id);
    // Only now does a client_id exist to attach the notification to — covers both the
    // immediate path and the retry path (run.status === "perfect_week") in one place.
    await notifyRewardEarned(db, challenge, run.id, clientId);
    return { status: "rewarded", client_id: clientId };
  } catch (e) {
    // Week is still perfect (recorded); reward can be retried by calling again.
    return { status: "perfect_week", reward_error: (e as Error).message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "challenge-day-close" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const { run_id } = body || {};
  if (!run_id) return json({ error: "run_id required" }, 400);

  const owned = await loadOwnedRun(run_id, userId);
  if ("error" in owned) return owned.error;
  const { run, challenge } = owned;
  const db = admin();

  // --- 20-hour time gate ---
  // Day advances require 20 hours elapsed since the last log, not calendar days.
  // This allows slightly early morning logs without two advances in one afternoon.
  // Server-side only — a frontend guard is not protection against direct API calls.
  const { data: lastLog } = await db.from("challenge_day_logs")
    .select("logged_at").eq("run_id", run_id)
    .order("logged_at", { ascending: false }).limit(1).maybeSingle();
  if (lastLog?.logged_at) {
    const elapsed = Date.now() - new Date(lastLog.logged_at).getTime();
    const HOUR_20 = 20 * 60 * 60 * 1000;
    if (elapsed < HOUR_20) {
      const waitMinutes = Math.ceil((HOUR_20 - elapsed) / 60000);
      return json({
        error: "too soon",
        detail: `20 hours must pass between day advances. ${waitMinutes} minute(s) remaining.`,
        last_log_at: lastLog.logged_at,
        next_allowed_at: new Date(new Date(lastLog.logged_at).getTime() + HOUR_20).toISOString(),
      }, 429);
    }
  }

  // Terminal states.
  if (run.status === "completed" || run.status === "rewarded" || run.status === "incomplete")
    return json({ run_id, status: run.status, already_closed: true });

  // Retry path: perfect week recorded but reward not yet settled (prior failure).
  if (run.status === "perfect_week") {
    const settled = await settleReward(db, challenge, run);
    return json({ run_id, retried: true, ...settled });
  }

  const day = run.current_day_index;
  const isFinalDay = day >= challenge.duration_days;

  // An unlogged day is NOT evidence of failure — it's unmeasured.
  // Do not fabricate a false "day not met" log. A day with no real log stays unlogged.
  // The final tally below handles missing days honestly.

  if (!isFinalDay) {
    await db.from("challenge_runs").update({ current_day_index: day + 1, status: "active" }).eq("id", run_id);
    return json({ run_id, closed_day: day, next_day: day + 1, completed: false });
  }

  // Final day → tally from actual logs only. No fabricated rows.
  const { data: logs } = await db.from("challenge_day_logs").select("day_index, all_standards_met").eq("run_id", run_id);
  const loggedDays = new Set((logs || []).map((l: any) => l.day_index));
  const metDays = new Set((logs || []).filter((l: any) => l.all_standards_met).map((l: any) => l.day_index));
  const unloggedDays = challenge.duration_days - loggedDays.size;
  const perfect = metDays.size >= challenge.duration_days;
  const incomplete = unloggedDays > 0;

  const finalStatus = perfect ? "perfect_week" : incomplete ? "incomplete" : "completed";

  await db.from("challenge_runs").update({
    current_day_index: day + 1, completed_at: new Date().toISOString(),
    status: finalStatus, perfect_week: perfect,
    ...(perfect ? { reward_granted_at: new Date().toISOString() } : {}),
  }).eq("id", run_id);

  const base = { run_id, closed_day: day, completed: true, perfect_week: perfect,
    status: finalStatus, days_met: metDays.size, days_logged: loggedDays.size,
    days_required: challenge.duration_days, ...(incomplete ? { days_unlogged: unloggedDays } : {}) };

  if (!perfect) return json({ ...base, reward: null });

  const settled = await settleReward(db, challenge, { ...run, id: run_id });
  return json({ ...base, reward: challenge.reward_type, ...settled });
});
