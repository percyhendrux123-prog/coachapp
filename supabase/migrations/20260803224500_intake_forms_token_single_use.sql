-- ============================================================================
-- intake_forms: track when a generate-program token was consumed.
-- ============================================================================
--
-- WHY (WP-12 finding, generate-program)
--
-- generate-program authorizes purely by possession of intake_forms.token --
-- no caller-identity check, by design, matching intake-submit's pre-account
-- pattern. Nothing here lets a stranger GUESS another tenant's token, but a
-- leaked one (screenshot, forwarded link, browser history) stays usable
-- forever: intake_forms.expires_at already exists (30-day default) but
-- generate-program has never read it, and a persisted draft can be
-- re-triggered from the same token indefinitely.
--
-- The coach's ruling: harden the token rather than redesign the flow to require
-- login (this endpoint runs before an account necessarily exists). Two
-- changes, made together:
--
--   1. generate-program now enforces the EXISTING expires_at column.
--   2. This migration adds token_consumed_at, set the moment a token is used
--      to actually PERSIST a draft. A consumed token can no longer persist a
--      second draft. Read-only dry runs (persist:false, which write nothing)
--      stay available until expiry -- they carry no replay risk.
--
-- Verified before writing this: exactly one row exists in intake_forms today,
-- unexpired, zero drafts persisted from it yet. Nothing is retroactively
-- broken by either change.
-- ============================================================================

alter table public.intake_forms
  add column if not exists token_consumed_at timestamp with time zone;

comment on column public.intake_forms.token_consumed_at is
  'Set by generate-program the moment this token is used to persist a program '
  'draft. A consumed token may still be used for a read-only dry run '
  '(persist:false) until expires_at, but may never persist a second draft.';
