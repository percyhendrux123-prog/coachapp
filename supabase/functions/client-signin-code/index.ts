// client-signin-code — hand the coach a client's one-time sign-in code to read over the phone.
// (verify_jwt=false; auth self-handled, same posture as client-invite and license-portal.)
//
// POST { client_id }  (Bearer JWT; caller must be the coach of that client's tenant)
//   → { code, email, account: "created" | "existed", linked: "linked" | "already", profile: "created" | "existed", audit_logged }
// GET → health check.
//
// WHY THIS EXISTS. Some clients cannot find the emailed code (spam folder, a shared tablet, an
// email the project's mailer is not allowed to reach). There was no other way in: the app has
// no passwords, the code lives only in the email, and nobody (coach, dashboard, agent) could
// see it. This is the other way in: the coach vouches for the person on the phone and reads
// them the code.
//
// HOW. auth.admin.generateLink({ type: "magiclink" }) returns the same one-time code the email
// would have carried (properties.email_otp). The client types it on the sign-in screen behind
// "I already have a code". That screen must NOT request a fresh code first: a new request
// overwrites the one the coach just read out. The code has the same lifetime as an emailed one.
//
// LINKING. If the client row has no account attached yet, the auth user the coach is vouching
// for is attached here. claim_client_invite() waits for email_confirmed_at because a claim link
// can be forwarded to anyone; here the proof is the coach, on the phone, with the person. The
// link is made on the coach's authority and written to the audit log. If that account already
// owns a different client row (clients_user_unique), this refuses and changes nothing.
//
// PROFILE. The app decides "coach or client?" from public.profiles, not from clients.client_user_id
// (AuthCallback reads profiles.role). claim_client_invite() and link_client_by_email() both mint
// the client profile when they attach a row — but they only run for a row that is still
// unattached, and this function attaches first, so neither ever fires for a code-issued account.
// Found on the first real-world proof: account created, row attached, sign-in accepted,
// then "this email isn't linked as a coach or client yet". The profile is minted here, same
// shape, idempotent. An account that already carries a non-client role is refused, as the
// claim path refuses it (role_conflict).
//
// AUDIT. Every issuance writes one notification_log row (channel in_app, template
// coach_signin_code) carrying the coach's user id, so "who handed out a code, and when" is a
// query, not a memory. A failed audit write is reported in the response, never swallowed.
//
// NOT DONE HERE. No email is sent. No token is minted. The intake / invite paths are untouched.
import { admin, callerUserId, json, CORS } from "../_shared/challenge.ts";

