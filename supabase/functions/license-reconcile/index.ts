// license-reconcile — daily job: sync each tenant's hosting subscription status from
// Stripe and gate access. Restores 'active' immediately when a tenant is paying again.
// Suspension is enforced at the data layer (trg_tenant_suspension_guard) as well as in the
// app shell.
//
// Called by pg_cron (server-side), gated by a shared CRON_SECRET — no public trigger surface.
//
// Observability contract. The previous version reported success while
// verifying nothing:
//   * it selected only tenants with a non-null subscription_id, and no tenant has one,
//     so the loop never ran;
//   * it returned {checked: 0, changed: []} with HTTP 200 — indistinguishable from
//     "everything is healthy";
//   * it destructured `{ data }` without `error`, so a failed query produced exactly
//     the same output as a clean run;
//   * a Stripe lookup failure was pushed into `changed`, so errors read as results;
//   * pg_cron discards the response, so none of it was observable anywhere.
// This version reads the errors instead of swallowing them, treats an empty work set
// as SUSPICIOUS rather than clean, and writes a row to public.ops_job_runs on every
// run so a silent failure shows up as a stale or missing record.
//
// Always report which licensed tenants are
// unverifiable (no subscription_id), and a paying tenant that cannot be verified marks
// the run unhealthy. Deliberately comped tenants (tenants.comp_reason) are named but
// excluded from the unhealthy count.
//
// A terminal subscription state starts a 10-day grace window with 3 notices
// (day 0 / day 3 / day 7) to the coach and, when configured, the ops inbox.
// Suspend on day 10 if unresolved. tenant_payment_grace is the clock. If a notice
// fails to send, the stage does NOT advance and the tenant is NOT suspended that
// run — the "always notified first" invariant holds even if email is broken, at the
// cost of the grace clock pausing rather than silently suspending unnotified.
import Stripe from "npm:stripe@17";
import { admin, json, STRIPE_KEY } from "../_shared/challenge.ts";
import {
  accessFor, GRACE_DAYS, graceNotice, resolveGraceStage, resolvedNotice,
  TRIAL_DAYS, trialWarningNotice, trialEndedNotice,
} from "./grace.ts";

const stripe = new Stripe(STRIPE_KEY || "sk_test_placeholder", { apiVersion: "2024-06-20" });
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const JOB = "license-reconcile";

const RESEND_API = "https://api.resend.com/emails";
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
// Same env vars send-digest already uses — Supabase edge function secrets are
// project-wide, so no new secret is needed for this job to send mail too.
const TEAM_RECIPIENT = Deno.env.get("DIGEST_RECIPIENT") || "";
const NOTICE_FROM = Deno.env.get("DIGEST_SENDER") || Deno.env.get("EMAIL_FROM") || "Coach App <no-reply@example.com>";

