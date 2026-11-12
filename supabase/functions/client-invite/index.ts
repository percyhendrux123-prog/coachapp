// client-invite — mint a client's claim link AND pre-create their auth account.
// (verify_jwt=false; auth self-handled, same as license-portal.)
//
// POST { client_id }  (Bearer JWT required; caller must be the coach of that client's tenant)
//   → { claim_path, account: "created" | "existed" | "no_email" }
// POST { client_id, account_only: true } → { account, claim_path: null } (no token minted; Slice 3 Release)
// GET → health check.
//
// WHY THIS EXISTS. Previously the coach's invite button only wrote an invite token
// to the clients row; the client's auth account was created later, as a side effect
// of the magic-link request itself (supabase.auth.signInWithOtp defaults to
// shouldCreateUser: true). That made account creation open to anyone: a stranger
// with no invite could POST /auth/v1/otp with the public anon key and get a real
// account. Measured on the live API: HTTP 200, account created.
//
// Closing that door means disabling signups in Supabase Auth. But with signups
// disabled, the SAME call that onboards an invited first-time client is refused:
//   stranger, signup closed  -> 422 otp_disabled "Signups not allowed for otp"
// …and an invited client is indistinguishable from a stranger until their account
// exists. So turning the setting off without this function would silently break
// the most important funnel in the app.
//
// Creating the account here, at invite time, removes that dependency: by the time
// the client clicks their magic link the account already exists, and an existing
// account is served normally even with signups closed. Measured:
//   pre-existing CONFIRMED account,   signup closed -> 200, link sent
//   pre-existing UNCONFIRMED account, signup closed -> 200, link sent
// The unconfirmed case is the one that matters, and it works — so accounts are
// created UNCONFIRMED here. The client still proves control of the mailbox by
// clicking the link, which is what confirms them, and claim_client_invite()
// continues to require email_confirmed_at before it will link anyone.
//
// No password is ever set. Passwords are disabled project-wide (every hash was
// cleared); admin.createUser without a password keeps it that way.
import { admin, callerUserId, json, CORS } from "../_shared/challenge.ts";

const INVITE_TTL_DAYS = 14;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "client-invite" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);

  let body: { client_id?: string; account_only?: boolean } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const clientId = body?.client_id;
  // Slice 3: release_client() mints the token itself, atomically with the release. The
  // Release button calls this function FIRST with account_only=true to pre-create the
  // (inert, idempotent) auth account, then the RPC. No token is minted in that mode.
  const accountOnly = body?.account_only === true;
  if (!clientId) return json({ error: "client_id required" }, 400);

  const db = admin();

  // Caller must be a coach, and the client must belong to that coach's tenant.
  const { data: prof } = await db.from("profiles").select("tenant_id, role").eq("user_id", userId).maybeSingle();
  if (!prof || prof.role !== "coach") return json({ error: "coach only" }, 403);

  const { data: client, error: cErr } = await db
    .from("clients").select("id, tenant_id, email, display_name")
    .eq("id", clientId).maybeSingle();
  if (cErr) return json({ error: "client lookup: " + cErr.message }, 500);
  if (!client) return json({ error: "client not found" }, 404);
  if (client.tenant_id !== prof.tenant_id) return json({ error: "client is not in your tenant" }, 403);

  // Pre-create the auth account so the claim survives signups being disabled.
  // Idempotent: minting a second invite for the same person must not error or
  // duplicate, so an existing account is simply reported as "existed".
  let account: "created" | "existed" | "no_email" = "no_email";
  const email = (client.email || "").trim();

  if (email) {
    const { data: found, error: lErr } = await db.rpc("auth_user_id_by_email", { p_email: email });
    if (lErr) return json({ error: "account lookup: " + lErr.message }, 500);

    if (found) {
      account = "existed";
    } else {
      const { data: made, error: cuErr } = await db.auth.admin.createUser({
        email,
        email_confirm: false,          // they confirm by clicking their magic link
        user_metadata: { invited_as: client.display_name ?? null },
      });
      if (cuErr) {
        // A race (two invites minted at once) surfaces as "already registered" —
        // that is the idempotent outcome, not a failure.
        if (/already|exists|registered/i.test(cuErr.message)) account = "existed";
        else return json({ error: "account create: " + cuErr.message }, 500);
      } else {
        account = "created";
        // createUser writes a bcrypt hash even though no password was supplied.
        // Passwords are disabled project-wide, so strip it — otherwise the
        // property erodes one invite at a time. Reported, never swallowed.
        const uid = made?.user?.id;
        if (uid) {
          const { error: pwErr } = await db.rpc("auth_clear_password", { p_user_id: uid });
          if (pwErr) return json({ error: "account create: password strip failed: " + pwErr.message }, 500);
        }
      }
    }
  }

  if (accountOnly) return json({ account, claim_path: null, expires_at: null, account_only: true });

  // Mint the token last, so a failed account step never leaves a live invite behind.
  const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
  const expires = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000).toISOString();
  const { error: uErr } = await db.from("clients")
    .update({ invite_token: token, invite_expires_at: expires })
    .eq("id", client.id).eq("tenant_id", prof.tenant_id);
  if (uErr) return json({ error: "invite: " + uErr.message }, 500);

  // The caller builds the absolute URL from its own origin.
  return json({ claim_path: `/claim?token=${token}`, account, expires_at: expires });
});
