-- ============================================================================
-- Client schedule adjustments — "swap today's planned day with a later day in
-- this block". Training here is sequence-based, not date-scheduled
-- (current_day_index walks program.structure.days), so "reorder the days" is the
-- only feature this needs — a missed day already slides everything forward with
-- no extra work.
--
-- THE INVARIANT. current_day_index becomes an index into the EFFECTIVE order
-- (assignments.day_order if set, else the program's own structure.days order).
-- Every reader in the app now goes through one shared resolver
-- (src/lib/effectiveDays.js + its Deno twin) instead of indexing
-- program.structure.days directly. This migration only adds the column and the
-- write path; the read-side fix is entirely application code (no schema change
-- needed there).
--
-- WHY A SEPARATE OVERRIDE COLUMN, NOT AN EDIT TO programs.structure: The coach's
-- program and its day_ids anchor workout history (the project notes, decision 4 in the
-- plan) and must never be touched by a client-initiated change. The override
-- lives on the client's own assignment and applies to exactly one block — a
-- fresh cycle (closeDayCore's rollover insert) always starts a new assignment
-- with day_order left null, so nothing carries forward (decision 3).
--
-- WHY A NULLABLE ARRAY, NO BACKFILL: null means "no override — use the program's
-- own order," which is the correct, harmless state of every assignment row that
-- exists today. No existing row needs touching.
--
-- WRITES GO THROUGH adjust_my_schedule() ONLY (SECURITY DEFINER). There is
-- deliberately no direct client INSERT/UPDATE policy on schedule_adjustments and
-- no direct client UPDATE policy on assignments.day_order (the existing
-- assignments RLS already doesn't grant clients UPDATE at all — see
-- src/lib/workouts.js's header: "day advancement goes through the workout-close
-- edge function because clients are SELECT-only on assignments"). The RPC
-- re-derives the CURRENT effective order itself from the database rather than
-- trusting anything the caller claims it was, and independently validates the
-- new order is an exact permutation of the program's day_ids with every
-- position before current_day_index left untouched (decision 5: past days are
-- immutable).
--
-- THE SUSPENSION GUARD IS ATTACHED HERE, EXPLICITLY, for the same reason
-- 20260826190100 / 20260826200000 attach it explicitly: 20260728234500 only
-- looped over tables that existed when it ran, so any new tenant-scoped table
-- must attach trg_tenant_suspension_guard itself or it silently joins the list
-- of tables the 20260824180000 catch-up sweep had to fix later. adjust_my_schedule
-- is SECURITY DEFINER and so bypasses this trigger for its own writes (same
-- exemption every other definer function relies on to keep working under
-- suspension-adjacent conditions) — this is defense-in-depth against any future
-- direct write path, exactly the rationale client_documents.sql gives for doing
-- the same on a table with no direct write path today either.
--
-- Rollback:
--   drop trigger if exists trg_tenant_suspension_guard on public.schedule_adjustments;
--   drop function if exists public.adjust_my_schedule(uuid, uuid[], text, text);
--   drop policy if exists schedule_adjustments_client_read on public.schedule_adjustments;
--   drop policy if exists schedule_adjustments_coach_read on public.schedule_adjustments;
--   drop table if exists public.schedule_adjustments;
--   alter table public.assignments drop column if exists day_order;
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. assignments.day_order — nullable, no default, no backfill.
-- ---------------------------------------------------------------------------
alter table public.assignments
  add column if not exists day_order uuid[];

comment on column public.assignments.day_order is
  'Null (every row today) means "use the program''s own day order." When set, a permutation '
  'of the program''s current structure.days day_ids for THIS assignment only — written only by '
  'adjust_my_schedule(). Resolve through src/lib/effectiveDays.js (or its Deno twin), never by '
  'indexing program.structure.days with current_day_index directly.';

-- ---------------------------------------------------------------------------
-- 2. schedule_adjustments — one row per client-initiated reorder. Event log,
--    not a mutable settings table: never updated after insert.
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_adjustments (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,
  assignment_id uuid not null references public.assignments(id) on delete cascade,

  -- The full effective day-id order immediately before/after this adjustment, as
  -- computed by the RPC from the database — never trusted from caller input for
  -- old_order. jsonb (not uuid[]) so the event log is self-contained and legible
  -- without a join back to a program that may since have changed shape.
  old_order     jsonb not null,
  new_order     jsonb not null,

  -- Optional, structured + free text. NULL means "skipped" and is displayed as
  -- "not given" — a fact about the flow, not about the client (twin-facts rule).
  -- Never defaulted to a plausible-looking value; THE GATE applies.
  reason_tag    text,
  reason_note   text,

  created_at    timestamptz not null default now()
);

create index if not exists schedule_adjustments_client_idx
  on public.schedule_adjustments (tenant_id, client_id, created_at desc);
create index if not exists schedule_adjustments_assignment_idx
  on public.schedule_adjustments (assignment_id, created_at desc);

comment on table public.schedule_adjustments is
  'Event log of client-initiated day-order swaps within their current training block. Written '
  'only by adjust_my_schedule(). reason_tag/reason_note are optional and NULL means the client '
  'skipped the reason prompt, not that no reason exists — render as "not given," never blank or '
  'defaulted.';

alter table public.schedule_adjustments enable row level security;

drop policy if exists schedule_adjustments_coach_read on public.schedule_adjustments;
create policy schedule_adjustments_coach_read on public.schedule_adjustments
  for select to authenticated
  using (
    tenant_id = public.current_tenant_id()
    and public.current_app_role() = 'coach'
  );

drop policy if exists schedule_adjustments_client_read on public.schedule_adjustments;
create policy schedule_adjustments_client_read on public.schedule_adjustments
  for select to authenticated
  using (client_id = public.current_client_id());

-- Deliberately no insert/update/delete policy for `authenticated` at all — every
-- write goes through adjust_my_schedule(), which is SECURITY DEFINER and so does
-- not need one. This is the same shape as submit_checkin()/complete_session()
-- (no direct client insert policy on checkins/workout_sessions for those calls
-- either) applied here for the same reason: the RPC is the only place the
-- validation (ownership, permutation, frozen-past-days) can be enforced
-- atomically against the live row, so it must be the only write path.

drop trigger if exists trg_tenant_suspension_guard on public.schedule_adjustments;
create trigger trg_tenant_suspension_guard
  before insert or update or delete on public.schedule_adjustments
  for each row execute function public.enforce_tenant_not_suspended();

-- ---------------------------------------------------------------------------
-- 3. adjust_my_schedule() — the only write path. Modeled closely on
--    complete_session() / submit_checkin() (migration 20260824190000): same
--    current_client_id()/current_tenant_id() helpers, same tenant_is_suspended
--    check and wording. Modeled on set_brief_slide_order() (20260830190000) for
--    the "full-set permutation, verified by matched row count" technique.
-- ---------------------------------------------------------------------------
create or replace function public.adjust_my_schedule(
  p_assignment_id uuid,
  p_new_order uuid[],
  p_reason_tag text default null,
  p_reason_note text default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  cid uuid := public.current_client_id();
  tid uuid := public.current_tenant_id();
  a public.assignments%rowtype;
  v_program_days jsonb;
  v_program_ids uuid[];
  v_old_order uuid[];
  v_program_count integer;
  v_new_count integer;
  v_distinct_count integer;
  i integer;
begin
  if cid is null then
    raise exception 'not a client';
  end if;

  select * into a from public.assignments where id = p_assignment_id;
  if a.id is null or a.client_id is distinct from cid then
    raise exception 'not your assignment';
  end if;
  if not a.active then
    raise exception 'this assignment is no longer active — adjustments only apply to your current block';
  end if;

  if public.tenant_is_suspended(tid) then
    raise exception 'This app is paused: its hosting subscription has lapsed. Existing data stays readable, but new changes are unavailable until it is reactivated.'
      using errcode = '42501';
  end if;

  select structure -> 'days' into v_program_days
    from public.programs where id = a.program_id;
  if v_program_days is null or jsonb_typeof(v_program_days) is distinct from 'array' then
    raise exception 'program has no days to reorder';
  end if;

  select array_agg((d ->> 'day_id')::uuid order by ord)
    into v_program_ids
    from jsonb_array_elements(v_program_days) with ordinality as t(d, ord);

  v_program_count := coalesce(array_length(v_program_ids, 1), 0);
  if v_program_count = 0 then
    raise exception 'program has no days to reorder';
  end if;
  if a.current_day_index < 0 or a.current_day_index > v_program_count then
    raise exception 'assignment day index is out of range for this program';
  end if;

  -- p_new_order must be an EXACT permutation of the program's day_ids: same
  -- length, no duplicates, every id drawn from the program. (Same length +
  -- all-distinct + all-members-of-a-same-size-set together force a bijection —
  -- no separate "every program id is present" check is needed.)
  v_new_count := coalesce(array_length(p_new_order, 1), 0);
  if v_new_count <> v_program_count then
    raise exception 'pass the full day order: % day(s) exist in this program, % given',
      v_program_count, v_new_count;
  end if;

  select count(distinct x) into v_distinct_count from unnest(p_new_order) as x;
  if v_distinct_count <> v_program_count then
    raise exception 'day order must name each of this program''s days exactly once';
  end if;

  if exists (select 1 from unnest(p_new_order) as x where x <> all (v_program_ids)) then
    raise exception 'day order references a day that is not part of this program''s current days';
  end if;

  -- The CURRENT effective order, re-derived from the database (never trusted from
  -- the caller) — same fallback rule as effectiveDays.js: a stale day_order (the
  -- coach edited the program since the last adjustment) is treated as if it were
  -- never set.
  if a.day_order is not null
     and array_length(a.day_order, 1) = v_program_count
     and (select count(distinct x) from unnest(a.day_order) as x) = v_program_count
     and not exists (select 1 from unnest(a.day_order) as x where x <> all (v_program_ids))
  then
    v_old_order := a.day_order;
  else
    v_old_order := v_program_ids;
  end if;

  -- Past days are immutable (decision 5): every position before current_day_index
  -- must be byte-identical between the current effective order and the requested
  -- one. Postgres arrays are 1-indexed; current_day_index is 0-based, so position
  -- k (0-based) is array index k+1 — the loop below covers indices 1..current_day_index,
  -- i.e. every 0-based position strictly before current_day_index.
  if a.current_day_index > 0 then
    for i in 1..a.current_day_index loop
      if v_old_order[i] is distinct from p_new_order[i] then
        raise exception 'day % has already passed and cannot be rearranged', i;
      end if;
    end loop;
  end if;

  insert into public.schedule_adjustments
    (tenant_id, client_id, assignment_id, old_order, new_order, reason_tag, reason_note)
  values (
    tid, cid, a.id,
    to_jsonb(v_old_order), to_jsonb(p_new_order),
    nullif(btrim(p_reason_tag), ''), nullif(btrim(p_reason_note), '')
  );

  update public.assignments
     set day_order = p_new_order, updated_at = now()
   where id = a.id;
end;
$function$;

comment on function public.adjust_my_schedule(uuid, uuid[], text, text) is
  'Client-only. Reorders the remaining days (at/after current_day_index) of the caller''s own '
  'active assignment. Rejects a change to any day at or before current_day_index, and rejects '
  'any order that is not an exact permutation of the program''s current day_ids. Writes exactly '
  'one schedule_adjustments row per call. reason_tag/reason_note pass through as given — NULL '
  'stays NULL, never substituted.';
