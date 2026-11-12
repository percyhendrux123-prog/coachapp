import { useEffect, useState, cloneElement, isValidElement } from "react";
import { useAuth } from "../context/AuthContext";
import {
  getTenantConfig, saveTenantConfig, uploadBrandImage,
  normalizePaymentUrl, normalizeHexColor, DEFAULT_BRAND_COLOR,
} from "../lib/settings";
import { THEMES, DEFAULT_THEME_KEY, applyTheme } from "../lib/theme";
import { readableTextOn, accessibleForegroundOn } from "../lib/colorContrast";
import { openBillingPortal } from "../lib/subscription";
import { pushSupport, supportMessage, coachPushState, enableCoachPush, disableCoachPush } from "../lib/push";
import { provisionCoach } from "../lib/adminCoach";
import { CoachTabs } from "../components/CoachTabs";
import VideoLibrarySettings from "../components/VideoLibrarySettings";
import ResourceLibrarySettings from "../components/ResourceLibrarySettings";
import AppGate from "../components/AppGate";
import { isOwnerTenant } from "../lib/tenantIdentity";

const REMINDERS_OFF = { intake: false, invite: false, first_open: false, coach_digest: false };

// Coach settings — the whole white-label surface: identity (name/logo/color/theme),
// client-facing content (welcome + about), client feature flags, and the coach's own
// external payment link. The app never processes coach↔client money — clients are sent
// to that link to pay the coach directly.
export default function CoachSettings() {
  const { user, role, profile, tenant } = useAuth();
  const [f, setF] = useState(null); // form state, keyed by tenant_config column names
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(null); // 'logo' | 'about' while in flight
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(false);
  const set = (k, v) => { setSaved(false); setF((p) => ({ ...p, [k]: v })); };
  const setReminder = (k, v) => { setSaved(false); setF((p) => ({ ...p, onboarding_reminders: { ...p.onboarding_reminders, [k]: v } })); };

  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    if (role !== "coach") return;
    setLoadFailed(false);
    getTenantConfig().then((c) => setF({
      app_name: c?.app_name ?? "",
      coach_display_name: c?.coach_display_name ?? "",
      client_payment_url: c?.client_payment_url ?? "",
      brand_color: c?.brand_color ?? DEFAULT_BRAND_COLOR,
      logo_url: c?.logo_url ?? null,
      theme_key: THEMES[c?.theme_key] ? c.theme_key : DEFAULT_THEME_KEY,
      welcome_message: c?.welcome_message ?? "",
      welcome_video_url: c?.welcome_video_url ?? "",
      about_headline: c?.about_headline ?? "",
      about_body: c?.about_body ?? "",
      about_photo_url: c?.about_photo_url ?? null,
      bio_body: c?.bio_body ?? "",
      bio_photo_url: c?.bio_photo_url ?? null,
      framework_name: c?.framework_name ?? "",
      framework_body: c?.framework_body ?? "",
      framework_media_url: c?.framework_media_url ?? "",
      messaging_on: c?.messaging_on ?? true,
      progress_weight_on: c?.progress_weight_on ?? true,
      progress_photos_on: c?.progress_photos_on ?? true,
      // Slice 2 reminders. Default OFF and no sender — nothing automated leaves until the
      // coach sets both here. A missing key reads as off.
      sender_email: c?.sender_email ?? "",
      onboarding_reminders: { ...REMINDERS_OFF, ...(c?.onboarding_reminders || {}) },
    })).catch((e) => { setErr(e.message); setLoadFailed(true); });
  }, [role]);

  if (!user) {
    return (
      <AppGate title="Sign in to open settings" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        Branding, features, and payment link live here for coaches.
      </AppGate>
    );
  }
  if (role !== "coach") {
    return (
      <AppGate title="Coach area only" actionTo="/client" actionLabel="Client home" secondaryTo="/" secondaryLabel="Home">
        Settings are for coaches.
      </AppGate>
    );
  }

  async function upload(kind, file) {
    if (!file) return;
    setErr(null); setUploading(kind);
    try {
      const url = await uploadBrandImage({ tenantId: profile.tenant_id, file, kind });
      set({ logo: "logo_url", about: "about_photo_url", bio: "bio_photo_url" }[kind], url);
    } catch (e) { setErr(e.message); } finally { setUploading(null); }
  }

  async function save(e) {
    e.preventDefault();
    setErr(null); setSaved(false);
    const pay = normalizePaymentUrl(f.client_payment_url);
    if (!pay.ok) return setErr(pay.error);
    const color = normalizeHexColor(f.brand_color);
    setBusy(true);
    try {
      await saveTenantConfig({
        tenantId: profile.tenant_id,
        app_name: f.app_name.trim() || "My Coaching App",
        coach_display_name: f.coach_display_name.trim() || "Coach",
        client_payment_url: pay.value,
        brand_color: color,
        logo_url: f.logo_url || null,
        theme_key: f.theme_key,
        welcome_message: f.welcome_message.trim() || null,
        welcome_video_url: f.welcome_video_url.trim() || null,
        about_headline: f.about_headline.trim() || null,
        about_body: f.about_body.trim() || null,
        about_photo_url: f.about_photo_url || null,
        bio_body: f.bio_body.trim() || null,
        bio_photo_url: f.bio_photo_url || null,
        framework_name: f.framework_name.trim() || null,
        framework_body: f.framework_body.trim() || null,
        framework_media_url: f.framework_media_url.trim() || null,
        messaging_on: !!f.messaging_on,
        progress_weight_on: !!f.progress_weight_on,
        progress_photos_on: !!f.progress_photos_on,
        sender_email: f.sender_email.trim().toLowerCase() || null,
        onboarding_reminders: {
          intake: !!f.onboarding_reminders.intake,
          invite: !!f.onboarding_reminders.invite,
          first_open: !!f.onboarding_reminders.first_open,
          coach_digest: !!f.onboarding_reminders.coach_digest,
        },
      });
      setF((p) => ({ ...p, client_payment_url: pay.value ?? "", brand_color: color }));
      // Reflect accent + theme immediately across the app without a reload. The neutral
      // default color unsets the var (same rule as the Nav load) so brand follows ink —
      // including ink's dark-mode flip.
      if (color !== DEFAULT_BRAND_COLOR) {
        document.documentElement.style.setProperty("--brand-color", color);
        document.documentElement.style.setProperty("--brand-text", readableTextOn(color) || "#fafafa");
        document.documentElement.style.setProperty("--brand-fg-light", accessibleForegroundOn(color, "#fafafa"));
        document.documentElement.style.setProperty("--brand-fg-dark", accessibleForegroundOn(color, "#0d0d0d"));
      } else {
        document.documentElement.style.removeProperty("--brand-color");
        document.documentElement.style.removeProperty("--brand-text");
        document.documentElement.style.removeProperty("--brand-fg-light");
        document.documentElement.style.removeProperty("--brand-fg-dark");
      }
      applyTheme(f.theme_key);
      setSaved(true);
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <CoachTabs active="settings" />
      <span className="kicker mt-6 block">Your app</span>
      <h1 className="display mt-1 text-3xl">Settings</h1>
      <p className="mt-2 max-w-[46ch] text-sm opacity-60">
        Type, upload, Save. This is how you brand the app for your clients. No AI required.
      </p>

      {!f ? (
        loadFailed ? (
          <p className="mt-5 rounded-xl border border-dashed border-danger/40 bg-danger/5 px-3 py-3 text-sm text-danger">
            Could not load settings — failed read, not a blank form. {err}
          </p>
        ) : (
          <p className="mt-5 text-sm opacity-60">Loading…</p>
        )
      ) : (
        <form onSubmit={save} className="mt-6 space-y-8">
          <nav className="no-scrollbar flex gap-2 overflow-x-auto text-xs font-semibold" aria-label="Settings sections">
            {[
              ["set-branding", "Branding"],
              ["set-content", "What they see"],
              ["set-features", "Switches"],
              ["set-reminders", "Reminders"],
              ["set-pay", "Pay you"],
              ["set-notifications", "Notifications"],
              ["set-billing", "Billing"],
              ...(isOwnerTenant(tenant) ? [["set-add-coach", "Add coach"]] : []),
              ["set-videos", "Videos"],
            ].map(([href, label]) => (
              <a key={href} href={`#${href}`} className="shrink-0 rounded-full border border-ink/15 px-3 py-2 min-h-[44px] inline-flex items-center">
                {label}
              </a>
            ))}
          </nav>

          {f && (
            <div className="glass flex items-center gap-3 p-4">
              {f.logo_url
                ? <img src={f.logo_url} alt="" className="h-12 w-12 rounded-xl border border-ink/10 object-cover" />
                : <span className="grid h-12 w-12 place-items-center rounded-xl bg-ink/5 text-xs font-bold">LOGO</span>}
              <div className="min-w-0">
                <p className="display text-lg truncate">{f.app_name || "App name"}</p>
                <p className="mt-0.5 text-xs opacity-55">{f.coach_display_name || "Your name"} · clients see this on Train</p>
              </div>
              <span className="ml-auto h-8 w-8 shrink-0 rounded-full border border-ink/10" style={{ background: f.brand_color }} />
            </div>
          )}

          <Section id="set-branding" title="Branding" kicker="Name · logo · color">
            <Field label="App name" hint="Clients see this as the kicker on Train (top of their app).">
              <input value={f.app_name} onChange={(e) => set("app_name", e.target.value)}
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>

            <Field label="Your display name" hint="Signed under the welcome note, and on About.">
              <input value={f.coach_display_name} onChange={(e) => set("coach_display_name", e.target.value)}
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>

            <Field label="Logo" hint="Square works best — shown next to your app name in the menu bar.">
              <div className="flex items-center gap-3">
                {f.logo_url && <img src={f.logo_url} alt="logo" className="h-9 w-9 rounded object-cover border border-ink/10" />}
                <label className="cursor-pointer rounded-md border border-ink/15 px-3 py-1.5 text-xs hover:bg-ink/[0.03]">
                  {uploading === "logo" ? "Uploading…" : f.logo_url ? "Replace logo" : "Upload logo"}
                  <input type="file" accept="image/*" className="hidden"
                    onChange={(e) => upload("logo", e.target.files?.[0])} />
                </label>
                {f.logo_url && (
                  <button type="button" onClick={() => set("logo_url", null)}
                    className="text-xs underline opacity-60 hover:opacity-100">Remove</button>
                )}
              </div>
            </Field>

            <Field label="Brand color" hint="Your accent color — used on primary buttons and the active menu tab across your app.">
              <div className="flex items-center gap-3">
                <input type="color" value={f.brand_color} onChange={(e) => set("brand_color", e.target.value)}
                  aria-label="Brand color" className="h-9 w-14 cursor-pointer rounded-md border border-ink/15 bg-paper p-0.5" />
                <span className="font-mono text-sm uppercase">{f.brand_color}</span>
                {f.brand_color.toLowerCase() !== DEFAULT_BRAND_COLOR && (
                  <button type="button" onClick={() => set("brand_color", DEFAULT_BRAND_COLOR)}
                    className="text-xs underline opacity-60 hover:opacity-100">Reset to default</button>
                )}
              </div>
            </Field>

            <Field
              label="Look & theme"
              hint="Applies live when you tap a option — Save stores it for you and your clients. Dark mode (top bar) still stacks on top."
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.entries(THEMES).map(([key, t]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      set("theme_key", key);
                      // Live preview so the change is obvious before Save.
                      applyTheme(key);
                    }}
                    className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-xs transition ${
                      f.theme_key === key ? "border-brand bg-brand/5" : "border-ink/15 opacity-80 hover:opacity-100"
                    }`}
                  >
                    <span
                      className="mt-0.5 h-8 w-8 shrink-0 rounded-lg border border-ink/15"
                      style={{
                        background: `linear-gradient(135deg, rgb(${t.light.paper}) 45%, rgb(${t.light.ink}) 45%)`,
                      }}
                    />
                    <span>
                      <span className="block font-semibold">{t.label}</span>
                      {t.blurb && <span className="mt-0.5 block opacity-55">{t.blurb}</span>}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] opacity-50">
                Tip: try <b>Architecture grid</b> or <b>Terminal</b> — those change the shell, not just ink/paper tint.
                Remember to hit Save at the bottom.
              </p>
            </Field>
          </Section>

          <Section id="set-content" title="What they see" kicker="Welcome · About · Method">
            <Field label="Welcome message" hint="The note on Train, under their name. Empty = no card.">
              <textarea value={f.welcome_message} onChange={(e) => set("welcome_message", e.target.value)} rows={2}
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>

            <Field label="Brief video" hint="Paste a YouTube, Vimeo, or .mp4 link. Appears on coach and client Brief. The first-session briefing is built in and does not change here.">
              <input value={f.welcome_video_url} onChange={(e) => set("welcome_video_url", e.target.value)}
                placeholder="https://… or leave blank"
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>

            <Field label="About — headline" hint="Client More → About. Also the coach About preview.">
              <input value={f.about_headline} onChange={(e) => set("about_headline", e.target.value)}
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>

            <Field label="About — body">
              <textarea value={f.about_body} onChange={(e) => set("about_body", e.target.value)} rows={4}
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>

            <Field label="About — photo">
              <div className="flex items-center gap-3">
                {f.about_photo_url && <img src={f.about_photo_url} alt="about" className="h-14 w-14 rounded-lg object-cover border border-ink/10" />}
                <label className="cursor-pointer rounded-md border border-ink/15 px-3 py-1.5 text-xs hover:bg-ink/[0.03]">
                  {uploading === "about" ? "Uploading…" : f.about_photo_url ? "Replace photo" : "Upload photo"}
                  <input type="file" accept="image/*" className="hidden"
                    onChange={(e) => upload("about", e.target.files?.[0])} />
                </label>
                {f.about_photo_url && (
                  <button type="button" onClick={() => set("about_photo_url", null)}
                    className="text-xs underline opacity-60 hover:opacity-100">Remove</button>
                )}
              </div>
            </Field>

            <Field label="Bio" hint="Your background — training history, credentials, story. Shown on your About page.">
              <textarea value={f.bio_body} onChange={(e) => set("bio_body", e.target.value)} rows={4}
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>

            <Field label="Bio — photo">
              <div className="flex items-center gap-3">
                {f.bio_photo_url && <img src={f.bio_photo_url} alt="bio" className="h-14 w-14 rounded-lg object-cover border border-ink/10" />}
                <label className="cursor-pointer rounded-md border border-ink/15 px-3 py-1.5 text-xs hover:bg-ink/[0.03]">
                  {uploading === "bio" ? "Uploading…" : f.bio_photo_url ? "Replace photo" : "Upload photo"}
                  <input type="file" accept="image/*" className="hidden"
                    onChange={(e) => upload("bio", e.target.files?.[0])} />
                </label>
                {f.bio_photo_url && (
                  <button type="button" onClick={() => set("bio_photo_url", null)}
                    className="text-xs underline opacity-60 hover:opacity-100">Remove</button>
                )}
              </div>
            </Field>

            <Field label="Method — name" hint="What you call your coaching framework (e.g. “Daily standards”).">
              <input value={f.framework_name} onChange={(e) => set("framework_name", e.target.value)}
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>

            <Field label="Method — description">
              <textarea value={f.framework_body} onChange={(e) => set("framework_body", e.target.value)} rows={4}
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>

            <Field label="Method — media link" hint="Optional image or video URL (a direct file renders inline; YouTube/Vimeo becomes a link).">
              <input value={f.framework_media_url} onChange={(e) => set("framework_media_url", e.target.value)}
                placeholder="https://…" className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>
          </Section>

          <Section id="set-features" title="Switches" kicker="What the client app shows">
            <Toggle label="Messaging" hint="Clients can message you from their app."
              value={f.messaging_on} onChange={(v) => set("messaging_on", v)} />
            <Toggle label="Weight tracking" hint="Weight field on check-ins plus the weight trend chart."
              value={f.progress_weight_on} onChange={(v) => set("progress_weight_on", v)} />
            <Toggle label="Progress photos" hint="Photo uploads on check-ins (only when your check-in form asks for them)."
              value={f.progress_photos_on} onChange={(v) => set("progress_photos_on", v)} />
          </Section>

          {/* Slice 2 — reminders on onboarding stalls. Every switch defaults OFF and no email
              leaves without a sending address on a domain verified in Resend. The words are
              fixed (approved 2026-09-06); the coach chooses whether they go out, not what they say. */}
          <Section id="set-reminders" title="Reminders" kicker="Automatic, on the stalls">
            <Field label="Sending address"
              hint="Reminders leave from this address and replies come back to it. It must be on a domain verified for sending; leave it empty and reminders are recorded as not sent instead of going out from an address that is not yours.">
              <input type="email" value={f.sender_email} onChange={(e) => set("sender_email", e.target.value)}
                placeholder="you@example.com" autoComplete="off"
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>
            <Toggle label="Intake reminder" hint="Client has an intake link and has not submitted. Day 3, and day 10 (the link stops at 14)."
              value={f.onboarding_reminders.intake} onChange={(v) => setReminder("intake", v)} />
            <Toggle label="Access reminder" hint="Program released, app access sent, not claimed. Day 3, and day 10."
              value={f.onboarding_reminders.invite} onChange={(v) => setReminder("invite", v)} />
            <Toggle label="First-open reminder" hint="Signed in, never opened the program. Day 2. Email, plus a push if they allowed one."
              value={f.onboarding_reminders.first_open} onChange={(v) => setReminder("first_open", v)} />
            <Toggle label="Your daily digest line" hint="What you owe for 3+ days, at the top of the morning digest, plus one push if you have notifications on. Nothing goes to a client."
              value={f.onboarding_reminders.coach_digest} onChange={(v) => setReminder("coach_digest", v)} />
            {f.sender_email.trim() === "" && Object.values(f.onboarding_reminders).some(Boolean) && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                A switch is on with no sending address. Client reminders will be recorded as not sent until one is set. The digest line does not need one.
              </p>
            )}
          </Section>

          <Section id="set-pay" title="Pay you" kicker="Their money never touches this app">
            <Field label="Your payment link"
              hint="Where clients pay YOU directly — a Stripe Payment Link, PayPal.me, Venmo, or any checkout you already use. You keep 100%; the app never touches this money.">
              <input value={f.client_payment_url} onChange={(e) => set("client_payment_url", e.target.value)} placeholder="https://buy.stripe.com/…  ·  paypal.me/…  ·  venmo.com/…"
                className="w-full rounded-lg border border-ink/15 px-3 py-2 text-sm" />
            </Field>
          </Section>

          {err && <p className="text-sm text-danger">{err}</p>}
          {saved && <p className="text-sm text-success">Saved. Clients see it on the next open.</p>}
          <button disabled={busy || uploading} className="btn-primary min-h-[44px] w-full">
            {busy ? "Saving…" : "Save settings"}
          </button>
        </form>
      )}

      {/* Deliberately OUTSIDE the settings form — this isn't a tenant_config field to
          batch-save, it's an action button that fires immediately. Always visible
          (not gated on the "Save settings" state) so it's reachable the moment a
          grace-window warning email lands, not just after a lapsed sub locks the
          coach out into the CoachGate reactivate screen. */}
      {/* Also outside the form: a device-level switch, not a tenant_config field. Fires on
          tap, one row per device in coach_push_subscriptions (2026-09-04). */}
      <div className="mt-8">
        <Section id="set-notifications" title="Notifications" kicker="A buzz when a client moves">
          <CoachPushSwitch />
        </Section>
      </div>

      <div className="mt-8">
        <Section id="set-billing" title="Billing" kicker="Your app hosting">
          <BillingPortalButton />
        </Section>
      </div>

      {/* Platform-admin only, not a coach feature — gated on being the coach of the
          owner tenant specifically, since this app has no separate admin role. The
          real security boundary is server-side (admin-provision-coach checks the
          same thing); this is just so nobody else ever sees the section. */}
      {isOwnerTenant(tenant) && (
        <div className="mt-8">
          <Section id="set-add-coach" title="Add a coach" kicker="Platform admin">
            <AddCoachForm />
          </Section>
        </div>
      )}

      {/* Deliberately OUTSIDE the settings form, for two reasons. It contains
          its own <form> for the paste box (forms cannot nest), and it saves
          each change as it happens rather than waiting on "Save settings" —
          adding a video is an action, not a field. */}
      <div id="set-videos" className="mt-8 scroll-mt-24">
        <VideoLibrarySettings tenantId={profile?.tenant_id} userId={user?.id} />
      </div>

      <div id="set-resources" className="mt-8 scroll-mt-24">
        <ResourceLibrarySettings tenantId={profile?.tenant_id} />
      </div>
    </main>
  );
}

// Coach push, this device only. Mirrors the client's Settings pill so the two surfaces
// read the same. State comes from the browser's own subscription matched against the
// coach's rows — never inferred from a flag alone (Commandment 8: a failed read is not "Off").
function CoachPushSwitch() {
  const { user, profile } = useAuth();
  const support = pushSupport();
  const [state, setState] = useState({ loading: true, on: false, failed: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!user?.id || !support.ok) { setState({ loading: false, on: false, failed: false }); return; }
    let live = true;
    coachPushState({ userId: user.id })
      .then((s) => { if (live) setState({ loading: false, on: s.on, failed: false }); })
      .catch(() => { if (live) setState({ loading: false, on: false, failed: true }); });
    return () => { live = false; };
  }, [user?.id, support.ok]);

  async function toggle() {
    if (!user?.id || !profile?.tenant_id) return;
    setErr(null); setBusy(true);
    try {
      const next = state.on
        ? await disableCoachPush({ userId: user.id })
        : await enableCoachPush({ tenantId: profile.tenant_id, userId: user.id });
      setState({ loading: false, on: next.on, failed: false });
    } catch (e) {
      setErr(e.message || "Could not update alerts.");
    } finally {
      setBusy(false);
    }
  }

  const pill = state.loading ? "…" : state.failed ? "Unknown" : state.on ? "On" : "Off";

  return (
    <div className="glass p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <span className="font-semibold">Push notifications on this device</span>
          <span className="block text-xs opacity-60">
            {support.ok
              ? "A buzz when a client messages you or submits a check-in. Each device you turn this on gets its own."
              : supportMessage(support.reason)}
          </span>
          {state.failed && (
            <span className="block text-xs text-danger">Could not read this device's setting — failed read, not Off.</span>
          )}
        </div>
        {support.ok ? (
          <button
            type="button"
            onClick={toggle}
            disabled={busy || state.loading}
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold min-h-[44px] ${
              state.on ? "bg-ink text-paper" : "border border-ink/15"
            }`}
          >
            {busy ? "…" : pill}
          </button>
        ) : (
          <span className="shrink-0 rounded-full border border-ink/10 bg-ink/[0.03] px-3 py-1 text-xs">Blocked</span>
        )}
      </div>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </div>
  );
}

