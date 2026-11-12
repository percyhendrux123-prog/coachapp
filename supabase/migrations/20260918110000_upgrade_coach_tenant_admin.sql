-- ============================================================================
-- Fix: admin-provision-coach had no path to upgrade an existing coach's
-- tenant -- every call inserted a brand-new tenant row, unconditionally
-- (provision_coach_admin, 20260825120000).
--
-- Found 2026-09-18 via a live incident: Courtland Carson (Incentive Athletics,
-- tenant `incentive`, still on a 14-day trial) was meant to be granted full
-- comped access. The only tool available created a SECOND, separate tenant
-- (`incentiveathletics`, created 2026-09-17) instead of upgrading the one he
-- was actually using. That new tenant has never been claimed (coach_user_id
-- is null) -- Courtland never got the access, and his real trial kept
-- counting down unnoticed.
--
-- upgrade_coach_tenant_admin gives an explicit, opt-in path to upgrade an
-- ALREADY-CLAIMED tenant in place (comped or paid) instead of creating a new
-- one. It deliberately refuses an unclaimed tenant -- upgrading something
-- nobody has claimed yet isn't an upgrade, it's provisioning, which
-- provision_coach_admin already does.
-- ============================================================================

create or replace function public.upgrade_coach_tenant_admin(
  p_slug text,
  p_mode text,                    -- 'comped' | 'paid' -- upgrades only move a coach OFF trial
  p_reason text default null,
  p_subscription_id text default null,
  p_customer_id text default null
)
returns public.tenants
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  t public.tenants;
begin
  if p_mode not in ('comped', 'paid') then
    raise exception 'upgrade_coach_tenant_admin: mode must be comped or paid (got %)', p_mode;
  end if;
  if p_mode = 'comped' and coalesce(nullif(trim(p_reason), ''), '') = '' then
    raise exception 'upgrade_coach_tenant_admin: comped mode requires a reason';
  end if;
  if p_mode = 'paid' and (p_subscription_id is null or p_customer_id is null) then
    raise exception 'upgrade_coach_tenant_admin: paid mode requires both subscription_id and customer_id';
  end if;

  select * into t from public.tenants where slug = p_slug;
  if not found then
    raise exception 'upgrade_coach_tenant_admin: no tenant with slug %', p_slug;
  end if;
  if t.coach_user_id is null then
    raise exception 'upgrade_coach_tenant_admin: tenant % has not been claimed by a coach yet -- use provision_coach_admin to create a new tenant instead', p_slug;
  end if;

  update public.tenants set
    trial_ends_at       = null,
    comp_reason          = case when p_mode = 'comped' then p_reason else null end,
    subscription_id      = case when p_mode = 'paid' then p_subscription_id else null end,
    stripe_customer_id   = case when p_mode = 'paid' then p_customer_id else null end,
    subscription_status  = case when p_mode = 'paid' then 'active' else null end,
    updated_at           = now()
  where id = t.id
  returning * into t;

  return t;
end;
$$;

comment on function public.upgrade_coach_tenant_admin(text, text, text, text, text) is
  'Upgrades an ALREADY-CLAIMED tenant from trial to comped/paid in place. Service-role only -- the caller (admin-provision-coach edge function) must independently verify the caller is the owner-tenant coach, and for paid mode, that the subscription is real, before calling this. Refuses an unclaimed tenant -- that case belongs to provision_coach_admin.';

revoke all on function public.upgrade_coach_tenant_admin(text, text, text, text, text) from public;
revoke all on function public.upgrade_coach_tenant_admin(text, text, text, text, text) from anon;
revoke all on function public.upgrade_coach_tenant_admin(text, text, text, text, text) from authenticated;
grant execute on function public.upgrade_coach_tenant_admin(text, text, text, text, text) to service_role;
