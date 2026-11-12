-- Slice 2 reminder selection tests. the original design notes (not included) §2.
--
-- Runs entirely inside ONE transaction and ends with ROLLBACK: fixture rows (a tenant, four
-- clients, an auth user) are created, every assertion runs, nothing persists. Run against a
-- database that has 20260907100000_onboarding_reminders.sql applied — on the platform owner's word, in the
-- SQL editor or `supabase db query --linked -f`. Each `TEST FAILED` raise stops the script and
-- the transaction still rolls back. A clean run prints one NOTICE per passed test.
begin;

create temp table fx (k text primary key, v uuid) on commit drop;
insert into fx values
  ('tenant', gen_random_uuid()), ('coach', gen_random_uuid()),
  ('a', gen_random_uuid()),   -- intake pending
  ('b', gen_random_uuid()),   -- invite pending
  ('c', gen_random_uuid()),   -- claimed, never opened
  ('d', gen_random_uuid()),   -- coach owes: nutrition draft without macros
  ('cuser', gen_random_uuid()),
  ('prog', gen_random_uuid()),
  ('form_a', gen_random_uuid());

insert into public.tenants (id, slug) values ((select v from fx where k='tenant'), 'reminder-test');
insert into public.tenant_config (tenant_id, mode) values ((select v from fx where k='tenant'), 'coached')
  on conflict (tenant_id) do nothing;
insert into public.programs (id, tenant_id, name) values ((select v from fx where k='prog'), (select v from fx where k='tenant'), 'Reminder Test Program');

-- All four clients joined a while ago so nothing is "fresh" by accident.
insert into public.clients (id, tenant_id, display_name, email, status, joined_at, updated_at) values
  ((select v from fx where k='a'), (select v from fx where k='tenant'), 'Alpha Intake',  'alpha@example.test', 'invited', now() - interval '20 days', now() - interval '20 days'),
  ((select v from fx where k='b'), (select v from fx where k='tenant'), 'Bravo Invite',  'bravo@example.test', 'invited', now() - interval '20 days', now() - interval '20 days'),
  ((select v from fx where k='c'), (select v from fx where k='tenant'), 'Charlie Open',  'charlie@example.test', 'active', now() - interval '20 days', now() - interval '20 days'),
  ((select v from fx where k='d'), (select v from fx where k='tenant'), 'Delta Owed',    'delta@example.test', 'active', now() - interval '20 days', now() - interval '20 days');

create or replace function pg_temp.due_for(p_client uuid, p_template text)
returns table (threshold_day int, ref text, link_path text, switch_on boolean, sender_email text, push_ok boolean, days_since int)
language sql as $$
  select d.threshold_day, d.ref, d.link_path, d.switch_on, d.sender_email, d.push_ok, d.days_since
    from public.onboarding_reminders_due() d where d.client_id = p_client and d.template = p_template
$$;

-- ---------- 1. intake sent 4 days ago, switches off, no sender → due at day 3, marked off/no-sender ----------
insert into public.intake_forms (id, tenant_id, client_id, token, status, created_at, expires_at)
  values ((select v from fx where k='form_a'), (select v from fx where k='tenant'), (select v from fx where k='a'),
          'tok-alpha', 'pending', now() - interval '4 days', now() + interval '10 days');
do $$ declare r record; begin
  select * into r from pg_temp.due_for((select v from fx where k='a'), 'intake_reminder');
  if r is null then raise exception 'TEST FAILED: intake day-3 candidate missing'; end if;
  if r.threshold_day <> 3 then raise exception 'TEST FAILED: expected threshold 3 got %', r.threshold_day; end if;
  if r.ref <> (select v from fx where k='form_a')::text then raise exception 'TEST FAILED: ref should be the intake form id'; end if;
  if r.link_path <> '/intake?token=tok-alpha' then raise exception 'TEST FAILED: link %', r.link_path; end if;
  if r.switch_on then raise exception 'TEST FAILED: switch defaults OFF'; end if;
  if r.sender_email is not null then raise exception 'TEST FAILED: sender defaults NULL'; end if;
  raise notice 'ok — intake day 3 due, switch off, no sender (days_since %)', r.days_since;
end $$;

