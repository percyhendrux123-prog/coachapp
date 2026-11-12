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
