-- ============================================================================
-- client_documents — signed PAR-Q forms, waivers, IDs, medical notes.
--
-- WHY. The original MCP endpoint spec held this back as an open question:
-- should raw client PII documents transit an AI tool call at all? The coach's answer, verbatim:
-- "Everything should be readable so a coach can operate high caliber as the only human in the
-- loop giving more ownership and control while overhead kept low and output increases." That
-- picks the FULL option, not the restrictive kind-allowlist fallback the spec proposed as a
-- cautious default — every kind (parq, waiver, id, medical, other) is readable through the MCP
-- surface, not just parq + waiver.
--
-- "Everything readable" is a scope decision, not a security exemption. The signed-URL,
-- coach-only, no-raw-bytes discipline this migration applies is unchanged by it — it is the same
-- discipline already applied to progress-photos and resources, and dropping it would not make
-- more things readable, it would just make them readable less safely.
--
-- SCOPE. This is a new bucket and a new table — no existing bucket or table held any of this
-- before now (confirmed by reading 20260728214500_storage_scope_private_files_to_owning_client.sql,
-- which lists progress-photos, resources and meal-photos as the only three buckets that exist).
--
-- BUCKET RLS shape mirrors 20260728214500 exactly: current_tenant_id() + current_client_id() for
-- the owning client, OR current_app_role() = 'coach' for the tenant's coach. Unlike that
-- migration, there is deliberately no client-facing feature reading this bucket today — a client
-- reading back their own uploaded ID is a real, separate product question, not a side effect of
-- this migration. The owner-read policy is written to already be correct WHEN that feature is
-- built, rather than needing a second RLS pass then.
--
-- TABLE RLS is coach-only, no client policy at all (the deny), matching support_tickets and
-- message_templates from 20260826190100 — a coach's note that a client's ID looked altered, or a
-- record of what medical documentation is on file, is not something a client's own token should
-- be able to enumerate.
--
-- THE SUSPENSION GUARD IS ATTACHED HERE, EXPLICITLY, for the same reason 20260826190100 attaches
-- it explicitly: 20260728234500 only looped over tables that existed when it ran, so any new
-- tenant-scoped table must attach trg_tenant_suspension_guard itself or it silently joins the 23
-- tables the project notes already documents as unguarded.
--
-- Rollback:
--   drop table public.client_documents;
--   drop policy if exists client_documents_owner_read  on storage.objects;
--   drop policy if exists client_documents_owner_write on storage.objects;
--   delete from storage.buckets where id = 'client-documents';
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Bucket. Private — these are the most sensitive files this schema will ever hold.
-- 10 MB matches the application-level cap in supabase/functions/mcp/documents.ts
-- (MAX_DOCUMENT_BASE64_CHARS, ~6 MB of real file); the bucket limit is set a little above that
-- so the two never disagree at the boundary in a confusing direction.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-documents',
  'client-documents',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/webp']
)
on conflict (id) do nothing;

-- READ: the owning client, or the tenant's coach. No app feature calls this yet — the MCP tools
-- use the service-role client and bypass RLS entirely — this exists so the policy is already
-- correct the day a client-facing "my documents" view is built, instead of needing this same
-- review done under time pressure then.
create policy client_documents_owner_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'client-documents'
    and (
      (
        (storage.foldername(name))[1] = (current_tenant_id())::text
        and (storage.foldername(name))[2] = (current_client_id())::text
      )
      or (
        current_app_role() = 'coach'
        and (storage.foldername(name))[1] = (current_tenant_id())::text
      )
    )
  );

-- WRITE: coach only. upload_client_document in the MCP surface is coach-only by construction
-- (it lives in COACH_TOOLS, never CLIENT_TOOLS, and toolSurface.test.ts enforces that split) —
-- this policy makes the same true for any future direct app-level upload path, so the guarantee
-- does not depend on every future caller remembering to route through the MCP surface.
create policy client_documents_owner_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'client-documents'
    and current_app_role() = 'coach'
    and (storage.foldername(name))[1] = (current_tenant_id())::text
  );

-- ---------------------------------------------------------------------------
-- Table. One row of metadata per stored file; the bytes live in the bucket above.
-- ---------------------------------------------------------------------------
create table if not exists public.client_documents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  client_id     uuid not null references public.clients(id) on delete cascade,

  kind          text not null,
  title         text,
  filename      text not null,
  storage_path  text not null unique,
  mime_type     text not null,
  size_bytes    integer not null,

  uploaded_by   uuid,
  created_at    timestamp with time zone not null default now(),

  constraint client_documents_kind_check
    check (kind in ('parq', 'waiver', 'id', 'medical', 'other')),
  constraint client_documents_size_check
    check (size_bytes > 0)
);

create index if not exists client_documents_client_idx
  on public.client_documents (tenant_id, client_id, created_at desc);
create index if not exists client_documents_kind_idx
  on public.client_documents (tenant_id, client_id, kind);

comment on table public.client_documents is
  'Metadata for files in the client-documents storage bucket — signed PAR-Q forms, waivers, IDs, '
  'medical notes. storage_path points into that bucket; the MCP surface always returns a '
  'short-lived signed URL, never the path or raw bytes, to any caller.';

-- ---------------------------------------------------------------------------
-- RLS. Coach-only, same shape as support_tickets / message_templates (20260826190100).
-- ---------------------------------------------------------------------------
alter table public.client_documents enable row level security;

create policy client_documents_coach_all on public.client_documents
  for all to authenticated
  using      (tenant_id = public.current_tenant_id() and public.current_app_role() = 'coach')
  with check (tenant_id = public.current_tenant_id() and public.current_app_role() = 'coach');

-- ---------------------------------------------------------------------------
-- Suspension guard — see the header.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_tenant_suspension_guard on public.client_documents;
create trigger trg_tenant_suspension_guard
  before insert or update or delete on public.client_documents
  for each row execute function public.enforce_tenant_not_suspended();
