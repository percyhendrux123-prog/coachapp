# What it costs to run

The app itself is free (MIT license). Running it uses your own accounts on two services, plus a
third if you want payments. All three are paid companies with free plans. This page says what
the free plans include and where you would start to pay.

**Read from each company's own pricing page on 12 November 2026.** Prices and limits change.
Before you rely on a number here, open the page linked in each section and check it.

This page only describes the three companies' own plans. It is not an offer of hosting or
support, and you pay those companies directly, not the authors of this app.

## Netlify (the web host)

Pricing page: https://www.netlify.com/pricing/

**Free plan: $0 a month, 300 credits a month.** Everything the app uses on Netlify is metered in
credits:

| What uses credits | Credits |
| --- | --- |
| Each production deploy | 15 |
| Bandwidth (data sent to visitors) | 20 per GB |
| Web requests | 2 per 10,000 requests |
| Compute (server functions) | 10 per GB-hour |

What that means for this app:

- **Deploys are the big one.** Every change to your copy on GitHub makes a production deploy, so
  20 deploys in a month would use all 300 credits on their own. Setting up and then leaving the
  app alone uses very few.
- **Bandwidth is small.** The whole built app is about 5 MB, 2.4 MB of which is the welcome video
  a client sees once (measured from this repository's build). Browsers keep most of it after the
  first visit. 300 credits would cover 15 GB if nothing else used them.
- **Client data does not go through Netlify.** Workouts, messages and check-ins go straight
  between the client's phone and Supabase.
- The one Netlify function only runs if you connect an AI assistant (SETUP.md, Optional extras).

**What happens at the limit:** Netlify says the free plan "is always free, with hard monthly limits
that cannot be exceeded or incur any costs." When a site reaches its limit, it is paused until
the next billing cycle; Netlify emails you at 50%, 75% and 100%. If one project goes over, every
project on the account is paused. A paused site means your clients cannot open the app.

**Where it starts to cost:** Netlify lists Personal at $9 a month (1,000 credits) and Pro from
$20 a month (3,000 credits and up). Netlify accounts created before 4 September 2025 may still
be on an older plan; your own team's **Usage & billing** page shows which.

New Netlify sites start private. SETUP.md step 19 makes yours public.

## Supabase (the database, sign-in and server functions)

Pricing page: https://supabase.com/pricing

**Free plan: $0 a month.** It includes:

| | Free plan |
| --- | --- |
| Database size | 500 MB per project |
| File storage (photos, videos, PDFs) | 1 GB, largest single file 50 MB |
| Data sent out (egress) | 5 GB, plus 5 GB cached |
| Monthly active users (people who sign in) | 50,000 |
| Server function calls | 500,000 a month |
| Realtime | 200 connections at once, 2 million messages a month |
| API requests | Unlimited |
| Your own email sender (SMTP) | Included |
| Automatic backups | Not included |
| Support | Community only |

Things to know before you rely on the free plan with paying clients:

- **No automatic backups.** If something goes wrong with the database, the free plan has no copy
  to restore. Supabase's paid plans keep daily backups.
- **Paused after one week of inactivity.** A project nobody uses for a week is paused. One that
  clients open most days stays awake. Supabase's FAQ says you can pause and unpause free
  projects as needed.
- **Two active free projects per account.** You can keep more paused.
- **File storage fills first.** Progress photos, uploaded videos and PDFs share the 1 GB. Text
  (programs, messages, check-ins) is small next to them. Pasting YouTube or Vimeo links instead
  of uploading videos keeps storage free.
- **Supabase branding stays in emails** on the free plan.

**Where it starts to cost:** Supabase lists Pro "from $25 / month" for one project, which raises
the limits (100,000 monthly active users, 8 GB database, 250 GB egress, 100 GB file storage,
daily backups kept for 7 days, email support). Pro has a spend cap on by default, so it does not
bill past the plan unless you turn the cap off.

## Stripe (optional: taking payments in the app)

Pricing page: https://stripe.com/pricing

You only need Stripe if you want clients to pay inside the app. The app works without it, and
**Settings > Pay you** can hold a link to any checkout you already use instead.

Stripe has no monthly fee. As read on 12 November 2026 from a United States connection, its
standard price is **2.9% + 30 cents per successful domestic card payment**, with no setup or
monthly fees. Rates differ by country and payment method; check the page for yours.

## Not covered here

- **An email sender** for clients' sign-in codes (SETUP.md step 27). Several SMTP services have
  free plans; check the one you pick.
- **The AI read of each check-in** (optional). It uses your own Anthropic API key and is billed
  by Anthropic per use.
- **Your own domain name**, if you buy one.
