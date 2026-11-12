// System-mode copy twins. Every string a coached client reads that names "your coach" has a
// self-serve twin here. A buyer must never read "your coach hasn't…" — there is no coach, and
// the product says so instead of letting them discover it (spec §4).
import { isSelfServeMode } from "./clientTabs.js";

// Optional booking link. An empty value hides coaching application links.
export const COACHING_APPLICATION_URL = import.meta.env?.VITE_COACHING_APPLICATION_URL?.trim() || "";

export const STANDARD_LINE = "SYSTEM gives you the structure. It won't hold you to it. That's coaching.";

// General nutrition education notice for self-serve users.
export const NUTRITION_SCOPE_LINE =
  "These targets and this meal structure are calculated from the numbers you entered. This is general nutrition education, not medical nutrition therapy. If you have a medical condition, take medication, or are pregnant, get clearance from a physician or registered dietitian before changing how you eat.";

export const COPY = {
  // Intake page (pre-submit). The page cannot know the tenant before submit, so the SYSTEM
  // links carry `&system=1` (system-provision, Update-my-numbers). Coached copy is unchanged.
  intake_intro: {
    coached: "One-time intake so your coach can build structure around your life — about 8–10 minutes.",
    self_serve: "One-time intake. Your week and your targets are built from what you enter — about 8–10 minutes.",
  },
  intake_parq_note: {
    coached: "Yes answers raise a coach review hold before any plan is auto-built.",
    self_serve: "A yes here holds your plan for review instead of building it.",
  },
  intake_meds_label: {
    coached: "Anything medical your coach should know?",
    self_serve: "Anything medical we should know?",
  },
  intake_meds_hint: {
    coached: "Non-empty notes also trigger personal coach review before programming.",
    self_serve: "Non-empty notes also hold your plan for review before it is built.",
  },
  intake_legal_footer: {
    coached: "Questions: contact your coach.",
    self_serve: "Read it before you submit.",
  },
  no_program: {
    coached: "Your coach hasn't assigned a program. Check back after they set one up.",
    self_serve: "No program yet. Finish your intake and your week is built from your numbers.",
  },
  nothing_assigned: {
    coached: "Nothing is assigned yet — that's a coach step, not something you missed.",
    self_serve: "Nothing is built yet. Open Settings → Update my numbers to run your intake.",
  },
  no_program_title_body: {
    coached: "Your coach sets this up. You didn't miss a step — check Nutrition or Check-in if those are ready.",
    self_serve: "Your program is built from your intake. If you have not finished it, open Settings → Update my numbers.",
  },
  checkin_intro: {
    coached: "Your coach reads this every week.",
    self_serve: "This is your record. Connect your AI in Settings to have it read every week.",
  },
  first_run_body: {
    coached: "This is the app {name} coaches from. Watch the short briefing, then put it on your Home Screen if you want alerts.",
    self_serve: "This is your system. Put it on your Home Screen if you want alerts. Start with Program.",
  },
  profile_load_failed: {
    coached: "This is a failed read, not “no program.” Refresh or sign in again. If it keeps happening, message your coach.",
    self_serve: "This is a failed read, not “no program.” Refresh or sign in again. If it keeps happening, reload the app.",
  },
  program_load_failed: {
    coached: "This is a failed read, not “no program.” Refresh or try again. If it keeps happening, message your coach.",
    self_serve: "This is a failed read, not “no program.” Refresh or try again. If it keeps happening, reload the app.",
  },
  nutrition_load_failed: {
    coached: "This is a failed read, not “no plan.” Refresh or try again. If it keeps happening, message your coach.",
    self_serve: "This is a failed read, not “no plan.” Refresh or try again. If it keeps happening, reload the app.",
  },
  schedule_swap_note: {
    coached: "Swap today's day with a later day in this block. Your coach's program doesn't change — only the order you walk through it this block.",
    self_serve: "Swap today's day with a later day in this block. Your program doesn't change — only the order you walk through it this block.",
  },
  schedule_reason_heading: {
    coached: "Worth telling your coach why?",
    self_serve: "Worth noting why?",
  },
  schedule_reason_placeholder: {
    coached: "Anything you want your coach to know",
    self_serve: "Anything you want to remember about this",
  },
  checkin_sent: {
    coached: "Check-in sent — your coach will review it.",
    self_serve: "Check-in saved — it's part of your record.",
  },
  checkin_warning_note: {
    coached: "Let your coach know.",
    self_serve: "Noted in your record.",
  },
  checkin_detail_placeholder: {
    coached: "Tell your coach more",
    self_serve: "Add detail",
  },
  nutrition_empty_prep: {
    coached: "When your coach assigns meals, today's slots and log buttons show here. Not assigned is a coach step, not a miss on your side.",
    self_serve: "Finish your intake and today's slots and log buttons show here.",
  },
  nutrition_empty_lifestyle: {
    coached: "Your coach will assign a nutrition plan when ready. Lifestyle clients track meals differently — no contest meal structures here.",
    self_serve: "Finish your intake to get a nutrition plan built from your numbers. Lifestyle tracking is different from contest meal structures.",
  },
  no_meal_slots: {
    coached: "This plan has no meal slots yet — ask your coach to finish assigning it.",
    self_serve: "This plan has no meal slots yet — try Update my numbers in Settings to rebuild it.",
  },
  meal_slot_unnamed: {
    coached: "Your coach hasn’t named this meal yet",
    self_serve: "This meal has no name yet",
  },
  meal_alternatives_note: {
    coached: "Coach-listed alternatives — not tappable here. Ask your coach if you want a permanent change.",
    self_serve: "Other options from your plan — not tappable here.",
  },
  profile_readonly_note: {
    coached: "Read-only. Ask your coach if something here should change.",
    self_serve: "Read-only. Use Settings → Update my numbers to change this.",
  },
  settings_alerts_intro: {
    coached: "How you hear from your coach. Branding is on the coach side.",
    self_serve: "How you hear from this app.",
  },
  settings_inapp_note: {
    coached: "Everything your coach sends appears in your Activity tab. Always on.",
    self_serve: "Everything from this app appears in your Activity tab. Always on.",
  },
  settings_email_note: {
    coached: "Coming soon — your coach will be able to send summaries and updates here.",
    self_serve: "Coming soon — email summaries and updates will appear here.",
  },
  ai_optin_body: {
    coached: "Optional. Point your own Claude or ChatGPT at your program, history, check-ins and messages. With “read + relay” it can also act for you — message your coach, flag an issue, log sets, finish your day. It can never change your program or nutrition plan.",
    self_serve: "Optional. Point your own Claude or ChatGPT at your program, history and check-ins. Read-only lets it see. Full control lets it log sets, finish your day, rewrite your week, set your targets, swap meals, add your own meals, and rebuild your plan from new numbers. It is your plan. Its food knowledge is its own.",
  },
};

export const copyFor = (mode, key) => {
  const twins = COPY[key];
  if (!twins) throw new Error(`systemMode: unknown copy key ${key}`);
  return isSelfServeMode(mode) ? twins.self_serve : twins.coached;
};

export const isSelfServe = (branding) => isSelfServeMode(branding?.mode);
