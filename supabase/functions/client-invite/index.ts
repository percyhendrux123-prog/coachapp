// client-invite — mint a client's claim link AND pre-create their auth account.
// (verify_jwt=false; auth self-handled, same as license-portal.)
//
// POST { client_id }  (Bearer JWT required; caller must be the coach of that client's tenant)
//   → { claim_path, account: "created" | "existed" | "no_email" }
// POST { client_id, account_only: true } → { account, claim_path: null } (no token minted; Slice 3 Release)
// GET → health check.
//
// WHY THIS EXISTS. With "Allow new users to sign up" ON, anyone holding the public
// anon key can create an (empty) account by requesting a code: signInWithOtp
// defaults to shouldCreateUser: true. The claim rules keep client data out of reach
// of such an account, but a coach may still want sign-ups OFF. With sign-ups off,
// an invited first-time client must still get in, and that only works if their
// account exists before they ask for a code. So the account is created here, at
// invite time.
//
// It is created UNCONFIRMED, so the client still has to prove control of the
// mailbox: entering the emailed code is what confirms them, and
// claim_client_invite() requires email_confirmed_at before it will link anyone.
//
// What Supabase Auth does with that account (measured on GoTrue v2.197.0, sign-ups
// OFF, "Confirm email" ON):
//   POST /otp    unconfirmed invited account -> 422 signup_disabled (no email)
//   POST /otp    address with no account     -> 422 signup_disabled (nothing created)
//   POST /resend type=signup, unconfirmed    -> 200, "Confirm signup" email with the code
//   POST /resend type=signup, no account     -> 200, no email, nothing created
// So the app's code request (src/lib/emailAuth.js) falls back to /resend when /otp
// answers signup_disabled. Older GoTrue versions served /otp for an unconfirmed
// account; do not rely on that. Whether sign-ups are on or off is a per-project
// setting: read it at /auth/v1/settings (disable_signup), not from a comment.
//
// No password is ever set. The app signs people in with email codes only and never
// offers a password; admin.createUser without a password keeps it that way.
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
        // The app never uses passwords, so strip it — otherwise the
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