-- ---------- 2. switch on + sender set → the same candidate now says so ----------
update public.tenant_config set sender_email = 'coach@reminder.test',
  onboarding_reminders = '{"intake": true, "invite": false, "first_open": false, "coach_digest": false}'::jsonb
  where tenant_id = (select v from fx where k='tenant');
do $$ declare r record; begin
  select * into r from pg_temp.due_for((select v from fx where k='a'), 'intake_reminder');
  if not r.switch_on or r.sender_email <> 'coach@reminder.test' then raise exception 'TEST FAILED: switch/sender not reflected %', r; end if;
  raise notice 'ok — switch on and sender flow through';
end $$;

-- ---------- 3. a SENT row for (client, template, day 3, this form) removes the candidate ----------
insert into public.notification_log (tenant_id, client_id, channel, template, status, consent_snapshot)
  values ((select v from fx where k='tenant'), (select v from fx where k='a'), 'in_app', 'intake_reminder', 'sent',
          jsonb_build_object('threshold_day', '3', 'ref', (select v from fx where k='form_a')::text));
do $$ begin
  if exists (select 1 from pg_temp.due_for((select v from fx where k='a'), 'intake_reminder')) then
    raise exception 'TEST FAILED: day-3 reminder offered twice';
  end if;
  raise notice 'ok — sent once, not offered again';
end $$;

-- ---------- 4. the unique index refuses a second SENT row for the same step ----------
do $$ begin
  begin
    insert into public.notification_log (tenant_id, client_id, channel, template, status, consent_snapshot)
      values ((select v from fx where k='tenant'), (select v from fx where k='a'), 'in_app', 'intake_reminder', 'sent',
              jsonb_build_object('threshold_day', '3', 'ref', (select v from fx where k='form_a')::text));
    raise exception 'TEST FAILED: duplicate sent row was accepted';
  exception when unique_violation then
    raise notice 'ok — duplicate sent row refused by the index';
  end;
end $$;

-- ---------- 5. at 11 days the day-10 reminder is due (a new step, not deduped by day 3) ----------
update public.intake_forms set created_at = now() - interval '11 days' where id = (select v from fx where k='form_a');
do $$ declare r record; begin
  select * into r from pg_temp.due_for((select v from fx where k='a'), 'intake_reminder');
  if r is null or r.threshold_day <> 10 then raise exception 'TEST FAILED: expected day-10 candidate, got %', r; end if;
  raise notice 'ok — day 10 due at 11 days';
end $$;

-- ---------- 6. at 13 days nothing fires ("four days left" would be a lie; coach resends at 14) ----------
update public.intake_forms set created_at = now() - interval '13 days' where id = (select v from fx where k='form_a');
do $$ begin
  if exists (select 1 from pg_temp.due_for((select v from fx where k='a'), 'intake_reminder')) then
    raise exception 'TEST FAILED: reminder offered at day 13';
  end if;
  raise notice 'ok — nothing at day 13';
end $$;

-- ---------- 7. a NEW intake token restarts the clock and is a new ref ----------
insert into public.intake_forms (id, tenant_id, client_id, token, status, created_at, expires_at)
  values (gen_random_uuid(), (select v from fx where k='tenant'), (select v from fx where k='a'),
          'tok-alpha-2', 'pending', now() - interval '3 days', now() + interval '11 days');
do $$ declare r record; begin
  select * into r from pg_temp.due_for((select v from fx where k='a'), 'intake_reminder');
  if r is null or r.threshold_day <> 3 or r.link_path <> '/intake?token=tok-alpha-2' then raise exception 'TEST FAILED: new token not offered at day 3: %', r; end if;
  raise notice 'ok — resent intake restarts at day 3 with the new token';
end $$;

-- ---------- 8. submitted → nothing; paused → nothing ----------
update public.intake_forms set status = 'submitted', submitted_at = now() where client_id = (select v from fx where k='a');
do $$ begin
  if exists (select 1 from pg_temp.due_for((select v from fx where k='a'), 'intake_reminder')) then raise exception 'TEST FAILED: submitted intake still reminded'; end if;
  raise notice 'ok — submitted intake is silent';
end $$;

-- ---------- 9. invite pending (expires in 10 days = sent 4 days ago), program + nutrition live ----------
insert into public.assignments (id, tenant_id, client_id, program_id, assigned_at, active, current_day_index, updated_at)
  values (gen_random_uuid(), (select v from fx where k='tenant'), (select v from fx where k='b'), (select v from fx where k='prog'), now() - interval '6 days', true, 0, now() - interval '6 days');
