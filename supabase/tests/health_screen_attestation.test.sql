-- P33: the self-serve health path. A flagged screen on the self-serve plan is confirmed only by
-- the signed-in person, only for doctor-first flags, and never counts for a coached release.
-- Run against a database with every migration applied (local stack or a throwaway project).
-- ONE transaction, ends with ROLLBACK: nothing persists. Impersonates callers by setting the
-- JWT claims GUC the way PostgREST does. A clean run prints one NOTICE per passed test
-- ('ok 1' .. 'ok 20', with lettered sub-tests); any 'TEST FAILED' raise stops the script.
begin;

create temp table fx (k text primary key, v uuid) on commit drop;
insert into fx values ('ss', gen_random_uuid()), ('coached', gen_random_uuid()), ('coach', gen_random_uuid()),
  ('u1', gen_random_uuid()), ('u2', gen_random_uuid()), ('u3', gen_random_uuid()),
  ('c1', gen_random_uuid()), ('c2', gen_random_uuid()), ('c3', gen_random_uuid()),
  ('i1', gen_random_uuid()), ('i1old', gen_random_uuid()), ('i2', gen_random_uuid()), ('i3', gen_random_uuid()),
  ('preg', gen_random_uuid()), ('cpreg', gen_random_uuid()), ('upreg', gen_random_uuid()),
  ('unk', gen_random_uuid()), ('cunk', gen_random_uuid()), ('uunk', gen_random_uuid());
grant select on fx to authenticated, anon;

insert into auth.users (id, email)
select v, k || '-p33@example.invalid' from fx where k in ('u1', 'u2', 'u3', 'upreg', 'uunk', 'coach');

insert into public.tenants (id, slug) values ((select v from fx where k='ss'), 'p33-selfserve'), ((select v from fx where k='coached'), 'p33-coached');
insert into public.tenant_config (tenant_id, mode) values ((select v from fx where k='ss'), 'self_serve')
  on conflict (tenant_id) do update set mode = 'self_serve';
insert into public.tenant_config (tenant_id, mode) values ((select v from fx where k='coached'), 'coached')
  on conflict (tenant_id) do update set mode = 'coached';

