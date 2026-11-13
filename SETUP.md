# Set up your own coach app

This page walks you through putting your own copy of the coach app on the internet. You do not
need to know how to code and you do not need a terminal (the black text window programmers use).
Everything happens in your web browser.

Plan for about 45 minutes the first time. Most of that is waiting for pages to finish.

You will use three free services:

- **GitHub** stores the app's files. Think of it as the app's filing cabinet.
- **Supabase** is the database: it keeps your clients, programs and messages, and it handles
  sign-in. It also runs the app's "server functions" (small programs that do things like
  inviting a client).
- **Netlify** is the web host: it puts the app on a web address people can open.

All three have free plans that are enough to start. None of the steps below asks for a card. If a
screen asks you to pick a plan, pick the free one.

**Payments are optional.** The app works without Stripe (a payment service). You only need it if
you want clients to pay inside the app. See "Optional extras" at the end.

Before you start, open a blank note (Notes, Google Docs, anything). You will copy a few things into
it along the way. Keep it private: two of them work like passwords.

---

## Part 1. Accounts

1. Go to **github.com** and create a free account (skip this if you have one).
   You should see your GitHub home page.

2. Go to **supabase.com**, click **Start your project**, and choose **Continue with GitHub**.
   You should see the Supabase dashboard (the main screen of your account).

3. Go to **netlify.com**, click **Sign up**, and choose **GitHub**.
   You should see the Netlify dashboard. If it asks about a team name or plan, type any name and
   pick the free plan.

## Part 2. Make your database

4. In Supabase, click **New project**. If it asks you to create an organization first (a folder
   for your projects), give it any name and pick the **Free** plan.

5. Fill in the new project form:
   - **Project name**: anything, for example `my-coach-app`.
   - **Database password**: click **Generate a password**, then copy it into your note under
     "Database password". You will probably never need it, but keep it.
   - **Region**: the one closest to you and your clients.
   - **Security**: leave the boxes as they are. (Supabase suggests unticking **Automatically
     expose new tables**. Either way works: the setup file in step 9 gives the app the access it
     needs.)

   Click **Create new project**. You should see a page that says the project is being set up.
   Wait until it finishes (one to three minutes).

6. Open the database setup file:
   **https://github.com/percyhendrux123-prog/coachapp/blob/main/supabase/setup/database.sql** and click **Raw** (top right
   of the file). You should see a long page of plain text that starts with
   `-- Coach app database setup`.

7. Select all of that text (Cmd+A on a Mac, Ctrl+A on Windows) and copy it (Cmd+C or Ctrl+C).

8. Back in Supabase, click **SQL Editor** in the left sidebar (the sidebar shows icons; point at
   one to see its name). (SQL is the language databases understand. You do not need to read it.)
   If a box about snippets appears, click **Understood**. Use a new, empty query tab: it often
   opens on one already; if not, click **New query**, or the **+** button next to the open tabs.

9. Click inside the empty editor and paste once (Cmd+V or Ctrl+V). It can take a few seconds to
   appear. The first line should read `-- Coach app database setup`.

10. Click **Run** (top right of the editor, or press Cmd+Enter / Ctrl+Enter).

11. A box called **Potential issues detected** appears. This is normal for a file that builds a
    whole database: Supabase warns about any query that creates or removes tables. Click the
    green button, **Run and enable RLS**. (RLS, row level security, is the rule that each person
    only sees their own data. The file already turns it on for every table; this button only
    double-checks.)

    After a few seconds you should see a small table in the results area with one row:
    **result: Setup complete**. Your database is ready.

    If you see an error instead, nothing was saved and you can try again:
    - "Query is too large to be run via the SQL Editor" usually means the text got pasted twice.
      Click in the editor, select all, delete, and paste once.
    - Any other error usually means the paste got cut off. Go back to step 7 and copy again.
    - "This database is already set up" means it already worked earlier. Move on.

## Part 3. Copy three values from Supabase

