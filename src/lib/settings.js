// Coach tenant settings (branding + external payment link). Writes are coach-only (tc_coach_all).
import { supabase } from "./supabase";

// Neutral default brand color == the app's existing `ink` primary. A tenant on this value
// (including every tenant before the color picker existed) renders identically to before.
export const DEFAULT_BRAND_COLOR = "#0a0a0a";

export async function getTenantConfig() {
  const { data, error } = await supabase
    .from("tenant_config")
    .select(
      "app_name, coach_display_name, client_payment_url, brand_color, logo_url, theme_key, " +
      "welcome_message, welcome_video_url, about_headline, about_body, about_photo_url, " +
      "bio_body, bio_photo_url, framework_name, framework_body, framework_media_url, " +
      "messaging_on, progress_weight_on, progress_photos_on, sender_email, onboarding_reminders",
    )
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveTenantConfig({ tenantId, ...fields }) {
  const { error } = await supabase
    .from("tenant_config")
    .update(fields)
    .eq("tenant_id", tenantId);
  if (error) throw error;
}

// Upload a brand image (logo / about photo) to the public `brand` bucket under the
// tenant prefix the brand_coach_write storage policy requires. Returns the public URL.
export async function uploadBrandImage({ tenantId, file, kind }) {
  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const path = `${tenantId}/${kind}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from("brand").upload(path, file, { upsert: true });
  if (error) throw error;
  return supabase.storage.from("brand").getPublicUrl(path).data.publicUrl;
}

// A native <input type="color"> only ever yields "#rrggbb". Guard anyway so a bad value
// can't reach CSS; fall back to the neutral default.
export function normalizeHexColor(raw) {
  const s = (raw ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : DEFAULT_BRAND_COLOR;
}

// Light validation so a fat-fingered link doesn't silently break the client "pay" button.
// Returns { ok, value, error }. Empty is allowed (clears the link). Bare hosts get https://.
export function normalizePaymentUrl(raw) {
  const s = (raw ?? "").trim();
  if (!s) return { ok: true, value: null };
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let u;
  try { u = new URL(withScheme); } catch { return { ok: false, error: "That doesn't look like a valid link." }; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) {
    return { ok: false, error: "Enter a full payment link (e.g. https://buy.stripe.com/…, paypal.me/…, venmo.com/…)." };
  }
  return { ok: true, value: u.toString() };
}

// Stripe Payment Links accept a coupon via prefilled_promo_code. Other hosts
// get the code appended as coupon= so the owner can read it on the receiving page.
export function paymentUrlWithCoupon(rawUrl, coupon) {
  const code = (coupon ?? "").trim();
  if (!rawUrl) return null;
  if (!code) return rawUrl;
  try {
    const u = new URL(rawUrl);
    if (u.hostname.includes("stripe.com") || u.hostname.includes("buy.stripe.com")) {
      u.searchParams.set("prefilled_promo_code", code);
    } else {
      u.searchParams.set("coupon", code);
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}