-- c1: self-serve, doctor-first (chest pain + a listed medication). Two submitted screens; i1 is latest.
-- c2: self-serve, a second person (another client's intake).
-- c3: coached tenant client with a flagged screen.
-- cpreg: self-serve, pregnancy. cunk: self-serve, an unknown flag id.
insert into public.clients (id, tenant_id, display_name, email, status, client_user_id) values
  ((select v from fx where k='c1'), (select v from fx where k='ss'), 'P33 One', 'p33-one@example.invalid', 'invited', (select v from fx where k='u1')),
  ((select v from fx where k='c2'), (select v from fx where k='ss'), 'P33 Two', 'p33-two@example.invalid', 'invited', (select v from fx where k='u2')),
  ((select v from fx where k='c3'), (select v from fx where k='coached'), 'P33 Three', 'p33-three@example.invalid', 'invited', (select v from fx where k='u3')),
  ((select v from fx where k='cpreg'), (select v from fx where k='ss'), 'P33 Preg', 'p33-preg@example.invalid', 'invited', (select v from fx where k='upreg')),
  ((select v from fx where k='cunk'), (select v from fx where k='ss'), 'P33 Unk', 'p33-unk@example.invalid', 'invited', (select v from fx where k='uunk'));
insert into public.intake_forms (id, tenant_id, client_id, token, status, submitted_at, health_flags) values
  ((select v from fx where k='i1old'), (select v from fx where k='ss'), (select v from fx where k='c1'), 'p33-t0', 'submitted', now() - interval '2 hours', '["parq_dizziness"]'),
  ((select v from fx where k='i1'), (select v from fx where k='ss'), (select v from fx where k='c1'), 'p33-t1', 'submitted', now() - interval '1 hour', '["parq_chest_pain","medication_disclosed"]'),
  ((select v from fx where k='i2'), (select v from fx where k='ss'), (select v from fx where k='c2'), 'p33-t2', 'submitted', now() - interval '1 hour', '["parq_chest_pain"]'),
  ((select v from fx where k='i3'), (select v from fx where k='coached'), (select v from fx where k='c3'), 'p33-t3', 'submitted', now() - interval '1 hour', '["parq_heart_condition"]'),
  ((select v from fx where k='preg'), (select v from fx where k='ss'), (select v from fx where k='cpreg'), 'p33-tp', 'submitted', now() - interval '1 hour', '["parq_chest_pain","pregnancy"]'),
  ((select v from fx where k='unk'), (select v from fx where k='ss'), (select v from fx where k='cunk'), 'p33-tu', 'submitted', now() - interval '1 hour', '["parq_brand_new_question"]');

create or replace function pg_temp.expect_error(p_sql text, p_like text, p_label text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'TEST FAILED (%): expected an error like %, got success', p_label, p_like;
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    if sqlerrm not like p_like then raise exception 'TEST FAILED (%): expected %, got %', p_label, p_like, sqlerrm; end if;
    raise notice 'ok % refused: %', p_label, sqlerrm;
  end;
end $$;
create or replace function pg_temp.as_client(p_user uuid, p_tenant uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'user_role', 'client', 'tenant_id', p_tenant)::text, true);
$$;
create or replace function pg_temp.attest_sql(p_intake uuid, p_flags text, p_version text, p_name text) returns text language sql as $$
  select format('select public.attest_my_health_screen(%L, %L::jsonb, %L, %L)', p_intake, p_flags, p_version, p_name);
$$;

-- 1. the flag table: the SQL literal lists equal the TS/JS twins (healthHold.parity.test.ts).
do $$ begin
  if public.self_serve_doctor_first_flags() is distinct from array['parq_heart_condition', 'parq_chest_pain', 'parq_dizziness',
       'parq_bone_joint_worsened_by_activity', 'parq_bp_or_heart_medication', 'parq_other_reason_not_to_exercise', 'medication_disclosed']::text[]
     or public.self_serve_blocking_flags() is distinct from array['pregnancy', 'eating_disorder_history']::text[]
     or public.health_statement_version() <> '2026-11-14.1'
     or public.health_statement_text('2026-11-14.1') not like 'I talked to a doctor%nobody reviewed my answers.' then
    raise exception 'TEST FAILED 1: flag table or statement drifted from the TS twin';
  end if;
  raise notice 'ok 1 - flag table and statement match the TS/JS twins';
end $$;

-- 2. anon cannot execute it at all.
set local role anon;
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', '2026-11-14.1', 'Test Person'), 'permission denied%', '2 anon');
select pg_temp.expect_error('select public.my_health_hold()', 'permission denied%', '2b anon hold read');
reset role;

-- 3. a coach (even of the same tenant) cannot confirm a person's screen.
select set_config('request.jwt.claims', json_build_object('sub', (select v from fx where k='coach'), 'role', 'authenticated', 'user_role', 'coach', 'tenant_id', (select v from fx where k='ss'))::text, true);
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', '2026-11-14.1', 'Test Person'), 'not authorized: only the person%', '3 coach role');

-- 4. a client in a coached tenant: refused (the coach reviews there).
select pg_temp.as_client((select v from fx where k='u3'), (select v from fx where k='coached'));
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i3'), '["parq_heart_condition"]', '2026-11-14.1', 'Test Person'), 'refused: this confirmation is only for the self-serve plan%', '4 coached tenant');

-- 5. another client's intake.
select pg_temp.as_client((select v from fx where k='u2'), (select v from fx where k='ss'));
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', '2026-11-14.1', 'Test Person'), 'not authorized: this health screen is not yours%', '5 another client');

-- 6-10 as the person themself (c1).
select pg_temp.as_client((select v from fx where k='u1'), (select v from fx where k='ss'));
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1old'), '["parq_dizziness"]', '2026-11-14.1', 'Test Person'), 'refused: a newer health screen exists%', '6 not the latest intake');
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1'), '["parq_chest_pain"]', '2026-11-14.1', 'Test Person'), 'refused: your health screen changed%', '7 stale flags');
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1'), '["medication_disclosed","parq_chest_pain"]', '2026-11-14.1', 'Test Person'), 'refused: your health screen changed%', '7b reordered flags are not the flags shown');
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', '2026-01-01.0', 'Test Person'), 'refused: the confirmation text changed%', '8 wrong statement version');
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', null, 'Test Person'), 'refused: the confirmation text changed%', '8b null version');
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', '2026-11-14.1', '   '), 'refused: type your full name%', '9 blank name');
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', '2026-11-14.1', E'\t\u00a0\u2003 '), 'refused: type your full name%', '9b whitespace-only name');
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', '2026-11-14.1', 'X'), 'refused: type your full name%', '9c one character');
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', '2026-11-14.1', repeat('x', 121)), 'refused: type your full name%', '9d too long');

-- 10. blocking and unknown flags are refused whatever is confirmed.
select pg_temp.as_client((select v from fx where k='upreg'), (select v from fx where k='ss'));
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='preg'), '["parq_chest_pain","pregnancy"]', '2026-11-14.1', 'Test Person'), 'refused: this plan is not built%', '10 blocking flag');
select pg_temp.as_client((select v from fx where k='uunk'), (select v from fx where k='ss'));
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='unk'), '["parq_brand_new_question"]', '2026-11-14.1', 'Test Person'), 'refused: this plan is not built%', '10b unknown flag');

