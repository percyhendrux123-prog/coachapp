-- Add sms_opted_out_at column for TCPA-compliance trail.
-- G6 (2026-08-09): keep sms_consent_at as the consent proof; record
-- opt-out separately to preserve the original consent timestamp.
ALTER TABLE public.clients ADD COLUMN sms_opted_out_at timestamp with time zone;