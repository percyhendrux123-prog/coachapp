// White-label license storefront data layer.
import { supabase } from "./supabase";
import { attributionBody } from "./attribution";

async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return data;
}

// The six attribution fields (see ./attribution.js) ride every checkout call so the Stripe
// session names the post the buyer came from. The server re-sanitizes them.
export const startLicenseCheckout = ({ coupon } = {}) =>
  invoke("license-checkout", {
    success_url: `${window.location.origin}/license?session_id={CHECKOUT_SESSION_ID}`,
    coupon: coupon ? String(coupon).trim() : undefined,
    ...attributionBody(),
  });

export const provisionLicense = ({ sessionId, appName, displayName }) =>
  invoke("license-provision", { session_id: sessionId, app_name: appName, display_name: displayName });

// Branding + coach payment link for the signed-in member's tenant. Both coaches (tc_coach_all)
// and clients (tc_member_read) can now read tenant_config directly, scoped to their own tenant.
// Carries the full white-label surface: identity, theme, logo, welcome/about content, and
// the client-experience feature flags (all default ON when null).
export async function getTenantBranding() {
  const { data, error } = await supabase
    .from("tenant_config")
    .select(
      "app_name, coach_display_name, client_payment_url, brand_color, logo_url, theme_key, " +
      "welcome_message, welcome_video_url, about_headline, about_body, about_photo_url, " +
      "bio_body, bio_photo_url, framework_name, framework_body, framework_media_url, " +
      "messaging_on, progress_weight_on, progress_photos_on, weight_unit, mode",
    )
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}