async function sendEmail(to: string[], opts: { subject: string; html: string }) {
  if (!TEAM_RECIPIENT) console.log("DIGEST_RECIPIENT not set");
  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: NOTICE_FROM, to, subject: opts.subject, html: opts.html }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API ${res.status}: ${text.slice(0, 200)}`);
  }
}

// Record what this run actually did. If the record itself fails, that is reported in
// the response rather than vanishing.
async function record(
  db: ReturnType<typeof admin>,
  startedAt: string,
  outcome: "verified" | "nothing_to_verify" | "error",
  healthy: boolean,
  detail: Record<string, unknown>,
): Promise<string | null> {
  const { error } = await db.from("ops_job_runs").insert({
    job: JOB, started_at: startedAt, finished_at: new Date().toISOString(),
    outcome, healthy, detail,
  });
  return error ? error.message : null;
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true, service: JOB });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!CRON_SECRET || (req.headers.get("authorization") || "") !== `Bearer ${CRON_SECRET}`)
    return json({ error: "forbidden" }, 403);

  const startedAt = new Date().toISOString();
  const db = admin();

  if (!STRIPE_KEY) {
    const logErr = await record(db, startedAt, "error", false, { reason: "no stripe key configured" });
    return json({ outcome: "error", healthy: false, error: "no stripe key", log_error: logErr }, 500);
  }

  // Count every tenant, not just the reconcilable ones — the gap between the two is
  // the point. "checked 0 of 0" and "checked 0 of 2 because neither is wired to
  // Stripe" are very different facts, and the old response could not tell them apart.
  const totals = await db.from("tenants").select("id", { count: "exact", head: true });
  if (totals.error) {
    const logErr = await record(db, startedAt, "error", false, { stage: "count tenants", message: totals.error.message });
    return json({ outcome: "error", healthy: false, error: totals.error.message, log_error: logErr }, 500);
  }
  const tenantsTotal = totals.count ?? 0;

  // The error is now read, not discarded.
  const { data: tenants, error: selErr } = await db
    .from("tenants")
    .select("id, slug, coach_user_id, subscription_id, status, subscription_status, license_stripe_ref")
    .not("subscription_id", "is", null);

  if (selErr) {
    const logErr = await record(db, startedAt, "error", false, { stage: "select tenants", message: selErr.message });
    return json({ outcome: "error", healthy: false, error: selErr.message, log_error: logErr }, 500);
  }

  const work = tenants ?? [];

  // Every tenant this job CANNOT verify — no subscription_id at all — reported on every
  // run, not just when it's everyone. A tenant with license_stripe_ref set actually paid
  // for a license; one with neither looks like an internal/owner tenant that never went
  // through the paid flow. Both are named; only the licensed-but-unwired ones count
  // against `healthy`, because an owner tenant with no license was never supposed to be
  // billed in the first place.
  const { data: unwired } = await db
    .from("tenants")
    .select("id, slug, coach_user_id, license_stripe_ref, status, comp_reason")
    .is("subscription_id", null);
  const unwiredLicensedAll = (unwired ?? []).filter((t: any) => t.license_stripe_ref);
  const unwiredUnlicensed = (unwired ?? []).filter((t: any) => !t.license_stripe_ref);
  // Deliberately comped (the owner set tenants.comp_reason) — visible, not an alarm.
  const compedTenants = unwiredLicensedAll.filter((t: any) => t.comp_reason);
  // Licensed, unwired, and NOT explained — the actual gap this job exists to catch.
  const unwiredLicensed = unwiredLicensedAll.filter((t: any) => !t.comp_reason);

  // Trial tenants — created by admin-provision-coach, never had a subscription or
  // a comp_reason. Tracked separately from unwiredLicensed: a trial isn't a billing
  // gap, it's an intentional, time-boxed state with its own deadline already on
  // the row (trial_ends_at), so there's nothing to detect here, only to act on.
  const { data: trialTenants } = await db
    .from("tenants")
    .select("id, slug, coach_user_id, status, trial_ends_at, trial_warning_sent_at")
    .not("trial_ends_at", "is", null)
    .is("subscription_id", null)
    .is("comp_reason", null);
  const trials = trialTenants ?? [];

  // Nothing to reconcile is SUSPICIOUS, not clean. Either no tenant is wired to
  // Stripe (so hosting billing is not being enforced for anyone), or the query is
  // not matching what it should be matching. `unwiredLicensed` and `trials` are
  // handled below regardless — this early return only fires when there is truly
  // nothing for this run to do at all.
  if (work.length === 0 && unwiredLicensed.length === 0 && trials.length === 0) {
    const detail = {
      tenants_total: tenantsTotal,
      tenants_with_subscription_id: 0,
      unverifiable_licensed_tenants: [] as string[],
      unverifiable_unlicensed_tenants: unwiredUnlicensed.map((t: any) => t.slug),
      comped_tenants: compedTenants.map((t: any) => t.slug),
      trial_tenants: [] as string[],
      note: "No tenant carries a subscription_id, so no hosting subscription was verified "
          + "against Stripe. Billing is not being enforced for anyone. This is a "
          + "configuration gap, not a clean run.",
    };
    const logErr = await record(db, startedAt, "nothing_to_verify", false, detail);
    return json({
      outcome: "nothing_to_verify", healthy: false,
      checked: 0, tenants_total: tenantsTotal, changed: [], ...detail, log_error: logErr,
    });
  }

  // Existing grace-window rows for everything this run will touch — both the normal
  // subscription_id tenants and the licensed-but-unwired ones — fetched once.
  const graceTargetIds = [...work, ...unwiredLicensed].map((t: any) => t.id);
  const { data: graceRows } = await db
    .from("tenant_payment_grace")
    .select("*")
    .in("tenant_id", graceTargetIds);
  const graceByTenant = new Map((graceRows ?? []).map((g: any) => [g.tenant_id, g]));

  const changed: unknown[] = [];
  const failures: unknown[] = [];
  const noticesSent: unknown[] = [];
  const noticeFailures: unknown[] = [];
  let checked = 0;

  // Advance (or start) this tenant's grace clock and send whatever notice is due.
  // Shared by both the Stripe-bad-status path below and the licensed-but-unwired
  // path (where there's no Stripe status to look up at all — the tenant just never
  // got a subscription attached). `stripeStatus` is the value logged into `changed`
  // on suspension; null for the unwired path since there is none.
  async function advanceGraceClock(
    t: { id: string; slug: string; coach_user_id: string | null; status: string },
    grace: any,
    reason: "payment_failed" | "never_wired",
    stripeStatus: string | null,
  ): Promise<void> {
    let graceRow = grace;
    if (!graceRow) {
      const ins = await db.from("tenant_payment_grace")
        .insert({ tenant_id: t.id, bad_status_since: new Date().toISOString(), stage: 0 })
        .select().single();
      if (ins.error) { failures.push({ slug: t.slug, stage: "grace_insert", error: ins.error.message }); return; }
      graceRow = ins.data;
    }

    const daysSinceBad = (Date.now() - new Date(graceRow.bad_status_since).getTime()) / 86400000;
    const target = resolveGraceStage(daysSinceBad, graceRow.stage);

    if (target > graceRow.stage) {
      const suspendDate = new Date(
        new Date(graceRow.bad_status_since).getTime() + GRACE_DAYS.suspend * 86400000,
      ).toDateString();
      const notice = graceNotice(target, { slug: t.slug, suspendDate, reason });
      try {
        const coachEmail = await getCoachEmail(db, t.coach_user_id);
        await sendEmail([coachEmail, TEAM_RECIPIENT].filter(Boolean) as string[], notice);
        if (target === 4) {
          const { error: upErr } = await db.from("tenants").update({ status: "suspended" }).eq("id", t.id);
          if (upErr) throw upErr;
          changed.push({ slug: t.slug, from: t.status, to: "suspended", stripe_status: stripeStatus, reason });
        }
        await db.from("tenant_payment_grace")
          .update({ stage: target, last_notice_at: new Date().toISOString() })
          .eq("tenant_id", t.id);
        noticesSent.push({ slug: t.slug, stage: target, days_since_bad: Math.floor(daysSinceBad), reason });
      } catch (e) {
        noticeFailures.push({ slug: t.slug, stage: target, error: (e as Error).message, reason });
      }
    }
  }

  for (const t of work as any[]) {
    try {
      const sub = await stripe.subscriptions.retrieve(t.subscription_id);
      checked += 1;
      const a = accessFor(sub.status);
      const grace = graceByTenant.get(t.id);

      if (a.tenant_status === "active") {
        // Good status now. If a grace row exists, this is a resolution — clear it,
        // notify (if a notice had actually gone out), and restore access if it had
        // been suspended.
        if (grace) {
          if (grace.stage >= 1) {
            try {
              const coachEmail = await getCoachEmail(db, t.coach_user_id);
              await sendEmail([coachEmail, TEAM_RECIPIENT].filter(Boolean) as string[], resolvedNotice({ slug: t.slug }));
              noticesSent.push({ slug: t.slug, stage: "resolved" });
            } catch (e) {
              noticeFailures.push({ slug: t.slug, stage: "resolved", error: (e as Error).message });
            }
          }
          await db.from("tenant_payment_grace").delete().eq("tenant_id", t.id);
        }
        if (a.subscription_status !== t.subscription_status || a.tenant_status !== t.status) {
          const { error: upErr } = await db.from("tenants")
            .update({ subscription_status: a.subscription_status, status: a.tenant_status })
            .eq("id", t.id);
          if (upErr) failures.push({ slug: t.slug, stage: "update", error: upErr.message });
          else changed.push({ slug: t.slug, from: t.status, to: a.tenant_status, stripe_status: sub.status });
        }
        continue;
      }

      // a.tenant_status === "suspended": Stripe reports a terminal state. This no
      // longer suspends immediately — it starts or continues the grace clock.
      //
      // Keep the mirror field current regardless of stage — informational only,
      // does not gate access.
      if (a.subscription_status !== t.subscription_status) {
        await db.from("tenants").update({ subscription_status: a.subscription_status }).eq("id", t.id);
      }
      // Only advance the stage / suspend once the notice is confirmed sent — the
      // "always notified first" invariant holds even if email is down, at the cost
      // of the grace clock pausing rather than suspending unnotified. Enforced
      // inside advanceGraceClock, shared with the licensed-but-unwired path below.
      await advanceGraceClock(t, grace, "payment_failed", sub.status);
    } catch (e) {
      // A failed Stripe lookup means this tenant was NOT verified. It is a failure,
      // not a result — the old code pushed it into `changed`, where it read like one.
      failures.push({ slug: t.slug, stage: "stripe", error: (e as Error).message });
    }
  }

  // Licensed, unwired, not comped: this tenant paid the one-time license fee but has
  // no subscription attached at all — no Stripe lookup is possible or needed. Closes
  // the blind spot where this bucket used to only ever get reported (below, still)
  // and never actually acted on. Same grace clock, same "always notified first"
  // guarantee, just anchored at first-detection (now) rather than backdated to
  // whenever the tenant was created — backdating would let a long-unnoticed tenant
  // jump straight to a stage-4 suspension on the very first run, with no notice ever
  // sent first, which is exactly the invariant this whole mechanism exists to hold.
  for (const t of unwiredLicensed as any[]) {
    const grace = graceByTenant.get(t.id);
    await advanceGraceClock(t, grace, "never_wired", null);
  }
  // Known gap, not solved here: a tenant that entered this grace clock and is THEN
  // comped (comp_reason set) falls out of `unwiredLicensed` on the next run and
  // stops being processed, but its existing tenant_payment_grace row is not
  // cleared automatically. Harmless today (nobody has ever been in this bucket),
  // but worth a manual grace-row check if the owner comps a tenant that's mid-grace.

  // Trial tenants: one warning inside TRIAL_DAYS.warnWithinDays of the deadline,
  // one cutoff once it's passed. Deliberately not the 4-stage grace machinery
  // above — a trial counts down to a known date, it doesn't count up from an
  // unknown "first noticed bad" point. "Always notified first" still holds: the
  // status flip to suspended only happens inside the same try block, after the
  // ended-notice email is confirmed sent.
  for (const t of trials as any[]) {
    const daysLeft = (new Date(t.trial_ends_at).getTime() - Date.now()) / 86400000;

    if (daysLeft <= 0) {
      if (t.status !== "active") continue; // already suspended by a prior run
      try {
        const coachEmail = await getCoachEmail(db, t.coach_user_id);
        await sendEmail([coachEmail, TEAM_RECIPIENT].filter(Boolean) as string[], trialEndedNotice({ slug: t.slug }));
        const { error: upErr } = await db.from("tenants").update({ status: "suspended" }).eq("id", t.id);
        if (upErr) throw upErr;
        changed.push({ slug: t.slug, from: t.status, to: "suspended", stripe_status: null, reason: "trial_ended" });
        noticesSent.push({ slug: t.slug, stage: "trial_ended" });
      } catch (e) {
        noticeFailures.push({ slug: t.slug, stage: "trial_ended", error: (e as Error).message });
      }
      continue;
    }

    if (daysLeft <= TRIAL_DAYS.warnWithinDays && !t.trial_warning_sent_at) {
      try {
        const coachEmail = await getCoachEmail(db, t.coach_user_id);
        const trialEndDate = new Date(t.trial_ends_at).toDateString();
        await sendEmail([coachEmail, TEAM_RECIPIENT].filter(Boolean) as string[], trialWarningNotice({ slug: t.slug, trialEndDate }));
        await db.from("tenants").update({ trial_warning_sent_at: new Date().toISOString() }).eq("id", t.id);
        noticesSent.push({ slug: t.slug, stage: "trial_warning" });
      } catch (e) {
        noticeFailures.push({ slug: t.slug, stage: "trial_warning", error: (e as Error).message });
      }
    }
  }

  // A licensed (paid) tenant this job cannot verify is a real gap, not a footnote —
  // include it in what decides `healthy`, same as a Stripe lookup failure would. A
  // failed notice send also marks the run unhealthy — it is the thing standing
  // between a tenant and an un-notified suspension.
  const healthy = failures.length === 0 && noticeFailures.length === 0
    && checked === work.length && unwiredLicensed.length === 0;
  const detail = {
    tenants_total: tenantsTotal,
    tenants_with_subscription_id: work.length,
    verified: checked,
    changed,
    failures,
    notices_sent: noticesSent,
    notice_failures: noticeFailures,
    unverifiable_licensed_tenants: unwiredLicensed.map((t: any) => t.slug),
    unverifiable_unlicensed_tenants: unwiredUnlicensed.map((t: any) => t.slug),
    comped_tenants: compedTenants.map((t: any) => t.slug),
    trial_tenants: trials.map((t: any) => t.slug),
  };
  const logErr = await record(db, startedAt, healthy ? "verified" : "error", healthy, detail);

  return json({
    outcome: healthy ? "verified" : "error",
    healthy, checked, tenants_total: tenantsTotal, changed, failures,
    notices_sent: noticesSent, notice_failures: noticeFailures,
    unverifiable_licensed_tenants: unwiredLicensed.map((t: any) => t.slug),
    unverifiable_unlicensed_tenants: unwiredUnlicensed.map((t: any) => t.slug),
    comped_tenants: compedTenants.map((t: any) => t.slug),
    trial_tenants: trials.map((t: any) => t.slug),
    log_error: logErr,
  }, healthy ? 200 : 500);
});

async function getCoachEmail(db: ReturnType<typeof admin>, coachUserId: string | null): Promise<string> {
  if (!coachUserId) return "";
  const { data } = await db.auth.admin.getUserById(coachUserId);
  return data?.user?.email ?? "";
}
