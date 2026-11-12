-- ============================================================================
-- Two new tenant-scoped tables: support_tickets and message_templates.
--
-- WHY. The coach's endpoint wishlist
-- asks for create_support_ticket, get_escalation_history, get_message_templates
-- and save_message_template. There is no ticket table and no template table
-- anywhere in this schema — verified against the production baseline and all
-- 47 migrations before writing this. These are genuinely new, not a column add.
--
-- ADDITIVE ONLY. Two tables, their RLS, and the suspension guard. No existing
-- table, type, policy, function or trigger is altered or dropped.
--
-- THE SUSPENSION GUARD IS ATTACHED HERE, EXPLICITLY. 20260728234500 attached
-- trg_tenant_suspension_guard by looping over every tenant_id table that
-- existed AT THE TIME IT RAN — it does not fire on future CREATE TABLE, which
-- is exactly how 23 tables ended up with no guard at all (see
-- 20260824180000_suspension_guard_missing_tables.sql). Any new tenant-scoped
-- table must attach it itself or it repeats that bug on day one.
--
-- Rollback:
--   drop table public.support_tickets;
--   drop table public.message_templates;
-- ============================================================================

-- ---------------------------------------------------------------------------
-- support_tickets — an issue logged on a client's behalf, and its escalation
-- history. client_id is NULLABLE on purpose: not every issue is about a
-- client. A billing problem, an app bug, a "the intake link 404s" is about the
-- business, and forcing it to name a client would mean picking one at random.
-- ---------------------------------------------------------------------------
create table if not exists public.support_tickets (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  client_id    uuid references public.clients(id) on delete set null,

  title        text not null,
  detail       text,

  -- low / normal / high. Deliberately three, not five: a five-point scale gets
  -- used as a two-point scale plus noise.
  severity     text not null default 'normal',

  -- open -> acknowledged -> resolved. `resolution` is required to resolve (see
  -- the CHECK below) so a ticket cannot be closed with no account of what
  -- happened — a silently closed ticket is worse than an open one, because it
  -- stops anyone looking.
  status       text not null default 'open',
  resolution   text,

  -- The coach auth user who opened it. Nullable so a ticket opened by an
  -- automated path is not forced to invent an author.
  opened_by    uuid,

  created_at   timestamp with time zone not null default now(),
  updated_at   timestamp with time zone not null default now(),
  resolved_at  timestamp with time zone,

  constraint support_tickets_severity_check
    check (severity in ('low', 'normal', 'high')),
  constraint support_tickets_status_check
    check (status in ('open', 'acknowledged', 'resolved')),
  -- A resolved ticket must say how it was resolved, and must carry the time.
  constraint support_tickets_resolution_required
    check (status <> 'resolved' or (resolution is not null and resolved_at is not null))
);

create index if not exists support_tickets_tenant_status_idx
  on public.support_tickets (tenant_id, status, created_at desc);
create index if not exists support_tickets_client_idx
  on public.support_tickets (tenant_id, client_id, created_at desc)
  where client_id is not null;

comment on table public.support_tickets is
  'Issues logged by a coach (or their AI) on a client''s behalf, plus the '
  'escalation history read back by get_escalation_history. client_id is null '
  'for business-level issues that are about no particular client.';

-- ---------------------------------------------------------------------------
-- message_templates — reusable message bodies for a coach's own workspace.
-- Bodies may contain {{display_name}} / {{first_name}}; substitution lives in
-- supabase/functions/mcp/messaging.ts, NOT here, so the template table never
-- has to know what a placeholder means.
-- ---------------------------------------------------------------------------
create table if not exists public.message_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  -- The name the coach says out loud ("send them the check-in nudge").
  -- Unique per tenant so "the check-in nudge" always names one thing.
  slug        text not null,
  title       text not null,
  body        text not null,

  -- Free text. Not enum-constrained, matching the dm_inbound.keyword_tag
  -- precedent — a coach inventing their own grouping should not need a
  -- migration.
  category    text,

  created_by  uuid,
  created_at  timestamp with time zone not null default now(),
  updated_at  timestamp with time zone not null default now()
);

create unique index if not exists message_templates_tenant_slug_uniq
  on public.message_templates (tenant_id, slug);

comment on table public.message_templates is
  'Reusable coach message bodies, per tenant. Placeholder substitution is the '
  'sending code''s job (supabase/functions/mcp/messaging.ts), not this table''s.';

-- ---------------------------------------------------------------------------
-- RLS. Same shape as coach_videos (20260731060000): tenant resolved from the
-- caller''s own profile row via current_tenant_id(), never from a parameter.
-- Neither table is client-readable — support tickets can contain a coach''s
-- candid account of a client''s situation, and templates are internal drafting
-- material. Clients get no policy at all, which is the deny.
-- ---------------------------------------------------------------------------
alter table public.support_tickets   enable row level security;
alter table public.message_templates enable row level security;

create policy support_tickets_coach_all on public.support_tickets
  for all to authenticated
  using      (tenant_id = public.current_tenant_id() and public.current_app_role() = 'coach')
  with check (tenant_id = public.current_tenant_id() and public.current_app_role() = 'coach');

create policy message_templates_coach_all on public.message_templates
  for all to authenticated
  using      (tenant_id = public.current_tenant_id() and public.current_app_role() = 'coach')
  with check (tenant_id = public.current_tenant_id() and public.current_app_role() = 'coach');

-- ---------------------------------------------------------------------------
-- Suspension guard — see the header. Same function, same exemptions
-- (service_role and SECURITY DEFINER bodies) as the other 55 tenant tables.
-- ---------------------------------------------------------------------------
do $attach$
declare
  t text;
begin
  foreach t in array array['support_tickets', 'message_templates'] loop
    execute format('drop trigger if exists trg_tenant_suspension_guard on public.%I', t);
    execute format(
      'create trigger trg_tenant_suspension_guard
         before insert or update or delete on public.%I
         for each row execute function public.enforce_tenant_not_suspended()', t);
  end loop;
end
$attach$;