-- 11. my_health_hold for each: doctor-first, blocked (pregnancy), blocked (unknown).
do $$ declare h jsonb; begin
  perform pg_temp.as_client((select v from fx where k='uunk'), (select v from fx where k='ss'));
  h := public.my_health_hold();
  if h->>'state' <> 'blocked' or h->>'reason' <> 'other' then raise exception 'TEST FAILED 11a: %', h; end if;
  perform pg_temp.as_client((select v from fx where k='upreg'), (select v from fx where k='ss'));
  h := public.my_health_hold();
  if h->>'state' <> 'blocked' or h->>'reason' <> 'pregnancy' or h ? 'flags' then raise exception 'TEST FAILED 11b: %', h; end if;
  perform pg_temp.as_client((select v from fx where k='u1'), (select v from fx where k='ss'));
  h := public.my_health_hold();
  if h->>'state' <> 'needs_clearance' or h->'flags' <> '["parq_chest_pain","medication_disclosed"]'::jsonb
     or (h->>'has_live_plan')::boolean or h->>'statement_version' <> '2026-11-14.1' then
    raise exception 'TEST FAILED 11c: %', h; end if;
  raise notice 'ok 11 - my_health_hold: needs_clearance, blocked (pregnancy), blocked (unknown, fail closed)';
end $$;

