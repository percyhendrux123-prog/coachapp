-- tenant_config.mode — the one fact the client app learns about its tenant:
-- coached (a human coach exists; every existing tenant) or self_serve (self-serve plan:
-- no coach, no messaging, no approval gate, connector 'owner' scope permitted).
-- Default 'coached' so no existing tenant changes behaviour. Apply with:
--   supabase db query --linked -f supabase/migrations/20260903100000_tenant_config_mode.sql
alter table public.tenant_config
  add column if not exists mode text not null default 'coached';

alter table public.tenant_config
  drop constraint if exists tenant_config_mode_check;
alter table public.tenant_config
  add constraint tenant_config_mode_check check (mode in ('coached', 'self_serve'));

comment on column public.tenant_config.mode is
  'coached = a human coach runs this tenant (default, every pre-2026-09 tenant). self_serve = self-serve plan: coachless by design; client UI hides coach surfaces; connector owner scope is mintable. Only value the owner-scope trigger trusts.';
