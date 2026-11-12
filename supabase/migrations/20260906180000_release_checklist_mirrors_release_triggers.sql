-- Slice 3 follow-up (found by the live test suite, 2026-09-06 19:52 CDT): the first
-- release_checklist() said a structured nutrition draft was ready when it had ≥1 slot, but the
-- assign is guarded by check_client_meal_plan_release() (meals_per_day, four macro targets,
-- day-0 slots = meals_per_day, every day-0 meal published) and the legacy table by
-- check_meal_plan_release() (macros set, ≥1 meal). release_client() already refused atomically
-- when the trigger fired — nothing was ever half-released — but the panel showed a tick the
-- write would refuse. This re-issue mirrors both triggers so the checklist and the write agree.
create or replace function public.release_checklist(p_client_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = public as $fn$
declare
  cli          public.clients%rowtype;
  v_live       boolean;
  v_draft      public.program_drafts%rowtype;
  v_days       int := 0;
  v_assigned   boolean;
  v_splan      public.client_meal_plans%rowtype;
  v_splan_id   uuid;
  v_slots      int := 0;
  v_day0       int := 0;
  v_unpub      int := 0;
  v_sreason    text;
  v_lplan      public.meal_plans%rowtype;
  v_lplan_id   uuid;
  v_lreason    text;
  v_held       public.program_drafts%rowtype;
  v_intake     public.intake_forms%rowtype;
  v_flags      jsonb;
  v_reviewed   boolean := false;
  v_program    jsonb;
  v_nutrition  jsonb;
  v_email      jsonb;
  v_health     jsonb;
begin
  if coalesce(public.current_app_role(), '') is distinct from 'coach' then
    raise exception 'not authorized: coach role required';
  end if;
  select * into cli from public.clients where id = p_client_id;
  if not found then raise exception 'client % not found', p_client_id; end if;
  if public.current_tenant_id() is null or cli.tenant_id is distinct from public.current_tenant_id() then
    raise exception 'not authorized: wrong tenant';
  end if;

  -- 1. program
  select exists (select 1 from public.assignments a where a.client_id = cli.id and a.active) into v_live;
  select * into v_draft from public.program_drafts d
   where d.client_id = cli.id and d.status in ('draft','approved')
   order by d.generated_at desc limit 1;
  if found then v_days := jsonb_array_length(coalesce(v_draft.training->'days','[]'::jsonb)); end if;
  -- A medical hold is a program state the coach must resolve in Programs; release never
  -- approves a held draft on the coach's behalf.
  select * into v_held from public.program_drafts d
   where d.client_id = cli.id and d.status = 'held_medical'
   order by d.generated_at desc limit 1;
  v_program := case
    when v_live then jsonb_build_object('ok', true, 'state', 'live', 'detail', 'Program live')
    when v_draft.id is null and v_held.id is not null then jsonb_build_object('ok', false, 'state', 'held_medical', 'detail', 'Program draft held for medical review — review and approve it in Programs first')
    when v_draft.id is not null and v_days > 0 then jsonb_build_object('ok', true, 'state', 'draft', 'detail', format('Program draft (%s day%s)', v_days, case when v_days = 1 then '' else 's' end), 'draft_id', v_draft.id)
    when v_draft.id is not null then jsonb_build_object('ok', false, 'state', 'empty_draft', 'detail', 'Program draft has no training days')
    else jsonb_build_object('ok', false, 'state', 'none', 'detail', 'No program draft') end;

  -- 2. nutrition — structured (client_meal_plans) first, then the legacy meal_plans table.
  select exists (select 1 from public.client_meal_plans m where m.client_id = cli.id and m.status = 'assigned')
      or exists (select 1 from public.meal_plans l where l.client_id = cli.id and (l.assigned_at is not null or l.status = 'assigned'))
    into v_assigned;
  -- Mirrors check_client_meal_plan_release() (the trigger that guards the assign) exactly,
  -- so the checklist never shows a tick the write would refuse.
  select * into v_splan from public.client_meal_plans m
   where m.client_id = cli.id and m.status = 'draft' order by m.created_at desc limit 1;
  if v_splan.id is not null then
    v_splan_id := v_splan.id;
    select count(*) into v_slots from public.client_meal_plan_slots s where s.plan_id = v_splan_id;
    select count(*) filter (where s.meal_id is not null),
           count(*) filter (where mm.id is null or mm.status <> 'published')
      into v_day0, v_unpub
      from public.client_meal_plan_slots s left join public.meals mm on mm.id = s.meal_id
     where s.plan_id = v_splan_id and s.day_index = 0;
    v_sreason := case
      when v_slots = 0 then 'no meals'
      when v_splan.meals_per_day is null or v_splan.meals_per_day < 1 then 'meals per day not set'
      when v_splan.target_calories is null or v_splan.target_protein_g is null or v_splan.target_fat_g is null or v_splan.target_carb_g is null then 'macro targets not set'
      when v_day0 is distinct from v_splan.meals_per_day then format('day 1 has %s filled slot%s, meals per day says %s', v_day0, case when v_day0 = 1 then '' else 's' end, v_splan.meals_per_day)
      when v_unpub > 0 then format('%s meal%s not published', v_unpub, case when v_unpub = 1 then '' else 's' end)
      else null end;
  end if;
  -- Mirrors check_meal_plan_release() for the legacy table.
  select * into v_lplan from public.meal_plans l
   where l.client_id = cli.id and l.assigned_at is null and coalesce(l.status,'draft') = 'draft'
   order by l.created_at desc limit 1;
  if v_lplan.id is not null then
    v_lplan_id := v_lplan.id;
    v_lreason := case
      when v_lplan.calories is null or v_lplan.protein_g is null or v_lplan.fat_g is null or v_lplan.carb_g is null then 'macros not set'
      when jsonb_array_length(coalesce(v_lplan.meals, '[]'::jsonb)) = 0 then 'no meals'
      else null end;
  end if;
  v_nutrition := case
    when v_assigned then jsonb_build_object('ok', true, 'state', 'assigned', 'detail', 'Nutrition assigned')
    when cli.nutrition_declined_at is not null then jsonb_build_object('ok', true, 'state', 'declined', 'detail', 'No nutrition plan (recorded ' || to_char(cli.nutrition_declined_at, 'YYYY-MM-DD') || ')')
    when v_splan_id is not null and v_sreason is null then jsonb_build_object('ok', true, 'state', 'draft', 'detail', format('Nutrition (%s meal%s)', v_slots, case when v_slots = 1 then '' else 's' end), 'plan_id', v_splan_id, 'source', 'structured')
    when v_splan_id is not null then jsonb_build_object('ok', false, 'state', case when v_slots = 0 then 'empty_draft' else 'incomplete_draft' end, 'detail', 'Nutrition draft not ready: ' || v_sreason, 'plan_id', v_splan_id, 'source', 'structured')
    when v_lplan_id is not null and v_lreason is null then jsonb_build_object('ok', true, 'state', 'draft', 'detail', 'Nutrition (uploaded plan)', 'plan_id', v_lplan_id, 'source', 'legacy')
    when v_lplan_id is not null then jsonb_build_object('ok', false, 'state', 'incomplete_draft', 'detail', 'Nutrition draft not ready: ' || v_lreason, 'plan_id', v_lplan_id, 'source', 'legacy')
    else jsonb_build_object('ok', false, 'state', 'none', 'detail', 'No nutrition plan — or tick "no nutrition for this client"') end;

  -- 3. email — present AND syntactically valid (one @, something either side, a dot after).
  v_email := case
    when nullif(trim(coalesce(cli.email, '')), '') is null then jsonb_build_object('ok', false, 'state', 'missing', 'detail', 'Email missing')
    when trim(cli.email) !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then jsonb_build_object('ok', false, 'state', 'invalid', 'detail', 'Email looks invalid: ' || cli.email)
    else jsonb_build_object('ok', true, 'state', 'valid', 'detail', 'Email ' || trim(cli.email)) end;

  -- 4. health / compliance — authoritative at the database boundary. Reads the latest
  -- SUBMITTED intake's health_flags (written by intake-submit from the PAR-Q answers).
  -- Fails closed: no screen on record, or an unreadable one, blocks; a flagged screen
  -- blocks unless a coach has explicitly reviewed it — the only clearance this app records
  -- is a coach approving the draft that carried the flags (approve_program_draft on the held
  -- draft, decided_by set). Nothing here infers clearance.
  select * into v_intake from public.intake_forms i
   where i.client_id = cli.id and i.status = 'submitted'
   order by i.submitted_at desc nulls last, i.created_at desc limit 1;
  if v_intake.id is null then
    v_health := jsonb_build_object('ok', false, 'state', 'no_screen', 'detail', 'No health screen on record — a submitted intake is required');
  elsif jsonb_typeof(v_intake.health_flags) is distinct from 'array' then
    v_health := jsonb_build_object('ok', false, 'state', 'unreadable', 'detail', 'Health screen not readable — fix the intake record before releasing');
  elsif jsonb_array_length(v_intake.health_flags) = 0 then
    v_health := jsonb_build_object('ok', true, 'state', 'clear', 'detail', 'Health screen clear');
  else
    v_flags := v_intake.health_flags;
    select exists (select 1 from public.program_drafts d
                    where d.intake_id = v_intake.id and d.status in ('approved', 'published')
                      and d.decided_by is not null) into v_reviewed;
    v_health := case
      when v_reviewed then jsonb_build_object('ok', true, 'state', 'flagged_reviewed', 'flags', v_flags,
                              'detail', 'Health screen flagged, reviewed and approved by coach')
      else jsonb_build_object('ok', false, 'state', 'flagged', 'flags', v_flags,
                              'detail', 'Health screen flagged (' || (select string_agg(x, ', ') from jsonb_array_elements_text(v_flags) x) || ') — review and approve the held draft in Programs first') end;
  end if;

  return jsonb_build_object(
    'client_id', cli.id,
    'program', v_program, 'nutrition', v_nutrition, 'email', v_email, 'health', v_health,
    'invite_state', case when cli.client_user_id is not null then 'claimed'
                         when cli.invite_token is null then 'none'
                         when cli.invite_expires_at < now() then 'expired' else 'pending' end,
    'ready', (v_program->>'ok')::boolean and (v_nutrition->>'ok')::boolean and (v_email->>'ok')::boolean and (v_health->>'ok')::boolean);
end $fn$;
