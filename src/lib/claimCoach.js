// Client-side call to the coach-invite claim RPC. Authenticated (verified email) only;
// the RPC attaches this user as coach_user_id on the invited tenant AND mints
// profiles.role='coach' in one shot. Returns a status code string (see
// claim_coach_invite in supabase/migrations/20260825120000_add_coach_provisioning.sql).
import { supabase } from "./supabase";

export async function claimCoachInvite(token) {
  const { data, error } = await supabase.rpc("claim_coach_invite", { p_token: token });
  if (error) throw error;
  return data; // 'claimed' | 'already_yours' | 'expired' | 'invalid' | 'already_claimed' | 'already_has_account' | 'unconfirmed' | 'not_authenticated'
}
