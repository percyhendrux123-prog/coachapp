// Policy and notice copy for license-reconcile's payment-grace flow — no Stripe or
// Supabase client. Branding reads PLATFORM_NAME. Kept separate for unit tests without
// pulling in npm:stripe (which this local Deno setup can't resolve outside the
// deployed edge runtime).
//
// Notify before suspending: three notices (day 0/3/7) to the coach and the
// optional ops inbox, then suspend on day 10 if still unresolved.

const platformName = () => Deno.env.get("PLATFORM_NAME") || "Coach App";
const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const GRACE_DAYS = { notice2: 3, notice3: 7, suspend: 10 } as const;

// Map a Stripe subscription status → tenant access. past_due stays active (that's
// Stripe's own ~2-3 week dunning-retry grace window); a terminal failure enters
// OUR grace window (resolveGraceStage) rather than suspending immediately.
export function accessFor(status: string): { subscription_status: string; tenant_status: "active" | "suspended" } {
  if (status === "active" || status === "trialing" || status === "past_due")
    return { subscription_status: status, tenant_status: "active" };
  return { subscription_status: status, tenant_status: "suspended" }; // canceled | unpaid | incomplete_expired | paused
}

// Given how long a tenant has been in a bad Stripe state and the stage last
// recorded for it, what stage should it be at now? Never returns a stage lower
// than currentStage — a tenant already at a later stage never walks backward.
export function resolveGraceStage(daysSinceBad: number, currentStage: number): number {
  let target = 1;
  if (daysSinceBad >= GRACE_DAYS.suspend) target = 4;
  else if (daysSinceBad >= GRACE_DAYS.notice3) target = 3;
  else if (daysSinceBad >= GRACE_DAYS.notice2) target = 2;
  return Math.max(target, currentStage);
}

// Notice copy. Plain and direct — this is a billing notice, not marketing content.
//
// `reason` distinguishes two different facts that both land a tenant in the same grace
// clock: "payment_failed" (a real subscription existed and Stripe reports it bad — the
// original case this was built for) vs "never_wired" (the tenant paid the one-time license
// fee but no subscription was ever attached). The wording must not claim a payment
// attempt happened when none did — reusing "payment didn't go through, even after retries"
// for a never-wired tenant would be stating something false. Defaults to "payment_failed" so
// every existing call site keeps its exact current behavior unchanged.
export function graceNotice(
  stage: number,
  ctx: { slug: string; suspendDate: string; reason?: "payment_failed" | "never_wired" },
): { subject: string; html: string } {
  const reason = ctx.reason ?? "payment_failed";
  const name = platformName();
  const brand = escapeHtml(name);
  const p = (body: string) =>
    `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto">${body}</div>`;
  const problem = reason === "never_wired"
    ? `Your ${brand} coaching account was never attached to an active hosting subscription.`
    : `Your ${brand} hosting subscription payment didn't go through, even after the usual retries.`;
  const fixInstruction = reason === "never_wired"
    ? "Reply to this email to finish setting up billing."
    : "Reply to this email to update your payment method.";
  if (stage === 1) {
    return {
      subject: `Action needed — billing issue on your ${name} coaching account (${ctx.slug})`,
      html: p(`
        <h2 style="color:#111">Billing issue on your account</h2>
        <p>${problem}</p>
        <p>Nothing has changed yet — your coaching platform access is unaffected right now. If this
        isn't resolved by <b>${ctx.suspendDate}</b>, access will pause.</p>
        <p>${fixInstruction}</p>
      `),
    };
  }
  if (stage === 2) {
    return {
      subject: `Reminder — billing still unresolved (${ctx.slug})`,
      html: p(`
        <h2 style="color:#111">Reminder: billing still unresolved</h2>
        <p>This is a reminder — the billing issue on your ${brand} account from a few days ago hasn't
        been resolved. Access is still active. If it isn't fixed by <b>${ctx.suspendDate}</b>,
        access will pause.</p>
        <p>${fixInstruction}</p>
      `),
    };
  }
  if (stage === 3) {
    return {
      subject: `Final notice — access pauses ${ctx.suspendDate} (${ctx.slug})`,
      html: p(`
        <h2 style="color:#111">Final notice</h2>
        <p>This is the final notice. ${problem} Access will
        pause on <b>${ctx.suspendDate}</b> unless it's fixed before then.</p>
        <p>${fixInstruction.replace("Reply to this email", "Reply to this email right away")}</p>
      `),
    };
  }
  const pausedFix = reason === "never_wired"
    ? "reply to this email to finish setting up billing and access will be restored"
    : "reply to this email to update your payment method and access will be restored";
  return {
    subject: `Access paused — ${ctx.slug}`,
    html: p(`
      <h2 style="color:#111">Access paused</h2>
      <p>Your ${brand} billing was never resolved after three notices over 10 days, so access
      has now paused. This is reversible — ${pausedFix}.</p>
    `),
  };
}

export function resolvedNotice(ctx: { slug: string }): { subject: string; html: string } {
  return {
    subject: `Resolved — payment is current again (${ctx.slug})`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#111">You're clear</h2>
      <p>Your ${escapeHtml(platformName())} hosting subscription payment is current again. No further action needed.</p>
    </div>`,
  };
}

// Trial notices are deliberately NOT modeled as graceNotice() stages. A trial counts
// down to a known deadline (tenants.trial_ends_at) — one warning, then one cutoff —
// not up through 4 staged notices from an unknown "first noticed bad" point. Forcing
// this shape through resolveGraceStage/graceNotice would mean fake stage numbers that
// don't mean what they mean everywhere else that reads them (ops_job_runs detail,
// noticesSent entries). Two small, honest functions instead.
export const TRIAL_DAYS = { warnWithinDays: 2 } as const;

export function trialWarningNotice(ctx: { slug: string; trialEndDate: string }): { subject: string; html: string } {
  return {
    subject: `Your ${platformName()} trial ends soon — ${ctx.trialEndDate} (${ctx.slug})`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#111">Your trial is almost over</h2>
      <p>Your ${escapeHtml(platformName())} coaching app trial ends <b>${ctx.trialEndDate}</b>. Everything you've set up
      stays exactly as it is — subscribing before then just keeps it running without a pause.</p>
      <p>Reply to this email to continue with a hosting subscription.</p>
    </div>`,
  };
}

export function trialEndedNotice(ctx: { slug: string }): { subject: string; html: string } {
  return {
    subject: `Your ${platformName()} trial has ended (${ctx.slug})`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#111">Trial ended</h2>
      <p>Your ${escapeHtml(platformName())} coaching app trial period has ended, so access has paused. Nothing you built
      during the trial was lost — reply to this email to subscribe
      to a hosting subscription and pick up exactly where you left off.</p>
    </div>`,
  };
}
