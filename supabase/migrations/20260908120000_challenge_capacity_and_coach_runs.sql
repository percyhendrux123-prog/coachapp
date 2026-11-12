-- Slice 3 follow-through.
--
-- H1 — capacity. A challenge may carry a hard cap on entrants. The cap is enforced at the
-- database, not only in challenge-enroll: a BEFORE INSERT trigger on challenge_runs takes a
-- row lock on the parent challenge (SELECT … FOR UPDATE) so two concurrent enrolls are
-- serialised, then counts existing runs and refuses when the cap is reached. Every write
-- path (challenge-enroll, the MCP enroll tool, a coach in SQL) meets the same wall.
-- NULL max_entrants = no cap, which keeps every existing challenge exactly as it was.
--
-- H3 — the coach could not tell who a run belongs to (the runs view showed a user-id
-- fragment). challenge_runs_for_coach() returns the coach's own tenant's runs joined to
-- the participant's sign-in email, for coaches only.

alter table public.challenges
  add column if not exists max_entrants int null
  check (max_entrants is null or max_entrants > 0);

comment on column public.challenges.max_entrants is
  'Hard cap on runs for this challenge, enforced by trg_challenge_runs_capacity. NULL = no cap.';

create or replace function public.challenge_runs_enforce_capacity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_cap   int;
  v_count int;
begin
  -- Lock the parent row: concurrent inserts for the same challenge queue here, so the
  -- count below is exact for whichever transaction holds the lock.
  select max_entrants into v_cap
    from public.challenges
   where id = new.challenge_id
     for update;
  if v_cap is null then
    return new;
  end if;
  select count(*) into v_count
    from public.challenge_runs
   where challenge_id = new.challenge_id;
  if v_count >= v_cap then
    raise exception 'challenge is full'
      using errcode = 'P0001', hint = 'challenge_full',
            detail = format('%s of %s places taken', v_count, v_cap);
  end if;
  return new;
end $$;

drop trigger if exists trg_challenge_runs_capacity on public.challenge_runs;
create trigger trg_challenge_runs_capacity
  before insert on public.challenge_runs
  for each row execute function public.challenge_runs_enforce_capacity();

-- Coach-facing runs with identity. SECURITY DEFINER because auth.users is not readable
-- by the authenticated role; the function itself refuses anyone who is not a coach and
-- scopes strictly to the caller's tenant.
create or replace function public.challenge_runs_for_coach(p_challenge_id uuid)
returns table (
  id uuid, participant_user_id uuid, participant_email text, client_id uuid,
  status text, current_day_index int, perfect_week boolean,
  started_at timestamptz, completed_at timestamptz, created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if public.current_app_role() is distinct from 'coach' or v_tenant is null then
    raise exception 'coach only' using errcode = '42501';
  end if;
  return query
    select r.id, r.participant_user_id, u.email::text, r.client_id,
           r.status::text, r.current_day_index, r.perfect_week,
           r.started_at, r.completed_at, r.created_at
      from public.challenge_runs r
      join public.challenges c on c.id = r.challenge_id
      left join auth.users u on u.id = r.participant_user_id
     where r.challenge_id = p_challenge_id
       and c.tenant_id = v_tenant
       and r.tenant_id = v_tenant
     order by r.created_at desc;
end $$;

revoke all on function public.challenge_runs_for_coach(uuid) from public, anon;
grant execute on function public.challenge_runs_for_coach(uuid) to authenticated;
