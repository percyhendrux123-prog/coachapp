-- Who may call which database function (EXECUTE grants).
--
-- On a real Supabase project every function created in the public schema is executable by
-- anon and authenticated through default privileges, unless a migration takes that back.
-- The initial schema was rebuilt on plain Postgres, where those default grants do not exist,
-- so its "REVOKE ... FROM PUBLIC" lines looked sufficient there and are not on Supabase.
-- Measured on a fresh Supabase stack before this file: 30 callable SECURITY DEFINER functions
-- (25 beyond the five policy helpers kept below) were
-- callable with only the public anon key, among them
--   link_client_by_email(user_id, email)  -> attach ANY unclaimed client row to any account
--   auth_user_id_by_email(email)          -> look up anyone's account id by email
--   auth_clear_password(user_id)          -> write auth.users
--   schedule_client_checkins(client_id)   -> its owner check treats "no user" as the server
--   provision_coach(app_name, name)       -> any signed-in user (with sign-ups on, any stranger)
--                                            makes themselves a coach with a new tenant
--   accept_invite(token)                  -> legacy claim with no confirmed-email check
-- The original project allowed only seven SECURITY DEFINER functions to anon, and closed the
-- helpers in step 2 to authenticated as well; this file restores that.
--
-- 1. anon keeps EXECUTE only on the SECURITY DEFINER functions RLS policies and the signed-out
--    screens need. Everything else is revoked from PUBLIC and anon; authenticated keeps
--    whatever it had (re-granted explicitly, because revoking PUBLIC can remove it).
-- 2. Server-only helpers lose authenticated too. Only the service role (edge functions) and
--    the auth trigger call them.
-- 3. A new function added later gets Supabase's default grants again. Re-run the block in
--    step 1 (or write the revoke in that migration) when adding a SECURITY DEFINER function.
do $$
declare
  r record;
  keep_anon constant text[] := array[
    'current_app_role', 'current_client_id', 'current_tenant_id', 'get_app_config',
    'tenant_is_suspended'
  ];
  had_auth boolean;
begin
  for r in
    select p.oid, p.oid::regprocedure as sig, p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
       and p.prorettype <> 'trigger'::regtype
       and not (p.proname = any (keep_anon))
  loop
    had_auth := has_function_privilege('authenticated', r.oid, 'execute');
    execute format('revoke execute on function %s from public, anon', r.sig);
    if had_auth then
      execute format('grant execute on function %s to authenticated', r.sig);
    end if;
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;

revoke execute on function public.link_client_by_email(uuid, text)      from public, anon, authenticated;
revoke execute on function public.auth_user_id_by_email(text)            from public, anon, authenticated;
revoke execute on function public.auth_clear_password(uuid)              from public, anon, authenticated;
revoke execute on function public.custom_access_token_hook(jsonb)        from public, anon, authenticated;
revoke execute on function public.onboarding_add_blocker(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.onboarding_clear_blockers(uuid, text[])        from public, anon, authenticated;
revoke execute on function public.onboarding_recompute_stage(uuid)               from public, anon, authenticated;
revoke execute on function public.publish_program_draft(uuid)            from public, anon, authenticated;
revoke execute on function public.provision_coach(text, text)            from public, anon, authenticated;
revoke execute on function public.accept_invite(text)                    from public, anon, authenticated;
revoke execute on function public.assert_coach_owns_client(uuid)         from public, anon, authenticated;

grant execute on function public.link_client_by_email(uuid, text)  to service_role;
grant execute on function public.auth_user_id_by_email(text)        to service_role;
grant execute on function public.auth_clear_password(uuid)          to service_role;
grant execute on function public.custom_access_token_hook(jsonb)    to service_role, supabase_auth_admin;
grant execute on function public.onboarding_add_blocker(uuid, text, text, text) to service_role;
grant execute on function public.onboarding_clear_blockers(uuid, text[])        to service_role;
grant execute on function public.onboarding_recompute_stage(uuid)               to service_role;
grant execute on function public.publish_program_draft(uuid)        to service_role;
grant execute on function public.provision_coach(text, text)        to service_role;
grant execute on function public.accept_invite(text)                to service_role;
grant execute on function public.assert_coach_owns_client(uuid)     to service_role;