// Mask for the response: the screen shows where the code is tied without echoing it whole.
const maskEmail = (e: string) => e.replace(/^(.).*?(.?)@/, (_m, a, b) => `${a}…${b}@`);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") return json({ ok: true, service: "client-signin-code" });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const userId = await callerUserId(req);
  if (!userId) return json({ error: "authentication required" }, 401);

  let body: { client_id?: string } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const clientId = body?.client_id;
  if (!clientId) return json({ error: "client_id required" }, 400);

  const db = admin();

  // Caller must be a coach, and the client must belong to that coach's tenant.
  const { data: prof } = await db.from("profiles").select("tenant_id, role").eq("user_id", userId).maybeSingle();
  if (!prof || prof.role !== "coach") return json({ error: "coach only" }, 403);

  const { data: client, error: cErr } = await db
    .from("clients").select("id, tenant_id, email, display_name, client_user_id")
    .eq("id", clientId).maybeSingle();
  if (cErr) return json({ error: "client lookup: " + cErr.message }, 500);
  if (!client) return json({ error: "client not found" }, 404);
  if (client.tenant_id !== prof.tenant_id) return json({ error: "client is not in your tenant" }, 403);

  const email = (client.email || "").trim().toLowerCase();
  if (!email) {
    return json({ error: "This client has no email on their record. A sign-in code is tied to an email — add one to the profile first." }, 400);
  }

  // ── Account: find or pre-create, exactly as client-invite does ─────────────────────
  let account: "created" | "existed" = "existed";
  let uid: string | null = null;
  const { data: found, error: lErr } = await db.rpc("auth_user_id_by_email", { p_email: email });
  if (lErr) return json({ error: "account lookup: " + lErr.message }, 500);

  if (found) {
    uid = found as string;
  } else {
    const { data: made, error: cuErr } = await db.auth.admin.createUser({
      email,
      email_confirm: false,          // signing in with the code is what confirms them
      user_metadata: { invited_as: client.display_name ?? null },
    });
    if (cuErr) {
      if (/already|exists|registered/i.test(cuErr.message)) {
        const { data: again } = await db.rpc("auth_user_id_by_email", { p_email: email });
        uid = (again as string | null) ?? null;
      } else {
        return json({ error: "account create: " + cuErr.message }, 500);
      }
    } else {
      account = "created";
      uid = made?.user?.id ?? null;
      // createUser writes a bcrypt hash even with no password supplied. The app never uses
      // passwords; strip it so that property does not erode one client at a time.
      if (uid) {
        const { error: pwErr } = await db.rpc("auth_clear_password", { p_user_id: uid });
        if (pwErr) return json({ error: "account create: password strip failed: " + pwErr.message }, 500);
      }
    }
  }
  if (!uid) return json({ error: "The account exists but its id could not be read. Nothing was handed out." }, 500);

  // ── Link the client row to this account on the coach's authority (see header) ──────
  let linked: "linked" | "already" = "already";
  if (client.client_user_id !== uid) {
    if (client.client_user_id) {
      return json({
        error: "This client record is already attached to a different sign-in account than this email. " +
          "Fix the email on the record, or the account, before handing out a code.",
      }, 409);
    }
    const { data: owner, error: oErr } = await db.from("clients")
      .select("id").eq("client_user_id", uid).neq("id", client.id).maybeSingle();
    if (oErr) return json({ error: "link check: " + oErr.message }, 500);
    if (owner) {
      return json({
        error: "That email's sign-in account already belongs to a different client record. Nothing was changed.",
        other_client: owner.id,
      }, 409);
    }
    const { error: uErr } = await db.from("clients")
      .update({ client_user_id: uid, status: "active", updated_at: new Date().toISOString() })
      .eq("id", client.id).eq("tenant_id", prof.tenant_id);
    if (uErr) return json({ error: "link: " + uErr.message }, 500);
    linked = "linked";
  }

  // ── Profile: what the app actually reads to route a signed-in user (see header) ─────
  const { data: existingProf, error: pErr } = await db.from("profiles")
    .select("role, tenant_id").eq("user_id", uid).maybeSingle();
  if (pErr) return json({ error: "profile lookup: " + pErr.message, linked }, 500);
  let profile: "created" | "existed" = "existed";
  if (!existingProf) {
    const { error: piErr } = await db.from("profiles")
      .insert({ user_id: uid, role: "client", tenant_id: client.tenant_id });
    if (piErr && !/duplicate|unique/i.test(piErr.message)) {
      return json({ error: "profile: " + piErr.message, linked }, 500);
    }
    profile = "created";
  } else if (existingProf.role !== "client") {
    return json({
      error: "That email's account is a " + existingProf.role + " account, not a client. " +
        "A coach cannot be signed in as a client with this code. Nothing was handed out.",
      linked,
    }, 409);
  }

  // ── The code. The same one the email would have carried. ───────────────────────────
  const { data: link, error: gErr } = await db.auth.admin.generateLink({ type: "magiclink", email });
  if (gErr) return json({ error: "code: " + gErr.message, linked }, 500);
  const code = link?.properties?.email_otp;
  if (!code) return json({ error: "Auth returned no code. Nothing was handed out.", linked }, 500);

  // ── Audit ───────────────────────────────────────────────────────────────────────────
  const { error: logErr } = await db.from("notification_log").insert({
    tenant_id: client.tenant_id,
    client_id: client.id,
    channel: "in_app",
    template: "coach_signin_code",
    status: "issued",
    consent_snapshot: { issued_by: userId, account, linked, profile },
  });

  return json({
    code,
    email: maskEmail(email),
    account,
    linked,
    profile,
    audit_logged: !logErr,
    audit_error: logErr?.message ?? null,
  });
});
