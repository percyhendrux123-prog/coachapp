import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { getTenantBranding } from "../lib/license";
import { CoachTabs } from "../components/CoachTabs";
import AboutPage from "../components/AboutPage";

// Coach-facing About: a live preview of exactly what clients see on their About tab,
// with a pointer to Settings (the editing surface stays in one place).
export default function CoachAbout() {
  const { user, role } = useAuth();
  const [branding, setBranding] = useState(null);

  useEffect(() => {
    if (role !== "coach") return;
    getTenantBranding().then(setBranding).catch(() => {});
  }, [role]);

  if (!user || role !== "coach") {
    return <main className="mx-auto max-w-2xl px-5 py-20 text-sm opacity-70">This area is for coaches.</main>;
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <CoachTabs active="about" />
      <div className="mt-6 flex items-end justify-between gap-4">
        <h1 className="display text-3xl">About</h1>
        <Link to="/coach/settings" className="text-sm underline opacity-60 transition hover:opacity-100">
          Edit in Settings
        </Link>
      </div>
      <p className="mt-1 text-xs opacity-50">This is exactly what your clients see on their About tab.</p>
      <AboutPage
        branding={branding}
        emptyHint="Nothing here yet. Open Settings → What they see. Type the About fields. Save."
      />
    </main>
  );
}
