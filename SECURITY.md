# Security

## Reporting a problem

Please do not open a public issue for a security problem. Use the repository's private
vulnerability reporting (GitHub: Security tab, "Report a vulnerability") and include the steps to
reproduce it. You will get an acknowledgement, and a fix or a decision, as soon as the maintainers
can manage. This is a volunteer project with no bounty.

## Running it safely

- This app stores health information (health screens, medications, injuries, body metrics,
  progress photos). You are responsible for how you collect, store and handle it under the law that
  applies to you.
- Keep the Supabase service role key, Stripe secret key and every other secret in Supabase or
  Netlify secrets only. Only `VITE_*` values belong in the frontend, and only public ones.
- Row level security is enabled on every table. Do not disable it or add broad policies to make
  something work; add a narrow policy or a `security definer` function with an explicit check.
- Connector tokens for AI assistants are stored as hashes. Give an assistant read scope unless it
  needs to write, and revoke tokens you no longer use.
- Run the database tests in `supabase/tests/` against a branch or local database, never one that
  holds real clients.
- The self-serve plan's health screen is self-report and nobody at the app reviews it. A yes on a
  doctor-first question holds the plan until the signed-in person confirms, in the app, that
  their own doctor or licensed health professional cleared them; that confirmation is recorded
  (`health_screen_attestations`) and only the database function `attest_my_health_screen` can
  write it, with the person's own session. No coach, connector token, AI assistant or service key
  can confirm it. A screen with pregnancy, an eating-disorder history, or any answer the table does
  not know never gets a self-serve plan. It is still self-report: the person can answer the
  intake again (a held or not-eligible screen does not start the 28-day re-intake clock), and the
  app cannot know whether the new answers are true. While the latest screen is on hold, the AI
  connector cannot re-answer it.
- The free signup (`system-signup`) never returns the intake link to the browser; it goes by email
  only. It answers the same way for a new address and one that already has a plan, so it cannot
  be used to find out who has an account (response times still differ a little between a new
  and an existing address). Limits: one email per address per 24 hours, 5 tries an hour per
  network address (stored only as a keyed hash), and `SYSTEM_SIGNUP_DAILY_CAP` a day. The
  per-network-address limit reads `cf-connecting-ip`, then `x-real-ip`, then the last
  `x-forwarded-for` entry. That is right on Supabase's hosted edge; on any other host, check which
  header your proxy sets and overwrites before relying on it. `APP_ORIGIN` must be set: the
  email links are built from it, and signup refuses without it.
