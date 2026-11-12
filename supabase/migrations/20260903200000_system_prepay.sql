-- Pre-pay health screens for the self-serve plan. Written and read ONLY by system-checkout /
-- system-provision via the service role — RLS on, no policies (same posture as oauth_codes).
-- Why a table and not Stripe metadata: metadata values cap at 500 chars, the answers are
-- stored for the record without trusting the browser later, and "screened but flagged" is a
-- launch metric worth counting (spec §11). The Intake page never reads these back — the buyer
-- answers the health screen again at intake (plan amendment 2, 2026-09-02).
create table if not exists public.system_prepay_screens (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null,
  answers             jsonb not null,
  flagged             boolean not null,
  checkout_session_id text,
  consumed_at         timestamptz,
  created_at          timestamptz not null default now()
);
alter table public.system_prepay_screens enable row level security;
create index if not exists system_prepay_screens_session_idx on public.system_prepay_screens (checkout_session_id);
create index if not exists system_prepay_screens_created_idx on public.system_prepay_screens (created_at);
comment on table public.system_prepay_screens is 'Self-serve plan pre-pay health screens. Service-role only. flagged=true rows never reached Stripe.';
