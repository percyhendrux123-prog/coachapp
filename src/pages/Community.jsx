import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useEffect, useState } from "react";
import AppGate from "../components/AppGate";
import { getTenantBranding } from "../lib/license";
import { CoachTabs } from "../components/CoachTabs";
import CommunityHub from "../components/CommunityHub";

// Coach route. Clients hitting /community land on the in-shell Community tab.
export default function Community() {
  const { user, role, profile } = useAuth();
  const [brand, setBrand] = useState(null);

  useEffect(() => {
    if (role !== "coach") return;
    getTenantBranding().then(setBrand).catch(() => {});
  }, [role]);

  if (!user) {
    return (
      <AppGate title="Sign in to see your community" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        Posts for your coaching group live here.
      </AppGate>
    );
  }
  if (role === "client") {
    return <Navigate to="/client?tab=community" replace />;
  }
  if (role !== "coach") {
    return (
      <AppGate title="Community is for members" actionTo="/login" actionLabel="Sign in" secondaryTo="/" secondaryLabel="Home">
        Only coaches and clients in this workspace can open Community.
      </AppGate>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-5 py-10">
      <CoachTabs active="community" />
      <div className="mt-6">
        <CommunityHub ctx={{ tenantId: profile?.tenant_id, clientId: null, role: "coach" }} brand={brand} />
      </div>
    </main>
  );
}
