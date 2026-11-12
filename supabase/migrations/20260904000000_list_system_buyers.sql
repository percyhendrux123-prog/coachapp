-- Phase 4, part A.
-- Who bought the self-serve plan, for the platform owner only. SYSTEM buyers live in self-serve
-- tenants that no coach can read under RLS, so this is a SECURITY DEFINER reader gated on
-- the caller being a coach of the tenant whose slug is 'owner' (the same rule as the MCP's
-- requireOwnerTenant), or the service role (the MCP tool, which applies that rule itself).
-- Any other caller gets an exception, never an empty list — "no rows" must mean "no buyers".
--
-- Every column is derived from existing tables; nothing is estimated. Booleans are real
-- yes/no facts (a row exists or it does not). last_seen_at is the latest of: an AI
-- connection being used, an intake being submitted, the client row being updated — named
-- so it is not mistaken for app opens, which are not tracked.
create or replace function public.list_system_buyers()
returns table (
  client_id uuid,
  tenant_id uuid,
  app_name text,
  display_name text,
  email_masked text,
  status text,
  joined_at timestamptz,
  intake_status text,
  intake_submitted_at timestamptz,
  program_published boolean,
  meal_plan_assigned boolean,
  ai_connected boolean,
  ai_scope text,
  last_seen_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not (
    coalesce(auth.role(), '') = 'service_role'
    or exists (
      select 1 from public.profiles p
      join public.tenants t on t.id = p.tenant_id
      where p.user_id = auth.uid() and p.role = 'coach' and t.slug = 'owner'
    )
  ) then
    raise exception 'list_system_buyers is restricted to the platform owner' using errcode = '42501';
  end if;

  return query
  select
    c.id,
    c.tenant_id,
    tc.app_name,
    c.display_name,
    case when c.email is null then null
         else left(split_part(c.email, '@', 1), 2) || '…@' || split_part(c.email, '@', 2) end,
    c.status::text,
    c.joined_at,
    coalesce(li.status, 'none'),
    li.submitted_at,
    exists (select 1 from public.assignments a where a.client_id = c.id and a.active),
    exists (select 1 from public.client_meal_plans m where m.client_id = c.id and m.status = 'assigned'),
    exists (select 1 from public.connector_tokens k where k.client_id = c.id and k.kind = 'client' and k.revoked_at is null),
    (select max(k.scope) from public.connector_tokens k where k.client_id = c.id and k.kind = 'client' and k.revoked_at is null),
    greatest(
      (select max(k.last_used_at) from public.connector_tokens k where k.client_id = c.id),
      li.submitted_at,
      c.updated_at
    )
  from public.clients c
  join public.tenant_config tc on tc.tenant_id = c.tenant_id and tc.mode = 'self_serve'
  left join lateral (
    select f.status::text as status, f.submitted_at
      from public.intake_forms f
     where f.client_id = c.id
     order by f.submitted_at desc nulls last, f.created_at desc
     limit 1
  ) li on true
  where c.status <> 'archived'
  order by c.joined_at desc nulls last;
end;
$$;

revoke all on function public.list_system_buyers() from public, anon;
grant execute on function public.list_system_buyers() to authenticated, service_role;