12. In Supabase, click **Project Overview** (the house icon at the top of the left sidebar). Under
    your project's name is its address, with a **Copy** button next to it. Copy it (if Copy opens
    a small menu, pick **Project URL**) into your note under "Supabase URL". It looks like
    `https://abcdefghijklmnopqrst.supabase.co`, with nothing after `.co`. (Supabase also shows an
    "API URL" ending in `/rest/v1/`. That one is not the right value here.)

13. Click **Project Settings** (the gear at the bottom of the left sidebar), then **API Keys**.
    The app uses the older style of key: click **View legacy API keys** (on some screens it is a
    tab called **Legacy API Keys**). Copy the key labelled **anon** **public** into your note
    under "Anon key". It is a long text starting with `eyJ`. This key is meant to be public: it
    only lets the app talk to the database under the rules the database enforces.

    Do not copy the **service_role** key here. That one is secret. Keys starting with
    `sb_publishable_` or `sb_secret_` are the newer style and are not the one to copy.

14. Open **supabase.com/dashboard/account/tokens** (your account's Access Tokens page). Click
    **Generate new token** and fill in the form:
    - **Name**: `netlify deploy`.
    - **Expires in**: **Never**. (Netlify uses this token on every update of the app. If it
      expires, updates stop installing the server functions until you make a new token and paste
      it into Netlify under **Site configuration > Environment variables**.)
    - **Resource access**: **Project**. Then pick your organization and your project.
    - **Permissions**: open the box that says **Preset · No access** and pick **Full access**.
      The default, No access, makes a token that cannot install anything.

    Click **Review access**. Supabase marks the token **High risk**; that is expected for a token
    that installs code. Click **Create token**, then copy it into your note under "Access token".
    It starts with `sbp_` and is shown only once.

    What it is: an access token lets another service act on your Supabase project. Netlify uses it
    to install the app's server functions into your project each time the app is updated. Treat it
    like a password.

## Part 4. Put the app online

15. Click this button:

    [Deploy to Netlify](https://app.netlify.com/start/deploy?repository=https://github.com/percyhendrux123-prog/coachapp)

    You should see a Netlify page about deploying the coach app.

16. If Netlify asks to connect to GitHub, click **Connect to GitHub** and allow it. Netlify makes
    your own copy of the app's files in your GitHub account. GitHub may list a permission called
    **Workflow** and, after you click **Authorize**, ask you to confirm it is you (GitHub Mobile, an
    authenticator app or an emailed code). That is normal. You do not need to grant any
    organization listed on that page.

17. Netlify shows a **Repository name** box and three boxes for settings. Keep the suggested
    repository name or type your own (it must not match a repository you already have). Paste from
    your note into the three boxes, which are labelled with what they want:
    - **Supabase Project URL** (VITE_SUPABASE_URL): your Supabase URL.
    - **Supabase anon public key** (VITE_SUPABASE_ANON_KEY): your anon key.
    - **Supabase access token** (SUPABASE_ACCESS_TOKEN): your access token.

    Paste only the value, with no spaces before or after.

18. Click **Save & Deploy** (or **Deploy site**). You should see the deploy running. It takes a
    few minutes. When it finishes, the status says **Published**.

    If it says **Failed**, click the failed deploy and scroll the log to the box marked
    **SETUP PROBLEM**. It says in plain words which value is wrong. Fix it under
    **Site configuration > Environment variables**, then **Deploys > Trigger deploy > Deploy site**.

19. New Netlify sites start **Private**: only you, signed in to Netlify, can open them, and
    everyone else sees a Netlify log-in page. On the project page, click **Make public**. The box
    that opens also lets you change the address; keep **Public** selected and click
    **Make public** again. The project page now says **Public**.

    Copy your site address into your note under "Site address". It looks like
    `https://something-random-123.netlify.app`. (You can change it later under
    **Site configuration > Change site name**, or add your own domain.)

## Part 5. Connect sign-in to your site

Sign-in works by email. Supabase needs to know your site address so the emails point to the
right place.

Supabase's built-in email sender always uses its own standard emails, which hold a **Sign in**
link and no code. The link works: open it in the same browser where your site is open. Once you
connect your own email sender (step 27), you can add the code to the emails (steps 22 and 23).
The code (6 or 8 digits, depending on your project) is what clients need when they use the app
from their Home Screen.

20. In Supabase, click **Authentication** in the left sidebar, then **URL Configuration**.
    Replace **Site URL** with your site address and click **Save**.

21. On the same page, under **Redirect URLs**, click **Add URL**, paste your site address followed
    by `/**` (for example `https://something-random-123.netlify.app/**`), and save.

22. **Do this after step 27.** Until your own email sender is connected, Supabase shows "Set up
    custom SMTP to edit templates" and the template cannot be changed; skip to step 24 and come
    back. In Authentication, open **Emails** (it may be called **Email Templates**). Open the
    **Magic link or OTP** template (older screens: **Magic Link**). In the message body, add this
    line on its own line, then click **Save**:

    ```
    <p>Your sign-in code: <strong>{{ .Token }}</strong></p>
    ```

23. **Also after step 27.** Open the **Confirm signup** template and add the same line, then
    click **Save**. New clients get this email the first time they sign in, so it needs the code
    too.

    Supabase can take a few minutes to start using the changed text. If an email still has a link
    but no code, wait five minutes and send a new code.

## Part 6. Make yourself the coach

24. Open your site address and click **Sign in**. Enter your own email and click
    **Send sign-in code**. Open the email from Supabase and click its **Sign in** link, in the same
    browser. (If the email shows a code instead, enter it in the app and click
    **Open my account**.)

    Use the same email address as your Supabase account. Until you do step 27, Supabase's built-in
    email sender only emails the people on your Supabase team, and only about two emails an hour.

    You should see: "You're signed in, but this email isn't linked as a coach or client yet."
    That is expected. The next step links you.

25. In Supabase, open **SQL Editor** and a new, empty query tab. Paste this, and replace
    `you@example.com` with the email you just signed in with (keep the quote marks):

    ```sql
    insert into public.tenants (slug) values ('owner') on conflict (slug) do nothing;
    insert into public.tenant_config (tenant_id)
      select id from public.tenants where slug = 'owner' on conflict (tenant_id) do nothing;
    insert into public.profiles (user_id, role, tenant_id)
      select u.id, 'coach', t.id from auth.users u, public.tenants t
       where lower(u.email) = lower('you@example.com') and t.slug = 'owner'
    on conflict (user_id) do nothing;
    select email from auth.users u join public.profiles p on p.user_id = u.id where p.role = 'coach';
    ```

    Click **Run**. You should see one row with your email. If you see no rows, the email does not
    match the one you signed in with. Fix it and run again.

26. Go back to your site and reload the page. You should see the coach console. It opens on the
    **Brief** tab, with **Home**, **Clients**, **Inbox** and **More** along the bottom.

## Part 7. Before you invite clients

27. **Connect an email sender.** Supabase's built-in sender is for testing: it only emails
    addresses on your Supabase team, about two emails an hour. Your clients' sign-in codes need
    your own sender. Any email service that offers "SMTP" works; several have free plans (for
    example Brevo, Resend with your own domain, or a Gmail account with an app password). Check
    the service's current free plan before you sign up; none of this needs a card.

    From that service, copy its SMTP **host**, **port**, **username** and **password**, and the
    sender address it lets you send from. In Supabase, open **Authentication > Emails > SMTP
    Settings**, turn on **Enable Custom SMTP**, paste those values, set **Sender name** to your
    business name, and click **Save**. Now do steps 22 and 23 (add the code line to the two
    email templates). Then send yourself a code from the sign-in page to check it arrives with the
    code in it.

    No email sender yet? You can still bring a client in: open the client, click **Read sign-in
    code**, and read them the code on the phone. They enter their email on the sign-in page, tap
    **I already have a code**, and type it.

28. **Close sign-ups (recommended).** In Supabase, open **Authentication > Sign In / Providers**
    and turn off **Allow new users to sign up**, then **Save**. Your invited clients still get in:
    adding a client creates their sign-in, and the app asks Supabase to send them a "Confirm
    signup" email with the code (the template from step 23). Someone without an invite gets no
    code and no account.

    Leave sign-ups on only if you run the public 7-day challenge page or sell coach licenses from
    the app, because those let new people sign themselves up. With sign-ups on, a stranger can
    create an empty sign-in, but they only see the "isn't linked" message: the database shows
    them no coach or client data.

You are done. Next, open **Settings** (under **More**) to set your app name, logo and brand color.
To add a client: **Clients > Add client**, fill in their name and email, **Create client**, then
**Copy invite link** and send the link to them yourself (text or email). They open it, enter their
email, and sign in with the code they receive.

---

## Optional extras

You can add these any time. Each one is separate.

- **Push notifications** (alerts on your phone when a client messages you). Needs a key pair
  called VAPID keys. Ask a developer or an AI assistant to generate them, then set
  `VITE_VAPID_PUBLIC_KEY` in Netlify and `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
  `VAPID_SUBJECT` in Supabase (**Edge Functions > Secrets**). The full list of settings is in
  `.env.example`.
- **AI read of each check-in** (a short summary for you when a client checks in). Set
  `ANTHROPIC_API_KEY` in Supabase **Edge Functions > Secrets**. Without it check-ins work
  exactly the same; there is just no AI read.
- **Email from your own address** (onboarding reminders, digests). Needs a free Resend account:
  set `RESEND_API_KEY` and `EMAIL_FROM` in Supabase **Edge Functions > Secrets**.
- **Reminders and scheduled jobs.** In Supabase **Edge Functions > Secrets**, add `CRON_SECRET`
  set to a long random password you make up. Then run this in the SQL Editor with your own two
  values:

  ```sql
  select vault.create_secret('https://abcdefghijklmnopqrst.supabase.co', 'project_url');
  select vault.create_secret('the same long random password', 'cron_reconcile_bearer');
  ```

  The same two values also turn on push alerts to the coach when a client sends a message.
- **Payments with Stripe.** Create your products and prices in Stripe, then set the
  `STRIPE_*` settings listed in `.env.example` in Supabase **Edge Functions > Secrets**, and add a
  Stripe webhook for `checkout.session.completed` pointing at
  `<your Supabase URL>/functions/v1/stripe-webhook`. A checkout whose price is not set refuses
  with a clear message instead of charging anyone.
- **Connect an AI assistant (such as Claude) to your coaching data.** In Netlify
  **Site configuration > Environment variables**, add `SUPABASE_SERVICE_ROLE_KEY` (the secret
  service_role key from Supabase Project Settings > API Keys), then redeploy. Then create a
  connector token in the coach console on the **AI** tab.
- **Your own domain.** Netlify **Domain management > Add a domain**. After it works, repeat steps
  20 and 21 with the new address and redeploy once, so the server functions learn the new address.

## Keeping it updated

Your copy of the app lives in your GitHub account as its own project, separate from the original.
Updates from the original project do not arrive on their own; bringing them in is a small job for
a developer. Netlify redeploys automatically after any change to your copy on GitHub, and each
production deploy reinstalls the server functions.

Database changes in a new version come as new files in `supabase/migrations/`. Applying them needs
a developer (`supabase db push`), or paste each new file into the SQL Editor in order.

## Stuck?

- Copy the address of this page and paste it into an AI assistant (ChatGPT, Claude or similar)
  together with the exact words you see on screen and the step number. Ask it what to click next.
- Or ask someone to set it up for you. Any web developer can follow this page. Axiom also offers
  setup: deployaxiom.com.
