-- ---------------------------------------------------------------------------
-- Coach resources library — adds a description field to the existing
-- `resources` table (already RLS-ready for coach writes, see
-- resources_coach_all / resources_client_read from the original schema) and
-- one new storage read policy so a client can read a tenant-wide library file,
-- not just their own per-client nutrition PDF.
--
-- WHY A NEW POLICY, NOT AN EDIT TO res_owner_read. res_owner_read requires a
-- client's path to match their own client_id at foldername[2]. A shared
-- library file has no owning client — it lives at
-- <tenant_id>/library/<resource_id>.pdf — so it needs its own read rule.
-- res_owner_read, res_coach_write, and res_coach_update are untouched: the
-- coach can already write anywhere under <tenant_id>/... (no client_id
-- segment required), which is why only a new SELECT policy is needed here.
-- ---------------------------------------------------------------------------

alter table public.resources add column if not exists description text;

create policy res_library_client_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'resources'
    and (storage.foldername(name))[1] = (current_tenant_id())::text
    and (storage.foldername(name))[2] = 'library'
  );

-- Gap found during live verification (2026-08-26): the `resources` bucket had
-- SELECT/INSERT/UPDATE policies but no DELETE policy at all — nothing needed
-- one before, since the meal-plan PDF path only ever upserts in place, never
-- removes a file. removeResource() in src/lib/resourceLibrary.js does delete
-- a library file, and without this the delete was silently blocked by RLS:
-- the resources row disappeared but the underlying file stayed orphaned.
create policy res_coach_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'resources'
    and current_app_role() = 'coach'
    and (storage.foldername(name))[1] = (current_tenant_id())::text
  );
