-- Coach-minted connector tokens are read-only by policy, not just by UI.
--
-- Finding (2026-09-03, standing state): the migration safety.test.ts describes,
-- 20260819034500_connector_read_only.sql, was never committed. Live pg_policies showed
-- ct_coach_all — a coach could insert a read_write token with a hand-made REST call against
-- their own tenant. The app stopped offering coach write tokens on 2026-08-19; this closes
-- the database side. safety.test.ts now points at this file.
--
-- What changes: the single ct_coach_all policy becomes four. SELECT / UPDATE / DELETE keep
-- the exact same predicate (tenant match + coach role). INSERT additionally requires
-- kind = 'coach', scope = 'read', created_by = the caller. A BEFORE trigger adds two
-- guarantees the policy cannot: immutability of a token's identity columns after creation,
-- and no un-revoking.
--
-- What does not change: Existing read_write rows may be revoked and keep working until
-- they are (20 live today; canUseTool still gates writes on that scope). Client-minted
-- tokens (ct_client_insert, owner_scope migration) are untouched. The connector sign-in
-- page mints through the service role, which bypasses RLS and is unaffected. The MCP's
-- last_used_at touch (service role, UPDATE) is allowed by the trigger.

-- ── 1. Policies ──────────────────────────────────────────────────────────────────────
drop policy if exists ct_coach_all on public.connector_tokens;

create policy ct_coach_select on public.connector_tokens
  for select to public
  using (tenant_id = current_tenant_id() and current_app_role() = 'coach');

create policy ct_coach_insert on public.connector_tokens
  for insert to public
  with check (
    tenant_id = current_tenant_id()
    and current_app_role() = 'coach'
    and kind = 'coach'
    and scope = 'read'
    and created_by = auth.uid()
  );

create policy ct_coach_update on public.connector_tokens
  for update to public
  using (tenant_id = current_tenant_id() and current_app_role() = 'coach')
  with check (tenant_id = current_tenant_id() and current_app_role() = 'coach');

create policy ct_coach_delete on public.connector_tokens
  for delete to public
  using (tenant_id = current_tenant_id() and current_app_role() = 'coach');

-- ── 2. Trigger: no write-scope coach inserts from the browser; identity immutable ────
create or replace function public.connector_tokens_guard()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $$
begin
  if TG_OP = 'INSERT' then
    -- Belt to the policy's braces: a coach session may only create read tokens. Service
    -- role and the DB owner (SECURITY DEFINER bodies) pass — they mint client tokens.
    if current_user in ('authenticated', 'anon')
       and public.current_app_role() = 'coach'
       and new.scope is distinct from 'read' then
      raise exception 'Coach tokens are read-only. Write scope is not available.' using errcode = '42501';
    end if;
    return new;
  end if;

  -- UPDATE: a token's identity never changes after creation. Only label, last_used_at and
  -- revoked_at may move.
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.created_by is distinct from old.created_by
     or new.kind is distinct from old.kind
     or new.scope is distinct from old.scope
     or new.client_id is distinct from old.client_id
     or new.token_hash is distinct from old.token_hash
     or new.created_at is distinct from old.created_at then
    raise exception 'connector token identity is immutable' using errcode = '42501';
  end if;
  -- A revoked token stays revoked.
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'a revoked connector token cannot be reactivated' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_connector_tokens_guard on public.connector_tokens;
create trigger trg_connector_tokens_guard
  before insert or update on public.connector_tokens
  for each row execute function public.connector_tokens_guard();

comment on function public.connector_tokens_guard() is
  'BEFORE INSERT/UPDATE on connector_tokens. Insert: a coach session (authenticated + coach role) may only create scope=read. Update: id/tenant_id/created_by/kind/scope/client_id/token_hash/created_at are immutable; revoked_at cannot be cleared. Existing read_write rows may be revoked; nothing else about them changes.';
