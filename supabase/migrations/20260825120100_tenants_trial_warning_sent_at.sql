-- A trial counts down to a known deadline (tenants.trial_ends_at), unlike the
-- payment-grace clock (which counts up from "first noticed bad" through 4
-- staged notices). Reusing tenant_payment_grace's stage machinery for a
-- fundamentally different shape (a fixed deadline, one warning + one cutoff)
-- would force-fit two different mechanisms into one table. Simpler: one
-- column, so a run knows whether the single "N days left" warning already
-- went out, without re-sending it every day until the deadline.
alter table public.tenants
  add column if not exists trial_warning_sent_at timestamptz;
