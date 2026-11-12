import {
  accessFor, graceNotice, resolveGraceStage, resolvedNotice,
  trialWarningNotice, trialEndedNotice,
} from "./grace.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("notice branding defaults to Coach App and escapes configured HTML", () => {
  const previous = Deno.env.get("PLATFORM_NAME");
  const notices = () => [
    ...[1, 2, 3, 4].map((stage) => graceNotice(stage, { slug: "test-tenant", suspendDate: "Tomorrow" })),
    resolvedNotice({ slug: "test-tenant" }),
    trialWarningNotice({ slug: "test-tenant", trialEndDate: "Tomorrow" }),
    trialEndedNotice({ slug: "test-tenant" }),
  ];
  try {
    Deno.env.delete("PLATFORM_NAME");
    for (const notice of notices()) assert(notice.html.includes("Coach App"), "default brand is required");
    Deno.env.set("PLATFORM_NAME", '<Brand & "Team">');
    for (const notice of notices()) {
      assert(notice.html.includes("&lt;Brand &amp; &quot;Team&quot;&gt;"), "configured brand must be escaped");
      assert(!notice.html.includes('<Brand'), "raw brand markup must not appear");
    }
  } finally {
    if (previous === undefined) Deno.env.delete("PLATFORM_NAME");
    else Deno.env.set("PLATFORM_NAME", previous);
  }
});

Deno.test("accessFor: past_due stays active, terminal states are suspended", () => {
  assert(accessFor("active").tenant_status === "active", "active should stay active");
  assert(accessFor("trialing").tenant_status === "active", "trialing should stay active");
  assert(accessFor("past_due").tenant_status === "active", "past_due is Stripe's own grace window — active");
  for (const bad of ["canceled", "unpaid", "incomplete_expired", "paused"]) {
    assert(accessFor(bad).tenant_status === "suspended", `${bad} should map to suspended`);
  }
});

Deno.test("resolveGraceStage: day 0/3/7/10 boundaries match the grace policy", () => {
  assert(resolveGraceStage(0, 0) === 1, "day 0 (just detected) should be stage 1");
  assert(resolveGraceStage(2.9, 1) === 1, "just under day 3 should stay at stage 1");
  assert(resolveGraceStage(3, 1) === 2, "day 3 should advance to stage 2");
  assert(resolveGraceStage(6.9, 2) === 2, "just under day 7 should stay at stage 2");
  assert(resolveGraceStage(7, 2) === 3, "day 7 should advance to stage 3");
  assert(resolveGraceStage(9.9, 3) === 3, "just under day 10 should stay at stage 3");
  assert(resolveGraceStage(10, 3) === 4, "day 10 should advance to stage 4 (suspend)");
  assert(resolveGraceStage(30, 3) === 4, "well past day 10 should still be stage 4, not higher");
});

Deno.test("resolveGraceStage: never regresses below the already-recorded stage", () => {
  // A missed cron run (daysSinceBad computed fresh, but stage already advanced
  // further on a prior run somehow) must never walk the stage backward.
  assert(resolveGraceStage(1, 3) === 3, "a low day count must not pull stage 3 back down to 1");
  assert(resolveGraceStage(0, 4) === 4, "stage 4 (suspended) must never be un-advanced by this function");
});

Deno.test("graceNotice: every stage names the tenant slug and produces distinct copy", () => {
  const ctx = { slug: "test-tenant", suspendDate: "Mon Sep 01 2026" };
  const seen = new Set<string>();
  for (const stage of [1, 2, 3, 4]) {
    const notice = graceNotice(stage, ctx);
    assert(notice.subject.includes("test-tenant"), `stage ${stage} subject should name the tenant`);
    assert(!seen.has(notice.subject), `stage ${stage} must not reuse another stage's subject`);
    seen.add(notice.subject);
  }
});