function BillingPortalButton() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function openPortal() {
    setErr(null); setBusy(true);
    try {
      const { portal_url } = await openBillingPortal();
      window.location.assign(portal_url);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <div>
      <p className="text-sm opacity-60">
        Update your card or manage your hosting subscription — opens Stripe's secure billing portal.
      </p>
      <button type="button" onClick={openPortal} disabled={busy}
        className="btn-primary mt-3 min-h-[44px] px-5 py-2.5 disabled:opacity-50">
        {busy ? "Opening billing…" : "Manage billing"}
      </button>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </div>
  );
}

function AddCoachForm() {
  const [appName, setAppName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [mode, setMode] = useState("trial");
  const [reason, setReason] = useState("");
  const [subscriptionId, setSubscriptionId] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null); // { slug, claim_path }
  const [copied, setCopied] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr(null); setResult(null); setCopied(false);
    if (!appName.trim()) { setErr("App name is required."); return; }
    if (mode === "comped" && !reason.trim()) { setErr("A reason is required for a comped coach."); return; }
    if (mode === "paid" && (!subscriptionId.trim() || !customerId.trim())) {
      setErr("Both the subscription ID and customer ID are required for an already-paying coach.");
      return;
    }
    setBusy(true);
    try {
      const res = await provisionCoach({ appName, displayName, mode, reason, subscriptionId, customerId });
      setResult(res);
      setAppName(""); setDisplayName(""); setReason(""); setSubscriptionId(""); setCustomerId("");
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  const claimUrl = result ? `${window.location.origin}${result.claim_path}` : "";
  async function copyLink() {
    try { await navigator.clipboard.writeText(claimUrl); setCopied(true); } catch { /* clipboard unavailable */ }
  }

  return (
    <div>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="opacity-60">App name *</span>
            <input value={appName} onChange={(e) => setAppName(e.target.value)} required
              className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2" />
          </label>
          <label className="text-sm">
            <span className="opacity-60">Coach display name</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2" />
          </label>
        </div>

        <label className="text-sm">
          <span className="opacity-60">Access</span>
          <select value={mode} onChange={(e) => setMode(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2">
            <option value="trial">Trial — 14 days, no card</option>
            <option value="comped">Comped — no clock, ever</option>
            <option value="paid">Already paying — attach an existing subscription</option>
          </select>
        </label>

        {mode === "comped" && (
          <label className="text-sm">
            <span className="opacity-60">Reason *</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="Why this coach is comped"
              className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2" />
          </label>
        )}

        {mode === "paid" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="opacity-60">Stripe subscription ID *</span>
              <input value={subscriptionId} onChange={(e) => setSubscriptionId(e.target.value)}
                placeholder="sub_…" className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 font-mono text-xs" />
            </label>
            <label className="text-sm">
              <span className="opacity-60">Stripe customer ID *</span>
              <input value={customerId} onChange={(e) => setCustomerId(e.target.value)}
                placeholder="cus_…" className="mt-1 w-full rounded-lg border border-ink/15 px-3 py-2 font-mono text-xs" />
            </label>
          </div>
        )}

        {err && <p className="text-sm text-danger">{err}</p>}
        <button disabled={busy} className="btn-primary min-h-[44px] px-5 py-2.5 disabled:opacity-50">
          {busy ? "Creating…" : "Create coach"}
        </button>
      </form>

      {result && (
        <div className="mt-4 rounded-xl border border-success/30 bg-success/5 p-3 text-sm">
          <p className="font-semibold">Created — <span className="font-mono">{result.slug}</span></p>
          <p className="mt-1 opacity-70">Send them this link to claim their app:</p>
          <div className="mt-2 flex items-center gap-2">
            <input readOnly value={claimUrl} onFocus={(e) => e.target.select()}
              className="w-full rounded-lg border border-ink/15 bg-paper px-3 py-2 font-mono text-xs" />
            <button type="button" onClick={copyLink} className="shrink-0 rounded-lg border border-ink/15 px-3 py-2 text-xs">
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ id, title, kicker, children }) {
  return (
    <section id={id} className="glass scroll-mt-24 p-4">
      {kicker && <span className="kicker">{kicker}</span>}
      <h2 className="section-title mt-1">{title}</h2>
      <div className="mt-3 space-y-5">{children}</div>
    </section>
  );
}

function Field({ label, hint, children, id }) {
  // Prefer an explicit id; otherwise derive a stable one from the label so
  // screen readers associate the visible label with the control (htmlFor).
  const fieldId = id || `settings-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  // Only auto-id a single element child; multi-child Fields (logo + button) keep their own ids.
  const child = isValidElement(children) && children.props?.id == null
    ? cloneElement(children, { id: fieldId })
    : children;
  return (
    <div>
      <label htmlFor={fieldId} className="text-sm font-medium">{label}</label>
      {hint && <p id={`${fieldId}-hint`} className="mb-1.5 mt-0.5 text-xs opacity-60">{hint}</p>}
      {child}
    </div>
  );
}

function Toggle({ label, hint, value, onChange }) {
  const switchId = `toggle-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const labelId = `${switchId}-label`;
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <span id={labelId} className="text-sm font-medium">{label}</span>
        {hint && <p className="mt-0.5 text-xs opacity-60">{hint}</p>}
      </div>
      <button
        type="button"
        id={switchId}
        role="switch"
        aria-checked={value}
        aria-labelledby={labelId}
        onClick={() => onChange(!value)}
        className={`relative mt-0.5 flex h-11 w-14 shrink-0 items-center rounded-full px-0.5 transition-colors ${value ? "bg-brand" : "bg-ink/20"}`}
      >
        <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${value ? "translate-x-7" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}


