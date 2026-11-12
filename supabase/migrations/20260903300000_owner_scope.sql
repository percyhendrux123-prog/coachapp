-- connector 'owner' scope: full read+write over the client's OWN plan, permitted ONLY in a
-- self_serve tenant. The platform owner's rule (2026-09-01): coached clients' AIs never get write access
-- to programming or nutrition. Enforced three ways, deepest first:
--   1. kind↔scope CHECK: client tokens may be read | comms | owner; read_write stays impossible;
--   2. BEFORE trigger, keyed to tenant_config.mode (never to "has no coach" — production has
--      7 coachless tenants that are abandoned signups, see plan Finding 2):
--        - scope='owner' requires mode='self_serve';
--        - scope='comms' is refused when mode='self_serve' (the platform owner's condition, 2026-09-02:
--          there is no coach to receive a message; a comms token would write into an inbox
--          nobody will ever open — folded in here, no separate migration);
--      The trigger enforces on INSERT and on a scope CHANGE only. A plain UPDATE that leaves
--      scope alone (revoking, last_used_at) always passes, so a token minted before a tenant's
--      mode changed can still be revoked. Revocation is explicit; the trigger never blocks it.
--   3. RLS ct_client_insert widened to 'owner' and narrowed on 'comms' under the same
--      tenant-mode condition, for the client-JWT path.
-- Live policy text read 2026-09-02 before writing this (not the repo baseline): the policies
-- rebuilt below are byte-matched to what is deployed, plus the new clauses.
--
-- Apply with: supabase db query --linked -f supabase/migrations/20260903300000_owner_scope.sql

-- ── 1. kind ↔ scope ────────────────────────────────────────────────────────────────────
alter table public.connector_tokens drop constraint if exists connector_tokens_kind_scope;
alter table public.connector_tokens add constraint connector_tokens_kind_scope check (
  (kind = 'coach'  and scope in ('read', 'read_write') and client_id is null) or
  (kind = 'client' and scope in ('read', 'comms', 'owner') and client_id is not null)
);

-- ── 2. tenant-mode trigger ─────────────────────────────────────────────────────────────
create or replace function public.connector_tokens_owner_requires_self_serve()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_mode text;
begin
  -- Only when the scope is being established or changed. Revoking or touching
  -- last_used_at on an existing token must never be blocked by a later mode change.
  if tg_op = 'UPDATE' and new.scope is not distinct from old.scope and new.kind is not distinct from old.kind then
    return new;
  end if;

  if new.kind = 'client' and new.scope in ('owner', 'comms') then
    select mode into v_mode from public.tenant_config where tenant_id = new.tenant_id;

    if new.scope = 'owner' and v_mode is distinct from 'self_serve' then
      raise exception 'owner scope requires a self_serve tenant (mode=%)', coalesce(v_mode, 'null');
    end if;

    if new.scope = 'comms' and v_mode = 'self_serve' then
      raise exception 'comms scope is not available in a self_serve tenant — there is no coach to receive messages';
    end if;

    if not exists (select 1 from public.clients where id = new.client_id and tenant_id = new.tenant_id) then
      raise exception 'token client is not in this tenant';
    end if;
  end if;

  return new;
end $$;

comment on function public.connector_tokens_owner_requires_self_serve() is
  'BEFORE INSERT/UPDATE guard on connector_tokens. owner scope only inside tenant_config.mode = self_serve; comms scope refused inside self_serve (no coach exists to read it). Enforces on insert and on scope change only — revocation of an existing token is never blocked.';

drop trigger if exists trg_connector_tokens_owner_guard on public.connector_tokens;
create trigger trg_connector_tokens_owner_guard
  before insert or update on public.connector_tokens
  for each row execute function public.connector_tokens_owner_requires_self_serve();

-- ── 3. RLS: the client-JWT path ────────────────────────────────────────────────────────
-- Live text before this change:
--   (kind='client') AND (scope IN ('read','comms')) AND (client_id=current_client_id())
--   AND (tenant_id=current_tenant_id())
-- The tenant_config subquery runs as the caller; clients can read their own tenant's row
-- via the existing tc_member_read policy (see src/lib/license.js getTenantBranding).
drop policy if exists ct_client_insert on public.connector_tokens;
create policy ct_client_insert on public.connector_tokens
  for insert to public
  with check (
    kind = 'client'
    and client_id = current_client_id()
    and tenant_id = current_tenant_id()
    and (
      scope = 'read'
      or (scope = 'comms' and not exists (
            select 1 from public.tenant_config c
             where c.tenant_id = current_tenant_id() and c.mode = 'self_serve'))
      or (scope = 'owner' and exists (
            select 1 from public.tenant_config c
             where c.tenant_id = current_tenant_id() and c.mode = 'self_serve'))
    )
  );

-- ── 4. Custom meals belong to one buyer ────────────────────────────────────────────────
-- Every SYSTEM buyer shares one tenant, so a tenant-scoped meal would leak between buyers
-- (spec §14). owner_client_id null = tenant/global library, as today.
alter table public.meals
  add column if not exists owner_client_id uuid references public.clients(id) on delete cascade;
create index if not exists meals_owner_client_idx
  on public.meals (owner_client_id) where owner_client_id is not null;
comment on column public.meals.owner_client_id is
  'Set on a client''s own custom meal (self-serve add_my_meal). Null = library meal visible to the whole tenant. A buyer sees only their own custom meals; a coach in the tenant sees all.';

-- Live text before this change:
--   (status='published') AND ((tenant_id IS NULL) OR (tenant_id=current_tenant_id()))
drop policy if exists meals_read on public.meals;
create policy meals_read on public.meals
  for select to public
  using (
    status = 'published'
    and (tenant_id is null or tenant_id = current_tenant_id())
    and (
      owner_client_id is null
      or owner_client_id = current_client_id()
      or current_app_role() = 'coach'
    )
  );

-- A client may insert only a meal it owns, in its own tenant. The MCP add_my_meal path
-- uses the service role and sets owner_client_id itself; this policy is for any future
-- in-app button, so the same rule holds on both paths. meals_tenant_coach_write is
-- unchanged (coach ALL within tenant).
drop policy if exists meals_client_own_insert on public.meals;
create policy meals_client_own_insert on public.meals
  for insert to public
  with check (
    owner_client_id is not null
    and owner_client_id = current_client_id()
    and tenant_id = current_tenant_id()
  );