-- Nutrition live via the legacy table with everything its release gate demands (macros + a
-- meal); an assigned structured plan needs published meals in slots, which is more fixture
-- than this test is about.
insert into public.meal_plans (id, tenant_id, client_id, status, calories, protein_g, fat_g, carb_g, meals, assigned_at, created_at, updated_at)
  values (gen_random_uuid(), (select v from fx where k='tenant'), (select v from fx where k='b'), 'assigned', 2200, 180, 70, 200, '[{"name":"Meal 1"}]'::jsonb, now() - interval '6 days', now() - interval '6 days', now() - interval '6 days');
update public.clients set invite_token = 'inv-bravo', invite_expires_at = now() + interval '10 days' where id = (select v from fx where k='b');
do $$ declare r record; begin
  select * into r from pg_temp.due_for((select v from fx where k='b'), 'invite_reminder');
  if r is null then raise exception 'TEST FAILED: invite candidate missing'; end if;
  if r.threshold_day <> 3 or r.link_path <> '/claim?token=inv-bravo' or r.ref <> md5('inv-bravo') then raise exception 'TEST FAILED: invite candidate wrong %', r; end if;
  if r.switch_on then raise exception 'TEST FAILED: invite switch is off in this fixture'; end if;
  raise notice 'ok — invite day 3 due, keyed by token hash, invite switch off';
end $$;

-- ---------- 10. claimed 3 days ago, never opened → first_open day 2; push only when subscribed ----------
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, last_sign_in_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values ((select v from fx where k='cuser'), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'charlie@example.test',
          now() - interval '3 days', now() - interval '3 days', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now() - interval '20 days', now() - interval '3 days');
insert into public.assignments (id, tenant_id, client_id, program_id, assigned_at, active, current_day_index, updated_at)
  values (gen_random_uuid(), (select v from fx where k='tenant'), (select v from fx where k='c'), (select v from fx where k='prog'), now() - interval '6 days', true, 0, now() - interval '6 days');
insert into public.meal_plans (id, tenant_id, client_id, status, calories, protein_g, fat_g, carb_g, meals, assigned_at, created_at, updated_at)
  values (gen_random_uuid(), (select v from fx where k='tenant'), (select v from fx where k='c'), 'assigned', 2200, 180, 70, 200, '[{"name":"Meal 1"}]'::jsonb, now() - interval '6 days', now() - interval '6 days', now() - interval '6 days');
update public.clients set client_user_id = (select v from fx where k='cuser'), welcome_seen = false, updated_at = now() - interval '3 days'
  where id = (select v from fx where k='c');
do $$ declare r record; begin
  select * into r from pg_temp.due_for((select v from fx where k='c'), 'first_open_reminder');
  if r is null then raise exception 'TEST FAILED: first_open candidate missing'; end if;
  if r.threshold_day <> 2 or r.ref <> (select v from fx where k='cuser')::text or r.link_path <> '/client' then raise exception 'TEST FAILED: first_open wrong %', r; end if;
  if r.push_ok then raise exception 'TEST FAILED: push_ok without a subscription'; end if;
  raise notice 'ok — first_open day 2 due (days_since %), no push', r.days_since;
end $$;
update public.clients set notif_enabled = true, notif_channels = '{"push": true}'::jsonb, push_subscription = '{"endpoint":"https://push.test/x"}'::jsonb
  where id = (select v from fx where k='c');
do $$ declare r record; begin
  select * into r from pg_temp.due_for((select v from fx where k='c'), 'first_open_reminder');
  if not r.push_ok then raise exception 'TEST FAILED: push_ok should be true with consent + subscription'; end if;
  raise notice 'ok — push_ok with consent and a subscription';
end $$;
update public.clients set welcome_seen = true where id = (select v from fx where k='c');
do $$ begin
  if exists (select 1 from pg_temp.due_for((select v from fx where k='c'), 'first_open_reminder')) then raise exception 'TEST FAILED: opened app still reminded'; end if;
  raise notice 'ok — opened app is silent';
end $$;

