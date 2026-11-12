-- Add a non-destructive client removal state.
--
-- "Archived" hides a client from active coaching surfaces while retaining their
-- check-ins, messages, programs, notes and compliance history. Hard delete stays
-- available only for clean/test records and may be blocked by retained foreign
-- keys, which is intentional.
alter type public.client_status add value if not exists 'archived';