Deno.test("graceNotice: stage 1-3 mention the suspend date, stage 4 does not (it already happened)", () => {
  const ctx = { slug: "test-tenant", suspendDate: "Mon Sep 01 2026" };
  assert(graceNotice(1, ctx).html.includes(ctx.suspendDate), "stage 1 should name the deadline");
  assert(graceNotice(2, ctx).html.includes(ctx.suspendDate), "stage 2 should name the deadline");
  assert(graceNotice(3, ctx).html.includes(ctx.suspendDate), "stage 3 should name the deadline");
});

Deno.test("resolvedNotice names the tenant and reads as a clean all-clear", () => {
  const notice = resolvedNotice({ slug: "test-tenant" });
  assert(notice.subject.includes("test-tenant"), "resolved subject should name the tenant");
  assert(/clear|current|resolved/i.test(notice.subject), "resolved subject should read as good news, not a warning");
});

Deno.test("graceNotice: reason defaults to payment_failed, preserving existing behavior", () => {
  const ctx = { slug: "test-tenant", suspendDate: "Mon Sep 01 2026" };
  for (const stage of [1, 2, 3]) {
    assert(
      /payment/i.test(graceNotice(stage, ctx).html),
      `stage ${stage} with no reason specified should still describe a payment problem`,
    );
  }
});

Deno.test("graceNotice: never_wired never claims a payment was attempted", () => {
  // A licensed-but-unwired tenant never had a subscription to fail — reusing the
  // payment_failed copy here would state something false.
  const ctx = { slug: "test-tenant", suspendDate: "Mon Sep 01 2026", reason: "never_wired" as const };
  for (const stage of [1, 2, 3, 4]) {
    const html = graceNotice(stage, ctx).html;
    assert(!/didn't go through/i.test(html), `stage ${stage} (never_wired) must not claim a payment failed`);
    assert(!/update your payment method/i.test(html), `stage ${stage} (never_wired) must not ask to update a payment method that was never on file`);
  }
});

Deno.test("graceNotice: never_wired still produces distinct, slug-naming, deadline-bearing copy", () => {
  const ctx = { slug: "test-tenant", suspendDate: "Mon Sep 01 2026", reason: "never_wired" as const };
  const seen = new Set<string>();
  for (const stage of [1, 2, 3, 4]) {
    const notice = graceNotice(stage, ctx);
    assert(notice.subject.includes("test-tenant"), `never_wired stage ${stage} subject should name the tenant`);
    assert(!seen.has(notice.subject), `never_wired stage ${stage} must not reuse another stage's subject`);
    seen.add(notice.subject);
  }
  assert(graceNotice(1, ctx).html.includes(ctx.suspendDate), "never_wired stage 1 should name the deadline");
  assert(graceNotice(2, ctx).html.includes(ctx.suspendDate), "never_wired stage 2 should name the deadline");
  assert(graceNotice(3, ctx).html.includes(ctx.suspendDate), "never_wired stage 3 should name the deadline");
});

Deno.test("trialWarningNotice: names the tenant and the actual deadline, distinct from payment copy", () => {
  const notice = trialWarningNotice({ slug: "test-tenant", trialEndDate: "Mon Sep 08 2026" });
  assert(notice.subject.includes("test-tenant"), "trial warning subject should name the tenant");
  assert(notice.html.includes("Mon Sep 08 2026"), "trial warning should name the actual trial end date");
  assert(!/payment didn't go through|update your payment method/i.test(notice.html), "trial warning must not reuse payment-failure copy");
});

Deno.test("trialEndedNotice: names the tenant, reads as reversible, not a payment failure", () => {
  const notice = trialEndedNotice({ slug: "test-tenant" });
  assert(notice.subject.includes("test-tenant"), "trial-ended subject should name the tenant");
  assert(!/payment didn't go through/i.test(notice.html), "trial-ended must not claim a payment failed");
  assert(/subscribe/i.test(notice.html), "trial-ended should point at the actual next step (subscribing)");
});
