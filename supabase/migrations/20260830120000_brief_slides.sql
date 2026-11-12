-- ============================================================================
-- brief_slides — the ordered strip of still images on the Brief tab.
--
-- WHY. The Brief tab (coach front door, mirrored read-only on the client front door)
-- shows one reel via tenant_config.welcome_video_url. The coach asked for slides alongside
-- it (2026-08-30, the original design notes (not included)): uploaded
-- stills, ordered, visible to coach AND clients — a supporting deck for the weekly reel.
--
-- STORAGE DEPENDENCY — the `brand` bucket, which exists in production but in NO
-- migration file (created via dashboard; verified live 2026-08-30: public=true,
-- no size limit, policies brand_coach_read/write/update/delete all scoped to
-- foldername[1] = current_tenant_id() and role coach). Slide images live there under
-- <tenant_id>/brief-slides/. This migration deliberately does NOT create or alter that
-- bucket: codifying dashboard-created objects is a separate, reviewed decision, not a
-- side effect of a feature migration. Marketing-grade content only — the UI and the MCP
-- tool descriptions both say no client PII in slides.
--
-- POSITION. 1..12, same cap and same reasoning as coach_videos_slot_range
-- (20260731060000): a position is a landmark, and past a dozen it stops being one.
-- Unlike coach_videos there is no UNIQUE on (tenant_id, position): reordering is a
-- two-row swap from the browser, which cannot run in one transaction through PostgREST,
-- so a unique constraint would make every swap a three-step temp-slot dance. Render
-- order is (position, created_at, id) — deterministic even mid-swap. The 12-slide COUNT
-- cap is enforced by the app and the MCP tool, not the database; the position range is
-- enforced here.
--
-- RLS mirrors coach_videos exactly: coach full control within tenant, tenant-wide
-- member read (every client of this coach sees the same strip).
--
-- SUSPENSION GUARD attached explicitly — 20260728234500 only looped over tables that
-- existed when it ran; every new tenant-scoped table attaches it itself or silently
-- joins the unguarded list the project notes documents.
--
-- Rollback:
--   drop table public.brief_slides;
--   (storage objects under <tenant>/brief-slides/ in `brand` are cleaned up by hand)
-- ============================================================================

create table if not exists public.brief_slides (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,

  position      integer not null,
  image_path    text not null unique,   -- path in the public `brand` bucket
  caption       text,

  created_at    timestamp with time zone not null default now(),
  updated_at    timestamp with time zone not null default now(),

  constraint brief_slides_position_range check (position between 1 and 12),
  constraint brief_slides_caption_length check (caption is null or char_length(caption) <= 200)
);

create index if not exists brief_slides_tenant_order_idx
  on public.brief_slides (tenant_id, position, created_at);

comment on table public.brief_slides is
  'Ordered still images on the Brief tab (coach front door + client front door). '
  'image_path points into the public brand bucket under <tenant>/brief-slides/. '
  'Marketing-grade content only — never client PII. Count cap of 12 is app/MCP-enforced; '
  'the position range 1..12 is enforced here.';

alter table public.brief_slides enable row level security;

create policy brief_slides_coach_all on public.brief_slides
  for all to authenticated
  using      (tenant_id = public.current_tenant_id() and public.current_app_role() = 'coach')
  with check (tenant_id = public.current_tenant_id() and public.current_app_role() = 'coach');

-- Tenant-wide read: every client of this coach sees the same strip.
-- Mirrors coach_videos_member_read / resources_client_read.
create policy brief_slides_member_read on public.brief_slides
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

drop trigger if exists trg_tenant_suspension_guard on public.brief_slides;
create trigger trg_tenant_suspension_guard
  before insert or update or delete on public.brief_slides
  for each row execute function public.enforce_tenant_not_suspended();
