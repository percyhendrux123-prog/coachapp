-- ============================================================================
-- brief_slides integrity — positions become a database invariant, not an app promise.
--
-- WHY. The 2026-08-30 review of commit d559021 confirmed four related defects in the
-- app-enforced model shipped that morning: (1) delete-then-add manufactures duplicate
-- positions via the clamp-at-12 rule; (2) a swap between two equal positions is a
-- silent no-op, so duplicates are permanently un-reorderable from the UI; (3) the
-- 12-count cap is read-then-insert on every surface, so concurrent adds admit a 13th
-- row; (4) the MCP update tool can write onto an occupied position on demand. All four
-- share one root: position density and the count cap lived in application code that
-- cannot be atomic. This migration moves both invariants into the database while the
-- table is still empty (verified 0 rows in production before writing this).
--
-- THE MODEL AFTER THIS MIGRATION:
--   * INSERT: a BEFORE trigger takes a per-tenant advisory lock, compacts existing
--     positions to dense 1..n, rejects at n >= 12, and ASSIGNS new.position := n+1 —
--     caller-supplied positions on insert are deliberately ignored. No caller can
--     race the cap or create a duplicate.
--   * REORDER: one RPC, set_brief_slide_order(p_ids), renumbers the tenant's full
--     slide set to 1..n atomically in the order given. It requires the FULL set so a
--     partial list can never collide with unlisted rows.
--   * DELETE: leaves a gap (harmless — order is unaffected); the next insert's
--     compaction closes it.
--   * BACKSTOP: a deferrable UNIQUE (tenant_id, position) so any future code path
--     that tries to write a duplicate fails loudly at commit instead of silently
--     rendering by created_at tiebreak.
--
-- The RPC is SECURITY DEFINER (it must renumber rows regardless of the fine-grained
-- RLS evaluation order), so it carries its own authorization: a signed-in caller must
-- be a coach and is pinned to their own tenant (p_tenant is ignored for them); only
-- the service role (the MCP edge function) may name a tenant explicitly. This is the
-- same trust shape as the other definer functions the project notes documents. The tenant
-- suspension guard still applies — it is a row trigger on the table and fires inside
-- the RPC's updates.
--
-- Rollback:
--   drop function if exists public.set_brief_slide_order(uuid[], uuid);
--   drop trigger if exists trg_brief_slides_assign_position on public.brief_slides;
--   drop function if exists public.brief_slides_assign_position();
--   alter table public.brief_slides drop constraint if exists brief_slides_tenant_position_key;
-- ============================================================================

-- Backstop uniqueness. Deferrable so the RPC's single-statement renumber (which
-- transiently passes through duplicate values) is checked once at commit.
alter table public.brief_slides
  add constraint brief_slides_tenant_position_key
  unique (tenant_id, position) deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- INSERT path: compact, enforce the cap, assign the position. The advisory lock
-- serializes concurrent inserts for one tenant without blocking other tenants.
-- Runs as the invoking user: a coach's RLS scope already covers exactly their
-- tenant's rows; the service role sees everything and the tenant_id filter pins it.
-- ---------------------------------------------------------------------------
create or replace function public.brief_slides_assign_position()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('brief_slides:' || new.tenant_id::text, 0));

  update public.brief_slides s
     set position = x.ord
    from (
      select id, row_number() over (order by position, created_at, id) as ord
        from public.brief_slides
       where tenant_id = new.tenant_id
    ) x
   where s.id = x.id
     and s.position is distinct from x.ord;

  select count(*) into v_n from public.brief_slides where tenant_id = new.tenant_id;
  if v_n >= 12 then
    raise exception 'the strip is full at 12 slides — remove one first';
  end if;

  new.position := v_n + 1;
  return new;
end;
$$;

drop trigger if exists trg_brief_slides_assign_position on public.brief_slides;
create trigger trg_brief_slides_assign_position
  before insert on public.brief_slides
  for each row execute function public.brief_slides_assign_position();

-- ---------------------------------------------------------------------------
-- Atomic reorder. Pass every slide id for the tenant, in the desired order.
-- Returns the number of slides renumbered.
-- ---------------------------------------------------------------------------
create or replace function public.set_brief_slide_order(p_ids uuid[], p_tenant uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid;
  v_count   integer;
  v_touched integer;
begin
  if auth.role() = 'service_role' then
    v_tenant := p_tenant;
  else
    if public.current_app_role() is distinct from 'coach' then
      raise exception 'only a coach can reorder slides';
    end if;
    v_tenant := public.current_tenant_id();
  end if;
  if v_tenant is null then
    raise exception 'tenant could not be resolved';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('brief_slides:' || v_tenant::text, 0));

  select count(*) into v_count from public.brief_slides where tenant_id = v_tenant;
  if v_count is distinct from coalesce(array_length(p_ids, 1), 0) then
    raise exception 'pass the full slide order: % slide(s) exist, % id(s) given',
      v_count, coalesce(array_length(p_ids, 1), 0);
  end if;

  update public.brief_slides s
     set position = x.ord,
         updated_at = now()
    from unnest(p_ids) with ordinality as x(id, ord)
   where s.id = x.id
     and s.tenant_id = v_tenant;

  get diagnostics v_touched = row_count;
  if v_touched is distinct from v_count then
    -- A duplicated id, or an id from another tenant: refuse loudly rather than
    -- leave some rows renumbered and others not (the exception rolls it all back).
    raise exception 'slide order rejected: % of % ids matched this tenant''s slides',
      v_touched, v_count;
  end if;
  return v_count;
end;
$$;

comment on function public.set_brief_slide_order(uuid[], uuid) is
  'Atomically renumbers a tenant''s Brief slides to 1..n in the order given. Requires the '
  'full slide set. Coach callers are pinned to their own tenant; only the service role may '
  'pass p_tenant. The deferrable unique constraint is the backstop for any other write path.';