-- 12. accepted once (name trimmed, statement stored from the version); a second identical call returns the same row.
do $$ declare a jsonb; b jsonb; n int; r public.health_screen_attestations%rowtype; begin
  perform pg_temp.as_client((select v from fx where k='u1'), (select v from fx where k='ss'));
  a := public.attest_my_health_screen((select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', '2026-11-14.1', E'  Test Person\t');
  b := public.attest_my_health_screen((select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', '2026-11-14.1', 'Test Person');
  if a->>'status' <> 'attested' or a->>'attestation_id' is distinct from b->>'attestation_id' then raise exception 'TEST FAILED 12: % / %', a, b; end if;
  select count(*) into n from public.health_screen_attestations where intake_id = (select v from fx where k='i1');
  if n <> 1 then raise exception 'TEST FAILED 12: % rows', n; end if;
  select * into r from public.health_screen_attestations where intake_id = (select v from fx where k='i1');
  if r.typed_name <> 'Test Person' or r.attested_by <> (select v from fx where k='u1') or r.statement_text not like 'I talked to a doctor%' then
    raise exception 'TEST FAILED 12: stored row wrong'; end if;
  if public.my_health_hold()->>'state' <> 'building' then raise exception 'TEST FAILED 12: hold not building after confirmation'; end if;
  raise notice 'ok 12 - accepted once, idempotent, name trimmed, statement stored, hold reads building';
end $$;

-- 13. the table rejects direct writes from the browser role; the person reads only their own rows.
set local role authenticated;
select pg_temp.expect_error(format('insert into public.health_screen_attestations (tenant_id, client_id, intake_id, flags, statement_version, statement_text, typed_name, attested_by) values (%L, %L, %L, %L, %L, %L, %L, %L)',
  (select v from fx where k='ss'), (select v from fx where k='c1'), (select v from fx where k='i1'), '["parq_chest_pain"]', '2026-11-14.1', 'x', 'Test Person', (select v from fx where k='u1')), 'permission denied%', '13 direct insert');
select pg_temp.expect_error(format('update public.health_screen_attestations set typed_name = %L', 'Someone Else'), 'permission denied%', '13b direct update');
select pg_temp.expect_error('delete from public.health_screen_attestations', 'permission denied%', '13c direct delete');
select pg_temp.expect_error('select count(*) from public.health_clearance_builds', 'permission denied%', '13d build claims are server-only');
select pg_temp.expect_error('select count(*) from public.system_signup_attempts', 'permission denied%', '13e signup attempts are server-only');
do $$ begin
  if (select count(*) from public.health_screen_attestations) <> 1 then raise exception 'TEST FAILED 13f: own row not readable'; end if;
  perform pg_temp.as_client((select v from fx where k='u2'), (select v from fx where k='ss'));
  if (select count(*) from public.health_screen_attestations) <> 0 then raise exception 'TEST FAILED 13f: another person read the row'; end if;
  raise notice 'ok 13f - the person reads their own confirmation and nobody else does';
end $$;
reset role;

-- 14. a suspended tenant cannot confirm.
select pg_temp.as_client((select v from fx where k='u2'), (select v from fx where k='ss'));
update public.tenants set status = 'suspended' where id = (select v from fx where k='ss');
select pg_temp.expect_error(pg_temp.attest_sql((select v from fx where k='i2'), '["parq_chest_pain"]', '2026-11-14.1', 'Test Person'), 'This app is paused%', '14 suspended tenant');
update public.tenants set status = 'active' where id = (select v from fx where k='ss');

-- 15. an attestation (even one inserted by the service role) never satisfies a coached release.
insert into public.health_screen_attestations (tenant_id, client_id, intake_id, flags, statement_version, statement_text, typed_name, attested_by)
values ((select v from fx where k='coached'), (select v from fx where k='c3'), (select v from fx where k='i3'), '["parq_heart_condition"]', '2026-11-14.1', 'x', 'Test Person', (select v from fx where k='u3'));
select set_config('request.jwt.claims', json_build_object('sub', (select v from fx where k='coach'), 'role', 'authenticated', 'user_role', 'coach', 'tenant_id', (select v from fx where k='coached'))::text, true);
do $$ declare c jsonb; begin
  c := public.release_checklist((select v from fx where k='c3'));
  if c->'health'->>'state' <> 'flagged' then raise exception 'TEST FAILED 15: %', c->'health'; end if;
  raise notice 'ok 15 - an attestation leaves a coached checklist flagged';
end $$;

-- 16. review_health_screen still refuses a client caller.
select pg_temp.as_client((select v from fx where k='u1'), (select v from fx where k='ss'));
select pg_temp.expect_error(format('select public.review_health_screen(%L, %L::jsonb, %L)', (select v from fx where k='i1'), '["parq_chest_pain","medication_disclosed"]', 'I cleared myself'), 'not authorized: coach role required%', '16 client calls review_health_screen');

-- 17. the 28-day clock: right after a held submission a new token is allowed; after a built one, too_soon.
select pg_temp.as_client((select v from fx where k='u1'), (select v from fx where k='ss'));
do $$ begin
  if public.mint_my_intake_token() is null then raise exception 'TEST FAILED 17a: no token after a held submission'; end if;
  raise notice 'ok 17a - a held screen does not start the 28-day clock';
end $$;
-- Build from i1 (what system-clearance does), then ask again.
with p as (insert into public.programs (tenant_id, name, structure)
           values ((select v from fx where k='ss'), 'P33 Plan', '{"days":[{"kind":"training","exercises":[]}]}') returning id)
insert into public.program_drafts (tenant_id, client_id, intake_id, status, training, published_program_id)
select (select v from fx where k='ss'), (select v from fx where k='c1'), (select v from fx where k='i1'), 'published', '{"days":[{"kind":"training"}]}', p.id from p;
select pg_temp.expect_error('select public.mint_my_intake_token()', 'too_soon:%', '17b a built screen starts the clock');
do $$ begin
  if public.mint_intake_token_for_client((select v from fx where k='c2')) is null then raise exception 'TEST FAILED 17c'; end if;
  raise notice 'ok 17c - the service-role twin follows the same rule';
end $$;

-- 18. once a plan is built from the screen, the hold is gone.
do $$ declare h jsonb; begin
  perform pg_temp.as_client((select v from fx where k='u1'), (select v from fx where k='ss'));
  h := public.my_health_hold();
  if h->>'state' <> 'none' then raise exception 'TEST FAILED 18: %', h; end if;
  raise notice 'ok 18 - a built screen leaves no hold';
end $$;

-- 19. the owner list marks held people, and a held person is not a stuck delivery (read as the service role, as the digest does).
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$ declare r record; begin
  for r in select * from public.list_system_buyers() where client_id in (select v from fx where k in ('c2', 'cpreg', 'cunk', 'c1')) loop
    if r.client_id = (select v from fx where k='c2') and r.health_hold <> 'needs_clearance' then raise exception 'TEST FAILED 19: c2 %', r.health_hold; end if;
    if r.client_id in ((select v from fx where k='cpreg'), (select v from fx where k='cunk')) and r.health_hold <> 'blocked' then raise exception 'TEST FAILED 19: blocked %', r.health_hold; end if;
    if r.client_id = (select v from fx where k='c1') and r.health_hold <> 'none' then raise exception 'TEST FAILED 19: built %', r.health_hold; end if;
  end loop;
  raise notice 'ok 19 - list_system_buyers health_hold: needs_clearance, blocked, none once built';
end $$;

-- 20. grants: browser role may call only the two person-facing functions.
do $$ begin
  if not has_function_privilege('authenticated', 'public.attest_my_health_screen(uuid, jsonb, text, text)', 'execute')
     or not has_function_privilege('authenticated', 'public.my_health_hold()', 'execute')
     or has_function_privilege('anon', 'public.attest_my_health_screen(uuid, jsonb, text, text)', 'execute')
     or has_function_privilege('anon', 'public.my_health_hold()', 'execute')
     or has_function_privilege('anon', 'public.self_serve_doctor_first_flags()', 'execute')
     or has_function_privilege('anon', 'public.health_statement_text(text)', 'execute') then
    raise exception 'TEST FAILED 20: grants';
  end if;
  raise notice 'ok 20 - grants: authenticated only';
end $$;

rollback;
