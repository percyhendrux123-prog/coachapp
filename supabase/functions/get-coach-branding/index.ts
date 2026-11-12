// get-coach-branding — the ONE genuinely public, unauthenticated endpoint in this
// backend. Looks up a coach's pre-login branding by their tenant slug, so a vanity
// URL like app.example.com/outside-coach can show that coach's own logo and
// color before the visitor ever signs in, instead of a generic screen.
//
// Deliberately returns nothing beyond what a login screen needs to skin itself —
// no welcome copy, no bio, no framework content, no client_payment_url, and never
// coach_doctrine (explicitly "coach-only — never exposed to a client-scoped token"
// per its own schema comment; this endpoint has no token at all, so it is held to
// the same bar). A nonexistent slug and a suspended tenant's slug return the
// identical {found:false} shape, on purpose — this must not be usable to enumerate
// which vanity URLs are live versus cancelled.
//
// POST { slug }  (no auth — same calling convention as every other function here,
//   via supabase.functions.invoke, just with nothing to check the caller against)
//   -> { found: true, branding: {...} } | { found: false }
// GET -> health check.
import { admin, json, CORS } from "../_shared/challenge.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "get-coach-branding" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: { slug?: string } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const slug = (body?.slug || "").trim().toLowerCase();
  if (!slug) return json({ error: "slug required" }, 400);

  const db = admin();
  const { data: tenant } = await db.from("tenants").select("id, status").eq("slug", slug).maybeSingle();
  if (!tenant || tenant.status !== "active") return json({ found: false });

  const { data: cfg } = await db.from("tenant_config")
    .select("app_name, coach_display_name, logo_url, brand_color, theme_key, surface_mode")
    .eq("tenant_id", tenant.id).maybeSingle();

  return json({
    found: true,
    branding: {
      app_name: cfg?.app_name ?? null,
      coach_display_name: cfg?.coach_display_name ?? null,
      logo_url: cfg?.logo_url ?? null,
      brand_color: cfg?.brand_color ?? "#0a0a0a",
      theme_key: cfg?.theme_key ?? "liquid_glass",
      surface_mode: cfg?.surface_mode ?? "dark",
    },
  });
});
