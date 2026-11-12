import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Surface a clear error in dev rather than a cryptic runtime failure.
  console.error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — copy .env.example to .env.local");
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: "coachapp-auth",
  },
});

// Dev-only handle for debugging in the browser console (never present in prod builds).
if (import.meta.env.DEV && typeof window !== "undefined") window.__sb = supabase;

// Base for invoking edge functions (challenge-enroll, challenge-log, challenge-day-close).
export const functionsBase = `${url}/functions/v1`;
