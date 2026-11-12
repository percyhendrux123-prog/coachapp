-- Capacity trigger + coach runs RPC tests. Slice 3 H1/H3, migration 20260908120000.
-- ONE transaction, ends with ROLLBACK. Impersonates roles via the JWT-claims GUC like
-- PostgREST. Synthetic auth.users rows are created inside the transaction and vanish
-- with it. A `TEST FAILED` raise stops the script; a clean run prints one NOTICE per test.
begin;

create temp table fx (k text primary key, v uuid) on commit drop;
insert into fx values ('tenant', gen_random_uuid()), ('other_tenant', gen_random_uuid()), ('coach', gen_random_uuid()),
  ('ch', gen_random_uuid()), ('ch_open', gen_random_uuid()),
  ('u1', gen_random_uuid()), ('u2', gen_random_uuid()), ('u3', gen_random_uuid()), ('u4', gen_random_uuid());

insert into public.tenants (id, slug) values ((select v from fx where k='tenant'), 'capacity-test'), ((select v from fx where k='other_tenant'), 'capacity-other');
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  select v, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', k || '@synthetic.test', now(), now(), now(), '{}'::jsonb, '{}'::jsonb
    from fx where k in ('u1','u2','u3','u4');

insert into public.challenges (id, tenant_id, slug, title, max_entrants, status)
  values ((select v from fx where k='ch'), (select v from fx where k='tenant'), 'cap-3', 'Capacity 3', 3, 'published'),
         ((select v from fx where k='ch_open'), (select v from fx where k='tenant'), 'cap-none', 'No cap', null, 'published');

-- ---------- 1. three runs fit under a cap of 3 ----------
insert into public.challenge_runs (tenant_id, challenge_id, participant_user_id, status, started_at)
  select (select v from fx where k='tenant'), (select v from fx where k='ch'), v, 'active', now() from fx where k in ('u1','u2','u3');
do $$ begin
  if (select count(*) from public.challenge_runs where challenge_id = (select v from fx where k='ch')) <> 3 then
    raise exception 'TEST FAILED: expected 3 runs';
  end if;
  raise notice 'ok — 3 runs admitted under cap 3';
end $$;

-- ---------- 2. the fourth is refused with hint challenge_full ----------
do $$
declare v_hint text;
begin
  begin
    insert into public.challenge_runs (tenant_id, challenge_id, participant_user_id, status, started_at)
      values ((select v from fx where k='tenant'), (select v from fx where k='ch'), (select v from fx where k='u4'), 'active', now());
    raise exception 'TEST FAILED: fourth run was admitted';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    get stacked diagnostics v_hint = pg_exception_hint;
    if v_hint is distinct from 'challenge_full' then raise exception 'TEST FAILED: wrong error: % (hint %)', sqlerrm, v_hint; end if;
    raise notice 'ok — fourth refused: % / %', sqlerrm, v_hint;
  end;
end $$;

-- ---------- 3. no cap = no limit ----------
insert into public.challenge_runs (tenant_id, challenge_id, participant_user_id, status, started_at)
  select (select v from fx where k='tenant'), (select v from fx where k='ch_open'), v, 'active', now() from fx where k in ('u1','u2','u3','u4');
do $$ begin
  if (select count(*) from public.challenge_runs where challenge_id = (select v from fx where k='ch_open')) <> 4 then
    raise exception 'TEST FAILED: uncapped challenge limited';
  end if;
  raise notice 'ok — uncapped challenge admits all four';
end $$;

-- ---------- 4. the cap check constraint rejects 0 ----------
do $$ begin
  begin
    update public.challenges set max_entrants = 0 where id = (select v from fx where k='ch');
    raise exception 'TEST FAILED: max_entrants 0 accepted';
  exception when check_violation then raise notice 'ok — max_entrants 0 rejected';
  end;
end $$;

-- ---------- 5. coach RPC: own tenant returns runs with emails ----------
select set_config('request.jwt.claims',
  json_build_object('sub', (select v from fx where k='coach'), 'role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);
do $$
declare v_n int; v_email text;
begin
  select count(*), min(participant_email) into v_n, v_email from public.challenge_runs_for_coach((select v from fx where k='ch'));
  if v_n <> 3 or v_email not like '%@synthetic.test' then raise exception 'TEST FAILED: rpc returned % rows, email %', v_n, v_email; end if;
  raise notice 'ok — coach rpc: 3 runs with emails';
end $$;

-- ---------- 6. coach RPC: another tenant's coach sees nothing ----------
select set_config('request.jwt.claims',
  json_build_object('sub', (select v from fx where k='coach'), 'role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='other_tenant'))::text, true);
do $$ begin
  if (select count(*) from public.challenge_runs_for_coach((select v from fx where k='ch'))) <> 0 then
    raise exception 'TEST FAILED: cross-tenant leak';
  end if;
  raise notice 'ok — other tenant sees 0';
end $$;

-- ---------- 7. coach RPC: a client is refused ----------
select set_config('request.jwt.claims',
  json_build_object('sub', (select v from fx where k='u1'), 'role', 'authenticated', 'user_role', 'client',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);
do $$ begin
  begin
    perform * from public.challenge_runs_for_coach((select v from fx where k='ch'));
    raise exception 'TEST FAILED: client could call coach rpc';
  exception when insufficient_privilege then raise notice 'ok — client refused (42501)';
  end;
end $$;

rollback;
