// Pre-login branding lookup by tenant slug — the one place the app reads branding
// before a session exists. See supabase/functions/get-coach-branding for what it
// deliberately does and doesn't return.
import { supabase } from "./supabase";

export async function getCoachBrandingBySlug(slug) {
  const { data, error } = await supabase.functions.invoke("get-coach-branding", { body: { slug } });
  if (error) throw error;
  return data?.found ? data.branding : null;
}
