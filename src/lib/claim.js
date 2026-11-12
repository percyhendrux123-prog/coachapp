// Client-side call to the anti-lockout claim RPC. Authenticated (verified email) only;
// the RPC links this user to the invited clients row AND mints profiles.role='client' in
// one shot. Returns a status code string (see claim_client_invite in the migration).
import { supabase } from "./supabase";

export async function claimInvite(token) {
  const { data, error } = await supabase.rpc("claim_client_invite", { p_token: token });
  if (error) throw error;
  return data; // 'claimed' | 'already_yours' | 'expired' | 'invalid' | 'already_claimed' | 'other_client' | 'role_conflict' | 'unconfirmed' | 'not_authenticated'
}
