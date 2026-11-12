-- Publishing a generated draft must not silently replace a program the coach built by hand.
--
-- Found 2026-09-20 from coach Courtland Carson (tenant `incentive`). Twice — Ziri Pichardo
-- 2026-09-13 and Corey Carson 2026-09-17 — he built a client's program in Programs, assigned
-- it, and it went live. The client's intake had also produced an AI draft, which sat on Coach
-- Home as "Program drafts awaiting approval". He tapped Approve. approve_program_draft ->
-- publish_program_draft inserted the generated program, flipped his assignment to inactive
-- and made the generated one live. From his side: "after the client has full access the plan
-- changes to a preset plan already created by the app. All my notes and workouts then vanish."
-- (decided_by on both drafts is the coach's own user; decision_note null: the Approve card.)
--
-- Nothing was deleted — his program and its assignment rows still exist, inactive — but the
-- client sees the generated plan and every day he trains on it is history against the wrong
-- program. Ziri's was flipped back by hand on 2026-09-18. Corey's is still wrong at the time
-- of writing.
--
-- The guard lives in the publish path itself so every caller gets it (approve_program_draft,
-- release_client, the MCP connector). Rule: if the client already has an ACTIVE assignment to
-- a program that did not come from a draft (programs.source_draft_id is null = coach-built),
-- refuse with a message that names the program. The coach's intent is preserved either way:
-- to switch the client to the generated plan they unassign or archive their own in Programs
-- first, which is an explicit choice instead of a side effect of a button labelled Approve.
-- Replacing a previously PUBLISHED draft's program (source_draft_id set) is still allowed —
-- that is a regenerate, not a coach's work being overwritten.
--
-- release_client() already skips publishing when a live assignment exists (release_checklist
-- state 'live'), so this changes nothing there. approve_program_draft surfaces the exception
-- verbatim on the Coach Home row (ReviewProgramDrafts shows every failure as-is), so the
-- coach reads exactly why and what to do. No UI change is required for the guard to hold;
-- a follow-up may mark such rows "already live" before the tap.
--
-- Drift note, 2026-09-20: production's publish_program_draft was the pre-2026-07-31 text
-- (no hold-marker handling). Migration 20260731203000 is in the repo but its publish body was
-- not what pg_get_functiondef returned on the live project. This file re-issues that body in
-- full plus the guard, so applying it also lands the hold-marker fix.

create or replace function public.publish_program_draft(p_draft_id uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  d public.program_drafts%rowtype;
  cli public.clients%rowtype;
  new_program_id uuid;
  v_meal_plan jsonb;
  v_live_name text;
begin
  select * into d from public.program_drafts where id = p_draft_id;
  if not found then raise exception 'draft % not found', p_draft_id; end if;
  if d.status = 'published' and d.published_program_id is not null then
    return d.published_program_id;  -- idempotent
  end if;
  if jsonb_array_length(coalesce(d.training->'days','[]'::jsonb)) = 0 then
    raise exception 'refusing to publish an empty training plan (draft %)', p_draft_id;
  end if;

  -- A coach-built program that is live for this client is never replaced as a side effect.
  select p.name into v_live_name
    from public.assignments a
    join public.programs p on p.id = a.program_id
   where a.client_id = d.client_id and a.active and p.source_draft_id is null
   order by a.assigned_at desc
   limit 1;
  if v_live_name is not null then
    raise exception 'This client already has a live program you built ("%"). Approving this draft would replace it. To use the generated plan instead, unassign or archive your program in Programs first, then approve.', v_live_name
      using errcode = 'P0001', hint = 'live_coach_program';
  end if;

  select * into cli from public.clients where id = d.client_id;

  -- A hold marker is not a nutrition plan. Never let one reach a live program.
  v_meal_plan := case
    when jsonb_typeof(d.meal_plan) = 'object'
     and (d.meal_plan ? 'held_for_medical_review' or d.meal_plan ? 'held_for_missing_metrics')
    then null
    else d.meal_plan
  end;

  insert into public.programs (tenant_id, name, structure, meal_plan, source_draft_id, is_default)
  values (d.tenant_id,
          'Plan — ' || coalesce(cli.display_name,'Client') || ' — ' || to_char(now(),'YYYY-MM-DD'),
          d.training, v_meal_plan, d.id, false)
  returning id into new_program_id;

  -- one active assignment per client
  update public.assignments set active = false, updated_at = now()
    where client_id = d.client_id and active = true;
  insert into public.assignments (tenant_id, client_id, program_id, active)
  values (d.tenant_id, d.client_id, new_program_id, true);

  update public.program_drafts
    set status = 'published', published_program_id = new_program_id,
        decided_at = coalesce(decided_at, now())
    where id = d.id;

  update public.clients set status = 'active', updated_at = now()
    where id = d.client_id and status <> 'active';

  return new_program_id;
end;
$function$;

-- CREATE OR REPLACE keeps the ACL; re-asserted anyway, matching 20260731203000.
revoke execute on function public.publish_program_draft(uuid) from public, anon;
