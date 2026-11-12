-- One-time setup: create the platform owner tenant and make yourself its coach.
--
-- 1. Sign in to the deployed app once with your email (magic link), so an auth user exists.
-- 2. Replace the email below with your sign-in email, then run this file in the Supabase
--    SQL editor (or with psql "$DATABASE_URL" -f supabase/setup/bootstrap_owner.sql).
--
-- The owner tenant uses the slug 'owner'. Owner-only features (adding white-label coaches,
-- the platform digest, self-serve buyer lists) check for that slug.
-- The optional self-serve tenant ('self-serve', mode self_serve) is only needed if you sell
-- the self-serve plan.

begin;

insert into public.tenants (slug) values ('owner') on conflict (slug) do nothing;
insert into public.tenant_config (tenant_id)
  select id from public.tenants where slug = 'owner'
  on conflict (tenant_id) do nothing;

insert into public.profiles (user_id, role, tenant_id)
select u.id, 'coach', t.id
  from auth.users u, public.tenants t
 where lower(u.email) = lower('you@example.com')   -- <-- your sign-in email
   and t.slug = 'owner'
on conflict (user_id) do nothing;

-- Optional: self-serve plan tenant.
-- insert into public.tenants (slug) values ('self-serve') on conflict (slug) do nothing;
-- insert into public.tenant_config (tenant_id, mode)
--   select id, 'self_serve' from public.tenants where slug = 'self-serve'
--   on conflict (tenant_id) do nothing;

commit;
