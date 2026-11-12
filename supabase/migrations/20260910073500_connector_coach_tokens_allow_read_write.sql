-- Coach-minted connector tokens may be read OR read_write again.
--
-- Why (2026-09-10, the platform owner): The coach AI screen offers "View & take actions", but since
-- 20260904110000_connector_coach_tokens_read_only.sql the database refused it with
-- "Coach tokens are read-only. Write scope is not available." The platform owner needs to mint write
-- tokens for their own agents (for example Claude). The MCP server never stopped honoring
-- read_write coach tokens (canUseTool gates every write tool on that scope, and every
-- write is audit-logged), so the lock only blocked new tokens, not the capability.
--
-- What changes: ct_coach_insert accepts scope in ('read', 'read_write'). The guard trigger's
-- INSERT branch enforces the same set instead of read only.
--
-- What does not change: kind must be 'coach', tenant must match, created_by must be the
-- caller. Token identity stays immutable after creation, revoked tokens stay revoked, client
-- tokens (ct_client_insert, owner-scope trigger) are untouched, and the table CHECK still
-- forbids client + read_write.

-- ── 1. Policy ────────────────────────────────────────────────────────────────────────
drop policy if exists ct_coach_insert on public.connector_tokens;

create policy ct_coach_insert on public.connector_tokens
  for insert to public
  with check (
    tenant_id = current_tenant_id()
    and current_app_role() = 'coach'
    and kind = 'coach'
    and scope in ('read', 'read_write')
    and created_by = auth.uid()
  );

-- ── 2. Trigger: coach sessions mint read or read_write; identity still immutable ─────
create or replace function public.connector_tokens_guard()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $$
begin
  if TG_OP = 'INSERT' then
    -- A coach session may only create coach-kind tokens with a coach scope. Service role
    -- and the DB owner (SECURITY DEFINER bodies) pass — they mint client tokens.
    if current_user in ('authenticated', 'anon')
       and public.current_app_role() = 'coach'
       and new.scope not in ('read', 'read_write') then
      raise exception 'Coach tokens may be read or read_write only.' using errcode = '42501';
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

comment on function public.connector_tokens_guard() is
  'BEFORE INSERT/UPDATE on connector_tokens. Insert: a coach session (authenticated + coach role) may create scope=read or scope=read_write (2026-09-10; read-only 09-04 to 09-10). Update: id/tenant_id/created_by/kind/scope/client_id/token_hash/created_at are immutable; revoked_at cannot be cleared.';
