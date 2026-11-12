import { useCallback, useEffect, useRef, useState } from "react";

const EMPTY_BRANDING = {
  ownerUserId: null,
  branding: null,
  state: "idle",
};

export function useClientAccountBranding({
  userId,
  role,
  activeTabRef,
  loadBrandingFn,
  onAccountTransition = () => {},
}) {
  const [view, setView] = useState(EMPTY_BRANDING);
  const requestIdRef = useRef(0);
  const previousUserIdRef = useRef(null);
  const observedUserRef = useRef(false);
  const transitionCallbackRef = useRef(onAccountTransition);

  useEffect(() => {
    transitionCallbackRef.current = onAccountTransition;
  }, [onAccountTransition]);

  const reloadBranding = useCallback(() => {
    if (role !== "client" || !userId) return Promise.resolve(null);
    const requestId = ++requestIdRef.current;
    const ownerUserId = userId;
    setView({ ownerUserId, branding: null, state: "loading" });

    return Promise.resolve()
      .then(() => loadBrandingFn({ userId: ownerUserId }))
      .then((branding) => {
        if (requestIdRef.current !== requestId) return branding;
        setView({ ownerUserId, branding, state: "ready" });
        return branding;
      })
      .catch(() => {
        if (requestIdRef.current === requestId) {
          setView({ ownerUserId, branding: null, state: "failed" });
        }
        return null;
      });
  }, [loadBrandingFn, role, userId]);

  useEffect(() => {
    const accountKey = role === "client" && userId ? userId : null;
    const nextUserId = userId || null;
    if (observedUserRef.current && previousUserIdRef.current !== nextUserId) {
      activeTabRef.current = "program";
      transitionCallbackRef.current();
    }
    observedUserRef.current = true;
    previousUserIdRef.current = nextUserId;

    if (!accountKey) {
      requestIdRef.current += 1;
      setView(EMPTY_BRANDING);
      return;
    }

    reloadBranding();
    return () => {
      requestIdRef.current += 1;
    };
  }, [activeTabRef, reloadBranding, role, userId]);

  const current = role === "client" && Boolean(userId) && view.ownerUserId === userId;
  const branding = current ? view.branding : null;
  const brandingState = current ? view.state : role === "client" && userId ? "loading" : "idle";
  return {
    branding,
    brandingState,
    // Fail closed while ownership/config are unresolved. This prevents a new account
    // from inheriting the previous account's messaging gate during hydration.
    messagingOn: current && brandingState === "ready" && branding?.messaging_on !== false,
    reloadBranding,
  };
}