-- ---------- 11. paused client is never a candidate ----------
update public.clients set status = 'paused' where id = (select v from fx where k='b');
do $$ begin
  if exists (select 1 from pg_temp.due_for((select v from fx where k='b'), 'invite_reminder')) then raise exception 'TEST FAILED: paused client reminded'; end if;
  raise notice 'ok — paused client excluded';
end $$;

-- ---------- 12. coach digest: nutrition draft without macros, 5 days stalled ----------
insert into public.assignments (id, tenant_id, client_id, program_id, assigned_at, active, current_day_index, updated_at)
  values (gen_random_uuid(), (select v from fx where k='tenant'), (select v from fx where k='d'), (select v from fx where k='prog'), now() - interval '5 days', true, 0, now() - interval '5 days');
insert into public.client_meal_plans (id, tenant_id, client_id, status, created_at, updated_at)
  values (gen_random_uuid(), (select v from fx where k='tenant'), (select v from fx where k='d'), 'draft', now() - interval '5 days', now() - interval '5 days');
do $$ declare d jsonb; begin
  d := public.onboarding_coach_digest((select v from fx where k='tenant'));
  if (d->>'owed')::int < 1 then raise exception 'TEST FAILED: nothing owed %', d; end if;
  if not exists (select 1 from jsonb_array_elements(d->'buckets') b where b->>'key' = 'drafts_without_macros' and (b->>'n')::int = 1) then
    raise exception 'TEST FAILED: drafts_without_macros bucket missing %', d; end if;
  if d->'longest'->>'display_name' <> 'Delta Owed' or (d->'longest'->>'days')::int < 3 then raise exception 'TEST FAILED: longest %', d->'longest'; end if;
  if (d->>'switch_on')::boolean then raise exception 'TEST FAILED: coach_digest switch should be off'; end if;
  raise notice 'ok — coach digest: %', d;
end $$;
-- macros filled → same client moves to ready_to_release
update public.client_meal_plans set target_calories = 2200, target_protein_g = 180, target_fat_g = 70, target_carb_g = 200
  where client_id = (select v from fx where k='d');
do $$ declare d jsonb; begin
  d := public.onboarding_coach_digest((select v from fx where k='tenant'));
  if not exists (select 1 from jsonb_array_elements(d->'buckets') b where b->>'key' = 'ready_to_release') then raise exception 'TEST FAILED: ready_to_release missing %', d; end if;
  if exists (select 1 from jsonb_array_elements(d->'buckets') b where b->>'key' = 'drafts_without_macros') then raise exception 'TEST FAILED: still counted as without macros %', d; end if;
  raise notice 'ok — macros filled moves the client to ready_to_release';
end $$;

-- ---------- 13. guards: a coach may read status + own digest, may NOT read the cross-tenant selection ----------
select set_config('request.jwt.claims',
  json_build_object('sub', (select v from fx where k='coach'), 'role', 'authenticated', 'user_role', 'coach',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);
do $$ declare s jsonb; begin
  s := public.onboarding_reminder_status();
  if s->>'sender_email' <> 'coach@reminder.test' or not (s->'switches'->>'intake')::boolean or not (s->>'any_on')::boolean then
    raise exception 'TEST FAILED: status %', s; end if;
  raise notice 'ok — coach reads status: sender %, any_on %', s->>'sender_email', s->>'any_on';
  perform public.onboarding_coach_digest((select v from fx where k='tenant'));
  raise notice 'ok — coach reads own digest';
  begin
    perform public.onboarding_coach_digest(gen_random_uuid());
    raise exception 'TEST FAILED: coach read another tenant''s digest';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    raise notice 'ok — other tenant digest refused: %', sqlerrm;
  end;
  begin
    perform public.onboarding_reminders_due();
    raise exception 'TEST FAILED: coach read the cross-tenant selection';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    raise notice 'ok — selection refused to a coach session: %', sqlerrm;
  end;
end $$;
select set_config('request.jwt.claims',
  json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'user_role', 'client',
                    'tenant_id', (select v from fx where k='tenant'))::text, true);
do $$ begin
  begin
    perform public.onboarding_reminder_status();
    raise exception 'TEST FAILED: client read reminder status';
  exception when others then
    if sqlerrm like 'TEST FAILED%' then raise; end if;
    raise notice 'ok — client refused status: %', sqlerrm;
  end;
end $$;

do $$ begin raise notice 'ALL REMINDER TESTS PASSED (rolling back)'; end $$;
rollback;
