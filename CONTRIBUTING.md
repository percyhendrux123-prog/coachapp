# Contributing

Thanks for helping. This project is MIT licensed; anything you contribute is released under the
same license.

## How to propose a change

1. **Open an issue first** for anything larger than a small fix (a typo, a one-line bug). Describe
   the problem and the change you have in mind, so the approach can be agreed before you spend time
   on it.
2. **Fork the repository** and make a branch for your change.
3. **Keep the pull request to one change.** Two unrelated fixes are two pull requests.
4. **Include tests** for any change in behavior, and make sure these pass:

   ```sh
   npm run lint
   npm run build
   npm test               # Node tests
   npm run test:edge      # Deno tests for supabase/functions (needs Deno)
   ```

5. **Open the pull request** with what changed, why, and how you checked it.

## Rules that keep other people's installs safe

- **Database changes go in a new file** in `supabase/migrations/` (timestamp prefix, run in name
  order). Never edit a migration that has already been released: existing installs have run it.
  After adding one, run `node scripts/build-setup-sql.mjs` to regenerate
  `supabase/setup/database.sql`; `npm test` fails if it is out of date or too large for the
  Supabase SQL editor.
- **Server functions** live in `supabase/functions/<name>/`. If a function does its own
  authorization and must be reachable without a signed-in user (webhooks, scheduled jobs, public
  pages), add a `config.toml` with `[verify_jwt]` `enabled = false` next to its `index.ts`. The
  Netlify build reads that file when it installs functions.
- **New settings** go in `.env.example` with a one-line description. Anything prefixed `VITE_` is
  public in the browser bundle; never put a secret there. If a setting is required for a fresh
  install, add it to `[template.environment]` in `netlify.toml` and to SETUP.md.
- **No real data.** Never commit client data, keys or secrets, including in tests and fixtures. Use
  `example.com` addresses and invented names.
- **Keep SETUP.md true.** If your change adds or changes a step a coach has to take, update
  SETUP.md in the same pull request, in plain words.

## Security problems

Do not open a public issue. See [SECURITY.md](SECURITY.md).
