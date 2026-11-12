// The same feed renders for the coach (who writes) and the client (who reads).
export function communityCopy(role) {
  return role === "coach"
    ? { intro: "You post. Clients read, react and comment. Reels live on Brief and Videos.",
        empty: "No posts yet. Write the first one above; your clients see it here." }
    : { intro: "Coach posts. You read, react, comment. Reels live on Brief and Videos.",
        empty: "No posts yet. When your coach writes, it lands here." };
}
