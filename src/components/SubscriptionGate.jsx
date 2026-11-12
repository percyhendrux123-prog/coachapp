import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { openBillingPortal } from "../lib/subscription";

// Wraps the coach area. If the tenant's hosting has lapsed (tenants.status='suspended',
// set by the daily license-reconcile), the whole coach dashboard is replaced by a reactivate
// screen — the leverage to get the coach paying again. Clients are handled separately (banner).
export function CoachGate({ children }) {
  const { role, suspended } = useAuth();
  if (role === "coach" && suspended) return <Reactivate />;
  return children;
}

function Reactivate() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  async function reactivate() {
    setErr(null); setBusy(true);
    try {
      const { portal_url } = await openBillingPortal();
      window.location.assign(portal_url);
    } catch (e) { setErr(e.message); setBusy(false); }
  }
  return (
    <main className="mx-auto max-w-md px-5 py-20 text-center">
      <span className="kicker">Hosting</span>
      <h1 className="display mt-2 text-3xl">Your app is paused</h1>
      <p className="mt-3 text-sm opacity-70">
        Your hosting subscription didn’t go through. Your data is safe and your clients
        can still view their coaching — reactivate to manage your app again.
      </p>
      {err && <p className="mt-3 text-sm text-danger">{err}</p>}
      <button onClick={reactivate} disabled={busy}
        className="btn-primary mt-6 w-full py-3 disabled:opacity-50">
        {busy ? "Opening billing…" : "Reactivate — update payment"}
      </button>
      <p className="mt-2 text-xs opacity-50">Opens Stripe’s secure billing portal.</p>
    </main>
  );
}

// A persistent banner for CLIENTS of a suspended tenant — informs them the app is in read-only
// mode while their coach's hosting is lapsed. (Coaches never see this; they get the full gate.)
export function ReadOnlyBanner() {
  const { role, suspended } = useAuth();
  if (role !== "client" || !suspended) return null;
  return (
    <div className="border-b border-ink/10 bg-ink/[0.06] px-5 py-2 text-center text-xs">
      Your coach’s app is paused — you can view your coaching, but new updates are unavailable right now.
    </div>
  );
}
