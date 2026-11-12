// Community feed data layer. RLS: coaches post + manage; the whole tenant reads posts/
// comments/reactions; clients comment + react. Everything is tenant-scoped server-side.
import { supabase } from "./supabase";

export async function listPosts() {
  const { data, error } = await supabase
    .from("community_posts")
    .select("id, body, media_url, pinned, created_at, community_reactions(count), community_comments(count)")
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((p) => ({
    id: p.id, body: p.body, media_url: p.media_url, pinned: p.pinned, created_at: p.created_at,
    reaction_count: p.community_reactions?.[0]?.count ?? 0,
    comment_count: p.community_comments?.[0]?.count ?? 0,
  }));
}

export async function createPost({ tenantId, body }) {
  const { error } = await supabase.from("community_posts").insert({ tenant_id: tenantId, body });
  if (error) throw error;
}

export async function listComments(postId) {
  const { data, error } = await supabase
    .from("community_comments")
    .select("id, body, author_role, created_at")
    .eq("post_id", postId)
    .order("created_at");
  if (error) throw error;
  return data ?? [];
}

export async function addComment({ postId, tenantId, clientId, role, body }) {
  const row = { post_id: postId, tenant_id: tenantId, body, author_role: role };
  if (role === "client") row.client_id = clientId;
  const { error } = await supabase.from("community_comments").insert(row);
  if (error) throw error;
}

export async function getMyReaction(postId, clientId) {
  if (!clientId) return false;
  const { data } = await supabase
    .from("community_reactions").select("post_id")
    .eq("post_id", postId).eq("client_id", clientId).maybeSingle();
  return !!data;
}

export async function toggleReaction({ postId, tenantId, clientId, on }) {
  if (on) {
    const { error } = await supabase.from("community_reactions")
      .delete().eq("post_id", postId).eq("client_id", clientId);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("community_reactions")
      .insert({ post_id: postId, tenant_id: tenantId, client_id: clientId });
    if (error) throw error;
  }
}
