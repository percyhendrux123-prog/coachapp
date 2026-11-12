# coachapp

A coaching delivery app for personal trainers and online coaches. Clients get one installed
web app for their program, nutrition, check-ins and messages. The coach gets a ranked view of
what needs a decision, the evidence behind it, and the tools to act on it. One deployment can
host the owner's own coaching business plus white-label tenants for other coaches.

It runs on Supabase (Postgres, auth, storage, edge functions), Netlify (static frontend plus one
function) and, optionally, Stripe, Resend and Web Push. You run it on your own accounts.

## Features

Client app (installable PWA)
- Today view, assigned training program, set-by-set workout logging, exercise substitution requests
- Nutrition: assigned meal plans, meal adherence logging
- Weekly check-ins, body weight and measurements, progress photos
- Messages with the coach, push notifications
- Intake and health screen (PAR-Q) before anything is built
- Resources and coach videos

Coach console
- Home and brief: what needs a decision now, ranked, with the reason shown
- Clients, programs (builder and generator), calendar, inbox, activity ledger
- Meal plan assembly from a meal library with allergen and dietary gates that refuse rather than guess
- Check-in review, with an optional AI-proposed read that never becomes authoritative on its own
- Challenges: public 7-day challenges with daily standards and a sign-up page
- Settings: brand color, logo, app name, check-in cadence, onboarding reminders
- Connect your own AI: an MCP server (about 90 tools, read and read/write scopes, audit logged) with
  OAuth so assistants such as Claude can work with your coaching data. The app hosts no model of its own.

Platform
- Multi-tenant with row level security on every table; white-label tenants per coach
- Optional Stripe flows: coaching checkout, a one-time self-serve plan, white-label licensing with a
  monthly hosting fee and a notice-then-suspend grace policy
- Trainerize export import
- Scheduled jobs for onboarding reminders, license reconciliation and an owner digest

## What is not included

- No content. There is no meal library, no exercise video library, no programs, no educational
  articles. The Content and Knowledge pages are placeholders for your own material.
- No hosted service, no accounts, no data. You bring your own Supabase, Netlify and Stripe accounts.
- No AI model or API key. The optional check-in read generator calls the Anthropic API with your key.
- No legal review. The waiver and health screen text in `src/content/` is a starting point, not
  legal advice. Have it reviewed for your jurisdiction before you use it with clients.

## Get your own copy (no code)

<!-- PUBLISH-TODO: replace PUBLISH-TODO-REPO-URL below and in SETUP.md with the public repo URL,
     for example https://github.com/<owner>/<repo>. The button only works once the repo is public. -->

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=PUBLISH-TODO-REPO-URL)

Three steps: open this page, click the button, follow [SETUP.md](SETUP.md). SETUP.md is written for
someone who has never deployed anything: free Supabase and Netlify accounts, one database file
pasted into the Supabase SQL editor, three values pasted into the button's form. No terminal.

The button asks for:

| Name | What it is |
| --- | --- |
| `VITE_SUPABASE_URL` | Your Supabase Project URL (Project Settings > Data API) |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase anon public key, starts with `eyJ` (Project Settings > API Keys > Legacy API Keys) |
| `SUPABASE_ACCESS_TOKEN` | A Supabase access token, so each production deploy can install the server functions |

On Netlify the build runs `scripts/netlify-build.mjs`: it checks those values and stops with a plain
message if one is wrong, builds the app, writes the site address into `/.well-known/`, and on
production deploys installs every function in `supabase/functions/` with the Supabase CLI and sets
`APP_ORIGIN` / `ALLOWED_ORIGINS`. Set `SKIP_FUNCTION_DEPLOY=1` to deploy functions yourself instead.

## Requirements (developer setup)

- Node.js 20.19+ or 22.12+ and npm
- A Supabase project and the Supabase CLI
- A Netlify site and the Netlify CLI (or any static host plus a place to run the one Netlify function)
- Optional: Stripe, Resend (email), a VAPID key pair (Web Push), Deno (to run the edge function tests)

## Developer setup

1. Install and build locally

   ```sh
   npm ci
   cp .env.example .env      # fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
   npm run dev
   ```

2. Database

   ```sh
   supabase link --project-ref <your-project-ref>
   supabase db push                         # applies supabase/migrations in order
   psql "$DATABASE_URL" -f supabase/seed.sql   # reference vocabulary for intake parsing
   ```

   Without a terminal: paste `supabase/setup/database.sql` into the SQL editor and run it once. It
   is every migration plus the seed in one transaction, and it records the migrations as applied
   so a later `supabase db push` only applies new ones. It is generated; after adding a migration
   run `node scripts/build-setup-sql.mjs` (the test suite fails if you forget).

   `00000000000000_initial_schema.sql` creates the full schema, storage buckets and policies. The
   later files are forward migrations. Then create two vault secrets used by scheduled jobs and the
   coach push trigger (see `.env.example`), and optionally run `supabase/setup/schedule_jobs.sql`.

3. Edge functions

   ```sh
   supabase secrets set APP_ORIGIN=https://app.example.com CRON_SECRET=<random> ...
   supabase functions deploy <name>          # or: SUPABASE_PROJECT_REF=<ref> npm run deploy:fn <name>
   ```

   Every secret is listed in `.env.example`. Functions with a `config.toml` that disables JWT
   verification handle their own authorization.

4. Frontend on Netlify

   Set the `VITE_*` variables and the Netlify function variables from `.env.example` in your site
   settings, then deploy (`netlify deploy --prod --build`, or `npm run deploy:frontend`, which refuses
   to deploy from a dirty git tree). The two files in `public/.well-known/` (OAuth discovery for AI connectors) get the
   site address written in at build time on Netlify; on another host, edit them to your domain.

5. Make yourself the owner

   Sign in once with your email, edit the email in `supabase/setup/bootstrap_owner.sql`, and run it.
   This creates the owner tenant (slug `owner`) and links your account as its coach.

6. Stripe (optional)

   Create your products and prices, set the `STRIPE_PRICE_*` and `STRIPE_PRODUCTS_*` secrets, and
   point a webhook for `checkout.session.completed` at the `stripe-webhook` function. Any checkout
   whose price is not configured refuses with a clear error instead of charging.

## Development

```sh
npm run lint
npm run build
npm test                 # Node tests (frontend, MCP contracts, OAuth function)
npm run test:edge        # Deno tests for the edge functions (needs Deno)
```

Database tests live in `supabase/tests/`. Each runs in one transaction and rolls back:
`psql "$DATABASE_URL" -f supabase/tests/release_client.test.sql`. Run them against a local or
branch database, not one with real clients in it.

## Contributing

Changes are welcome. Open an issue first for anything larger than a small fix, keep each pull
request to one change with tests, and never commit real client data or secrets. The full guide is in
[CONTRIBUTING.md](CONTRIBUTING.md). Security problems: see [SECURITY.md](SECURITY.md).

## License

MIT. See `LICENSE`.
