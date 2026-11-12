// Self-serve plan buyer path. Both functions are public (the buyer is a stranger); the anon key
// on supabase.functions.invoke passes the gateway, the function owns every trust check.
import { supabase } from "./supabase";
import { attributionBody } from "./attribution";

async function invoke(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let detail = error.message;
    try { detail = (await error.context?.json())?.error ?? detail; } catch { /* keep */ }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// `promo` is optional and only ever comes from a URL parameter (?code=…) — there is no
// promo field on the page and Stripe's own box is off. The server allow-lists it.
// Every checkout call carries the six attribution fields (see ./attribution.js) so the Stripe
// session names the post the buyer came from. The server re-sanitizes them.
export const startSystemCheckout = ({ email, answers, promo }) =>
  invoke("system-checkout", { email, answers, ...(promo ? { promo } : {}), ...attributionBody() });
export const redeemSystemSession = (session_id) => invoke("system-provision", { session_id });

// The eight health-screen questions, in the intake's own words, keyed as the server expects.
export const SCREEN_QUESTIONS = [
  ["parq_heart_condition", "Heart condition / doctor-limited activity?"],
  ["parq_chest_pain", "Chest pain with activity?"],
  ["parq_dizziness", "Dizziness or loss of consciousness?"],
  ["parq_bone_joint", "Bone/joint problem worsened by activity?"],
  ["parq_bp_meds", "Blood pressure or heart medication?"],
  ["parq_other_reason", "Any other reason not to exercise?"],
  ["pregnant", "Pregnant or could be pregnant?"],
  ["eating_disorder_history", "History of an eating disorder?"],
];
