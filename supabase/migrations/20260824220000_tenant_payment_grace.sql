-- Payment-failure grace tracking for license-reconcile.
--
-- WHY: license-reconcile used to flip a tenant straight to status='suspended' the
-- instant Stripe reported a terminal subscription state (canceled/unpaid/
-- incomplete_expired/paused) — no warning, no notice, in the same run that first
-- detected it. The platform owner (2026-08-24): "the kicking a coach out can't be automatic or
-- sudden. it can't happen or be about to happen without being notified." Decided
-- policy: 3 notices (day 0, day 3, day 7) to the coach AND to the platform owner's ops inbox,
-- then suspend on day 10 if still unresolved — grace for the coach, a hard financial
-- backstop for the platform owner.
--
-- This table is the clock. One row per tenant currently inside a grace window;
-- the row is deleted the moment Stripe reports the tenant healthy again (a clean
-- "resolved" gets a notice of its own from the function, not from this table).

create table if not exists public.tenant_payment_grace (
  tenant_id        uuid primary key references public.tenants(id) on delete cascade,
  bad_status_since timestamptz not null,
  stage            integer     not null default 0 check (stage between 0 and 4),
  -- 0 = row just created, no notice sent yet · 1/2/3 = that notice has been sent
  -- 4 = suspended and the suspension notice has been sent
  last_notice_at   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.tenant_payment_grace is
  'One row per tenant currently inside the payment-failure grace window. Deleted on '
  'resolution. RLS on with no policies: service_role (license-reconcile) only.';

alter table public.tenant_payment_grace enable row level security;

-- ---------------------------------------------------------------------------
-- ROLLBACK:
--
--   drop table if exists public.tenant_payment_grace;
--
-- ---------------------------------------------------------------------------
