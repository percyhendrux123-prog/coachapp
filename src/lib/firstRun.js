// First-run after a client confirms their email / claims an invite.
// welcome_seen is client-writable (clients_guard_self_update).
import { supabase } from "./supabase";

export const DEFAULT_WELCOME_VIDEO = "/assets/welcome-onboarding.mp4";

export function isStandaloneApp() {
  if (typeof window === "undefined") return false;
  const nav = window.navigator;
  return Boolean(
    nav.standalone
    || window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches,
  );
}

export function isIosSafari() {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const webkit = /WebKit/.test(ua);
  const other = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/.test(ua);
  return iOS && webkit && !other;
}

export async function markWelcomeSeen(clientId) {
  if (!clientId) throw new Error("No client to mark.");
  const { error } = await supabase
    .from("clients")
    .update({ welcome_seen: true })
    .eq("id", clientId);
  if (error) throw error;
}
