-- ============================================================================
-- Retirement paths for coach notes and programs.
--
-- WHY. The coach's live roster session (2026-08-26) hit a program library with
-- duplicate and stale entries per client and no way to clean it up. Nothing
-- retires a program, and nothing retires a note. The only "cleanup" available
-- was DELETE, and deleting a program is not a cleanup — assignments.program_id
-- is ON DELETE CASCADE (see the production baseline), so deleting a program
-- with any assignment history silently takes those assignment rows with it and
-- orphans the client's logged workout history behind them.
--
-- ADDITIVE ONLY. Two nullable timestamp columns. No existing row changes
-- meaning: archived_at IS NULL is the state every current row is already in,
-- and every existing query that does not mention archived_at keeps returning
-- exactly what it returns today. Nothing is hidden from an existing surface by
-- this migration alone.
--
-- Rollback:
--   alter table public.client_notes drop column archived_at;
--   alter table public.programs     drop column archived_at;
-- ============================================================================

alter table public.client_notes
  add column if not exists archived_at timestamp with time zone;

comment on column public.client_notes.archived_at is
  'Set when a coach archives a note. Soft hide, never a delete — a note is a '
  'record of what the coach observed and when, and that record is worth more '
  'than a tidy list. NULL means active.';

alter table public.programs
  add column if not exists archived_at timestamp with time zone;

comment on column public.programs.archived_at is
  'Set when a coach retires a program from the library. The program, its '
  'structure uuids, and every assignment and workout log anchored to them stay '
  'intact — an archived program still resolves for a client mid-cycle and still '
  'names itself correctly in that client program history. NULL means active.';

-- Partial indexes: every default listing filters archived_at is null, and that
-- is the only shape these need to serve.
create index if not exists client_notes_active_idx
  on public.client_notes (tenant_id, client_id, created_at desc)
  where archived_at is null;

create index if not exists programs_active_idx
  on public.programs (tenant_id, created_at desc)
  where archived_at is null;
