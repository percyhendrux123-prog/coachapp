// Supabase auth callbacks must stay synchronous. Async callbacks can re-enter the
// auth client while its lock is held and deadlock token/session work. Defer all
// profile/database work to a later task, after the auth notification completes.
export function withTimeout(promise, timeoutMs, label = "operation") {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function authChangeNeedsHydration(event, currentUserId, nextUserId) {
  const sameUser = Boolean(currentUserId && nextUserId && currentUserId === nextUserId);
  return !sameUser || (event !== "TOKEN_REFRESHED" && event !== "SIGNED_IN");
}

export function subscribeToAuthChanges(auth, onSession, schedule = (fn) => setTimeout(fn, 0)) {
  const { data } = auth.onAuthStateChange((event, session) => {
    // getSession() owns initial hydration. Handling INITIAL_SESSION here as well
    // duplicates profile/tenant reads and creates an avoidable startup race.
    if (event === "INITIAL_SESSION") return;
    schedule(() => onSession(session, event));
  });
  return () => data.subscription.unsubscribe();
}
