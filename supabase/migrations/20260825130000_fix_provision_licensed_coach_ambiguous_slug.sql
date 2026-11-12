-- ============================================================================
-- Fix: provision_licensed_coach has raised "column reference slug is
-- ambiguous" (42702) on EVERY call since it was created (20260824200000).
--
-- Found 2026-08-25 while building and testing provision_coach_admin (a new,
-- separate function for the add-a-coach admin tool), which copied this exact
-- pattern and hit the same error immediately. Confirmed by calling
-- provision_licensed_coach directly: it fails at the same WHILE loop before
-- ever reaching the insert.
--
-- CONSEQUENCE: this is the function license-provision calls to finish the real
-- white-label signup, after Stripe has already been charged. Every
-- attempt at that flow since 2026-08-24 would have taken the coach's payment
-- and then failed with a server error, with no tenant created.
--
-- OWNER: check Stripe for any completed checkout on license-checkout since
-- 2026-08-24. If one exists, that person paid and got nothing -- they need to
-- be made right by hand (refund, or manually provision their tenant and
-- comp/credit the charge). This migration fixes the bug going forward; it
-- does not and cannot fix a payment that already happened.
--
-- Root cause: `slug` was both a plpgsql local variable and a column on
-- public.tenants. Renaming the variable to `v_slug` (rather than trying to
-- qualify one side of the comparison, which turns out not to be enough --
-- the unqualified side is still checked against both namespaces) removes the
-- ambiguity. Nothing else about the function changes.
-- ============================================================================

create or replace function public.provision_licensed_coach(
  p_user_id uuid,
  p_app_name text,
  p_display_name text,
  p_session_id text,
  p_customer_id text,
  p_subscription_id text
)
returns public.tenants
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  base0   text;
  v_slug  text;
  n       int := 0;
  t       public.tenants;
begin
  base0 := regexp_replace(lower(coalesce(nullif(p_app_name,''), 'coach')), '[^a-z0-9]+', '-', 'g');
  base0 := trim(both '-' from base0);
  if base0 = '' then base0 := 'coach'; end if;

  v_slug := base0;
  while exists (select 1 from public.tenants where slug = v_slug) loop
    n := n + 1;
    v_slug := base0 || '-' || n;
  end loop;

  insert into public.tenants (
    coach_user_id, slug, license_stripe_ref, licensed_at,
    stripe_customer_id, subscription_id, subscription_status, status
  ) values (
    p_user_id, v_slug, p_session_id, now(),
    p_customer_id, p_subscription_id, 'active', 'active'
  )
  returning * into t;

  insert into public.profiles (user_id, role, tenant_id)
  values (p_user_id, 'coach', t.id);

  insert into public.tenant_config (tenant_id, app_name, coach_display_name)
  values (t.id, coalesce(nullif(p_app_name,''), 'My Coaching App'), coalesce(nullif(p_display_name,''), 'Coach'));

  return t;
end;
$$;
