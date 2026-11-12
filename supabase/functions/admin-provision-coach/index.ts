// admin-provision-coach — one-click coach creation for the platform owner only.
// (verify_jwt=false; auth self-handled.)
//
// Gated to whoever coaches the owner tenant specifically — this app has no
// separate "admin" role, so it reuses the existing coach/tenant model instead
// of inventing one, the same call made for the license-portal button and
// every other coach-scoped endpoint in this codebase.
//
// POST { app_name, display_name, mode: "trial" | "comped" | "paid",
//        reason?,              -- required for mode "comped"
//        subscription_id?, customer_id?  -- required for mode "paid", verified
//                                            against Stripe before trusting them
//        upgrade_slug?         -- see below
//      }
//   -> { slug, claim_path, warning? } | { slug, upgraded: true }
// GET -> health check.
//
// upgrade_slug: pass the slug of a coach's EXISTING, already-claimed tenant to
// upgrade it in place (mode must be "comped" or "paid") instead of creating a
// new one. Creating another tenant for an existing coach leaves their original
// tenant unchanged and can leave an unclaimed duplicate.
// Always pass upgrade_slug when the coach already has a tenant; omit it only
// for a genuinely new coach.
//
// On a plain create (no upgrade_slug), the response may carry a `warning` if
// the new app_name/display_name looks like it might already belong to an
// existing, claimed coach — a heuristic substring match, not a hard block.
// Creating near-duplicate tenants is the exact failure this endpoint has no
// other way to catch, since it has no coach email/identity to key on before
// a tenant is claimed.
import Stripe from "npm:stripe@17";
import { admin, callerUserId, json, CORS, STRIPE_KEY } from "../_shared/challenge.ts";
import { OWNER_TENANT_SLUG } from "../_shared/owner.ts";

const stripe = new Stripe(STRIPE_KEY || "sk_test_placeholder", { apiVersion: "2024-06-20" });


function normalize(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "admin-provision-coach" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);

  const db = admin();
  const { data: prof } = await db.from("profiles").select("tenant_id, role").eq("user_id", userId).maybeSingle();
  if (!prof || prof.role !== "coach") return json({ error: "coach only" }, 403);
  const { data: tenant } = await db.from("tenants").select("slug").eq("id", prof.tenant_id).maybeSingle();
  if (tenant?.slug !== OWNER_TENANT_SLUG) return json({ error: "not authorized" }, 403);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const appName = typeof body?.app_name === "string" ? body.app_name.trim() : "";
  const displayName = typeof body?.display_name === "string" ? body.display_name.trim() : "";
  const mode = body?.mode;
  const upgradeSlug = typeof body?.upgrade_slug === "string" ? body.upgrade_slug.trim() : "";
  if (!["trial", "comped", "paid"].includes(mode)) {
    return json({ error: "mode must be one of trial, comped, paid" }, 400);
  }
  if (upgradeSlug && mode === "trial") {
    return json({ error: "upgrade_slug requires mode comped or paid — an existing tenant can't be 'upgraded' to trial" }, 400);
  }

  let reason: string | null = null;
  let subscriptionId: string | null = null;
  let customerId: string | null = null;

  if (mode === "comped") {
    reason = typeof body?.reason === "string" ? body.reason.trim() : "";
    if (!reason) return json({ error: "reason is required for mode=comped" }, 400);
  }

  if (mode === "paid") {
    subscriptionId = typeof body?.subscription_id === "string" ? body.subscription_id.trim() : "";
    customerId = typeof body?.customer_id === "string" ? body.customer_id.trim() : "";
    if (!subscriptionId || !customerId) {
      return json({ error: "subscription_id and customer_id are required for mode=paid" }, 400);
    }
    if (!STRIPE_KEY) return json({ error: "payments unavailable" }, 500);
    // Never trust a pasted ID blindly — confirm it's a real, live subscription
    // for the customer named, before it gets attached to a tenant.
    try {
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      if (!["active", "trialing"].includes(sub.status)) {
        return json({ error: `subscription ${subscriptionId} is not active (status: ${sub.status})` }, 400);
      }
      const subCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      if (subCustomerId !== customerId) {
        return json({ error: "subscription's customer does not match the customer_id provided" }, 400);
      }
    } catch (e) {
      return json({ error: "could not verify subscription: " + (e as Error).message }, 400);
    }
  }

  if (upgradeSlug) {
    const { data: upgraded, error: upErr } = await db.rpc("upgrade_coach_tenant_admin", {
      p_slug: upgradeSlug,
      p_mode: mode,
      p_reason: reason,
      p_subscription_id: subscriptionId,
      p_customer_id: customerId,
    });
    if (upErr) return json({ error: "upgrade: " + upErr.message }, 500);
    return json({ slug: upgraded.slug, upgraded: true });
  }

  // Heuristic near-duplicate check, warning-only. Compares normalized
  // app_name/display_name against every
  // CLAIMED tenant's tenant_config; a substring match either direction is
  // flagged, nothing is blocked.
  let warning: string | null = null;
  const normNew = normalize(appName) || normalize(displayName);
  if (normNew) {
    const { data: claimed } = await db
      .from("tenants")
      .select("slug, tenant_config(app_name, coach_display_name)")
      .not("coach_user_id", "is", null);
    for (const row of claimed ?? []) {
      const cfg = Array.isArray(row.tenant_config) ? row.tenant_config[0] : row.tenant_config;
      const candidates = [normalize(cfg?.app_name), normalize(cfg?.coach_display_name)].filter(Boolean);
      const hit = candidates.some((c) => c.length >= 4 && (c.includes(normNew) || normNew.includes(c)));
      if (hit) {
        warning = `This looks similar to the already-claimed tenant "${row.slug}" — if that's the same coach, use upgrade_slug instead of creating a new tenant.`;
        break;
      }
    }
  }

  const { data: newTenant, error: rpcErr } = await db.rpc("provision_coach_admin", {
    p_app_name: appName,
    p_display_name: displayName,
    p_mode: mode,
    p_reason: reason,
    p_subscription_id: subscriptionId,
    p_customer_id: customerId,
  });
  if (rpcErr) return json({ error: "provision: " + rpcErr.message }, 500);

  return json({
    slug: newTenant.slug,
    claim_path: `/claim-coach?token=${newTenant.invite_token}`,
    ...(warning ? { warning } : {}),
  });
});
