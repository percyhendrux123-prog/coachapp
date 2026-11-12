-- publish_program_draft guard test. Runs as ONE transaction and ROLLS BACK (same method as
-- challenge_capacity.test.sql). Creates its own synthetic tenant; every row it inserts is
-- rolled back. Run from this folder: psql "$DATABASE_URL" -f publish_guard_live_coach_program.test.sql
-- Expected notices: 'ok 1' .. 'ok 4'. Any exception outside the expected block fails the run.
begin;

\ir ../migrations/20260920210000_publish_refuses_to_replace_coach_built_program.sql

do $t$
declare
  v_tenant   uuid;
  v_client   uuid;
  v_prog     uuid;
  v_draft    uuid;
  v_pub      uuid;
  v_days     jsonb := '[{"name":"Day 1","exercises":[{"name":"Incline DB Press","sets":3,"reps":"10"}]}]'::jsonb;
  v_msg      text;
begin
  insert into public.tenants (slug) values ('publish-guard-test') returning id into v_tenant;

  insert into public.clients (tenant_id, display_name, status, email)
  values (v_tenant, 'Guard Test Client', 'invited', 'guard-test@example.invalid') returning id into v_client;

  -- coach-built program (no source_draft_id), live
  insert into public.programs (tenant_id, name, structure, is_default)
  values (v_tenant, 'Guard Test — Coach Built', jsonb_build_object('days', v_days), false) returning id into v_prog;
  insert into public.assignments (tenant_id, client_id, program_id, active) values (v_tenant, v_client, v_prog, true);

  -- a generated draft for the same client
  insert into public.program_drafts (tenant_id, client_id, status, training, meal_plan, macros, rationale, health_flags, gate_enabled)
  values (v_tenant, v_client, 'approved', jsonb_build_object('days', v_days), '{}'::jsonb, '{}'::jsonb, 'test', '[]'::jsonb, true) returning id into v_draft;

  -- 1. publish must refuse while the coach program is live
  begin
    v_pub := public.publish_program_draft(v_draft);
    raise exception 'FAIL 1: publish did not refuse';
  exception when others then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'This client already has a live program you built ("Guard Test — Coach Built")%' then
      raise exception 'FAIL 1: unexpected message: %', v_msg;
    end if;
    raise notice 'ok 1 refused: %', v_msg;
  end;

  -- 2. the assignment is untouched and the draft is still unpublished
  if not exists (select 1 from public.assignments where client_id = v_client and program_id = v_prog and active) then
    raise exception 'FAIL 2: coach assignment was changed';
  end if;
  if exists (select 1 from public.program_drafts where id = v_draft and status = 'published') then
    raise exception 'FAIL 2: draft was published';
  end if;
  raise notice 'ok 2 assignment and draft untouched';

  -- 3. coach unassigns explicitly, then publish succeeds and takes over
  update public.assignments set active = false where client_id = v_client and program_id = v_prog;
  v_pub := public.publish_program_draft(v_draft);
  if v_pub is null then raise exception 'FAIL 3: no program id'; end if;
  if (select count(*) from public.assignments where client_id = v_client and active) <> 1 then
    raise exception 'FAIL 3: expected exactly one active assignment';
  end if;
  if not exists (select 1 from public.assignments where client_id = v_client and program_id = v_pub and active) then
    raise exception 'FAIL 3: generated program not live';
  end if;
  raise notice 'ok 3 published after explicit unassign: %', v_pub;

  -- 4. a second generated draft may replace the first generated program (source_draft_id set)
  insert into public.program_drafts (tenant_id, client_id, status, training, meal_plan, macros, rationale, health_flags, gate_enabled)
  values (v_tenant, v_client, 'approved', jsonb_build_object('days', v_days), '{}'::jsonb, '{}'::jsonb, 'test2', '[]'::jsonb, true) returning id into v_draft;
  v_pub := public.publish_program_draft(v_draft);
  if (select count(*) from public.assignments where client_id = v_client and active) <> 1 then
    raise exception 'FAIL 4: expected exactly one active assignment after regenerate';
  end if;
  raise notice 'ok 4 regenerate over a generated program still allowed: %', v_pub;
end $t$;

rollback;
