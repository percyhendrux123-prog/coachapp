// Web Push subscribe / unsubscribe. Public VAPID half only.
// Private key stays in Supabase secrets and is never imported here.
import { supabase } from "./supabase";
import { isStandaloneApp, isIosSafari } from "./firstRun";

export function vapidPublicKey() {
  return (import.meta.env.VITE_VAPID_PUBLIC_KEY || "").trim();
}

export function pushSupport() {
  if (typeof window === "undefined") return { ok: false, reason: "server" };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { ok: false, reason: "unsupported" };
  }
  if (isIosSafari() && !isStandaloneApp()) {
    return { ok: false, reason: "homescreen" };
  }
  if (!vapidPublicKey()) {
    return { ok: false, reason: "no_key" };
  }
  return { ok: true, reason: null };
}

function urlBase64ToUint8Array(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function registerPushWorker() {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

// Device-level half, shared by the client and coach paths: permission → worker → the
// browser's PushSubscription for this device. Storage of that subscription is the
// caller's job (clients.push_subscription for a client; coach_push_subscriptions for a coach).
export async function subscribeThisDevice() {
  const support = pushSupport();
  if (!support.ok) throw new Error(supportMessage(support.reason));

  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Permission was not granted. Check the browser’s site settings.");

  const reg = await registerPushWorker();
  await navigator.serviceWorker.ready;

  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey()),
  });
}

export async function currentDeviceSubscription() {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) || null;
}

// ---- coach (2026-09-04): one row per device in coach_push_subscriptions, RLS-scoped ----
export async function coachPushState({ userId }) {
  const sub = await currentDeviceSubscription();
  if (!sub) return { on: false, endpoint: null };
  const { data, error } = await supabase
    .from("coach_push_subscriptions")
    .select("id")
    .eq("user_id", userId)
    .eq("endpoint", sub.endpoint)
    .is("revoked_at", null)
    .maybeSingle();
  if (error) throw error;
  return { on: !!data, endpoint: sub.endpoint };
}

export async function enableCoachPush({ tenantId, userId }) {
  const sub = await subscribeThisDevice();
  const label = (typeof navigator !== "undefined" ? navigator.userAgent : "").slice(0, 120);
  const { error } = await supabase
    .from("coach_push_subscriptions")
    .upsert(
      { tenant_id: tenantId, user_id: userId, endpoint: sub.endpoint, subscription: sub.toJSON(), label, revoked_at: null },
      { onConflict: "user_id,endpoint" },
    );
  if (error) throw error;
  return { on: true, endpoint: sub.endpoint };
}

export async function disableCoachPush({ userId }) {
  const sub = await currentDeviceSubscription();
  if (sub) {
    const { error } = await supabase
      .from("coach_push_subscriptions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("endpoint", sub.endpoint);
    if (error) throw error;
    try { await sub.unsubscribe(); } catch { /* already gone */ }
  }
  return { on: false, endpoint: null };
}

export async function enablePush(clientId, currentChannels) {
  const sub = await subscribeThisDevice();

  const channels = { ...(currentChannels || {}), push: true, sms: currentChannels?.sms === true };
  const { error } = await supabase
    .from("clients")
    .update({
      notif_enabled: true,
      notif_channels: channels,
      push_subscription: sub.toJSON(),
    })
    .eq("id", clientId);
  if (error) throw error;
  return { subscription: sub.toJSON(), channels };
}

export async function disablePush(clientId, currentChannels) {
  if ("serviceWorker" in navigator) {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    try { await sub?.unsubscribe(); } catch { /* already gone */ }
  }
  const channels = { ...(currentChannels || {}), push: false, sms: currentChannels?.sms === true };
  const stillOn = channels.sms === true;
  const { error } = await supabase
    .from("clients")
    .update({
      notif_enabled: stillOn,
      notif_channels: channels,
      push_subscription: null,
    })
    .eq("id", clientId);
  if (error) throw error;
  return { channels, notif_enabled: stillOn };
}

export function supportMessage(reason) {
  if (reason === "homescreen") {
    return "On iPhone, add this to your Home Screen first, then open it from that icon.";
  }
  if (reason === "unsupported") {
    return "This browser cannot receive push alerts.";
  }
  if (reason === "no_key") {
    return "Push is not configured on this site yet (missing public key).";
  }
  return "Push is not available here.";
}
