-- Who may execute which database function. Run on a Supabase database (local stack or a
-- throwaway project) with every migration applied; plain Postgres has no anon/authenticated
-- default grants, so this test only means something on Supabase.
--
-- Read-only: it inspects privileges and calls one function as anon inside a rolled-back
-- transaction. A clean run prints one NOTICE per passed test.
begin;

do $$
declare n int; names text;
begin
  -- 1. anon may execute only these SECURITY DEFINER functions (plus trigger functions,
  --    which PostgREST cannot call).
  select count(*), string_agg(p.proname, ', ' order by p.proname) into n, names
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'public' and p.prosecdef and p.prokind = 'f'
     and p.prorettype <> 'trigger'::regtype
     and has_function_privilege('anon', p.oid, 'execute')
     and p.proname not in ('current_app_role', 'current_client_id', 'current_tenant_id',
                           'get_app_config', 'tenant_is_suspended');
  if n > 0 then raise exception 'TEST FAILED: anon can execute SECURITY DEFINER functions: %', names; end if;
  raise notice 'ok 1 - anon executes only the five policy/config helpers';

  -- 2. server-only helpers are closed to every browser role.
  select count(*), string_agg(p.oid::regprocedure::text || ' by ' || r, ', ') into n, names
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    cross join unnest(array['anon', 'authenticated']) r
   where s.nspname = 'public'
     and p.proname in ('link_client_by_email', 'auth_user_id_by_email', 'auth_clear_password',
                       'custom_access_token_hook', 'onboarding_add_blocker',
                       'onboarding_clear_blockers', 'onboarding_recompute_stage',
                       'publish_program_draft')
     and has_function_privilege(r, p.oid, 'execute');
  if n > 0 then raise exception 'TEST FAILED: browser role can execute server-only helper: %', names; end if;
  raise notice 'ok 2 - server-only helpers closed to anon and authenticated';

  -- 3. the service role still reaches them (edge functions depend on it).
  if not has_function_privilege('service_role', 'public.auth_user_id_by_email(text)', 'execute')
     or not has_function_privilege('service_role', 'public.auth_clear_password(uuid)', 'execute') then
    raise exception 'TEST FAILED: service_role lost a helper the edge functions call';
  end if;
  raise notice 'ok 3 - service_role keeps the edge-function helpers';

  -- 4. signed-in app paths still work: the RPCs the browser calls stay open to authenticated.
  select count(*), string_agg(f, ', ') into n, names
    from unnest(array['claim_client_invite', 'claim_my_client', 'create_coach_client',
                      'send_coach_message', 'mark_thread_read', 'release_client',
                      'release_checklist', 'rm_coach_overview', 'coach_inbox',
                      'approve_program_draft', 'adjust_my_schedule', 'mint_my_intake_token',
                      'confirm_client_body_metrics', 'set_brief_slide_order', 'get_app_config']) f
   where not exists (select 1 from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                      where s.nspname = 'public' and p.proname = f
                        and has_function_privilege('authenticated', p.oid, 'execute'));
  if n > 0 then raise exception 'TEST FAILED: authenticated lost app RPCs: %', names; end if;
  raise notice 'ok 4 - browser RPCs still open to authenticated';
end $$;

-- 5. the attack itself: anon calling link_client_by_email is refused.
set local role anon;
do $$
begin
  perform public.link_client_by_email(gen_random_uuid(), 'nobody@example.invalid');
  raise exception 'TEST FAILED: anon executed link_client_by_email';
exception when insufficient_privilege then
  raise notice 'ok 5 - anon refused on link_client_by_email';
end $$;
reset role;

rollback;
