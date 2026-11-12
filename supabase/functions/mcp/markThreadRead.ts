// Explicit thread acknowledgment for the MCP connector surface.
//
// Contract (2026-08-20): sending a message is a pure append; ONLY this
// explicit mark advances read state. It mirrors the mark_thread_read() RPC
// (supabase/migrations/20260808120000_message_read_at_acknowledgement.sql)
// but with every value explicit, because the edge function runs as service
// role where auth.uid() and current_tenant_id() are null:
//   1. validate the reader identity — the connector token's created_by must
//      be a real coach profile in the token's tenant;
//   2. upsert the per-reader pointer in message_reads (drives coach_inbox()
//      badge counts for that coach);
//   3. stamp messages.read_at on currently-unread client-sender rows in the
//      (tenant, client) thread (drives list_inbox / get_support_queue /
//      rm_* read models).
// Ordering: identity → pointer → stamp. Any failure throws — an explicit
// acknowledgment that did not fully land must never be reported as success.
// Client messages arriving after the mark keep read_at null and sent_at >
// last_read_at, so they correctly remain unread on every surface.

export class MarkThreadReadError extends Error {}

type MarkCtx = {
  tenantId: string;
  kind: "coach" | "client";
  createdBy: string | null;
  // The full connector Ctx carries more fields (tokenId, clientId, scope);
  // this core only needs the three above.
  [extra: string]: unknown;
};

// db is the service-role supabase client (admin()); injected for testability.
export async function markThreadReadCore(
  db: { from: (table: string) => any },
  ctx: MarkCtx,
  clientId: string,
): Promise<{ marked: true; client_id: string; reader_user_id: string; stamped_messages: number }> {
  if (ctx.kind !== "coach")
    throw new MarkThreadReadError("only a coach connection can acknowledge a thread");
  if (!ctx.createdBy)
    throw new MarkThreadReadError("this connector token has no creator identity; cannot record who acknowledged the thread");

  // The reader identity must be a real coach in THIS tenant. A wrong or
  // service uid would write an orphaned message_reads row: coach_inbox()
  // (which joins on the signed-in coach's auth.uid()) would still show the
  // thread as unread even after a "successful" mark.
  const { data: profile, error: pe } = await db.from("profiles")
    .select("user_id, role")
    .eq("user_id", ctx.createdBy)
    .eq("tenant_id", ctx.tenantId)
    .eq("role", "coach")
    .maybeSingle();
  if (pe) throw new MarkThreadReadError(`reader identity check failed: ${pe.message}`);
  if (!profile)
    throw new MarkThreadReadError("the token's creator is not a coach in this workspace; refusing to acknowledge");

  const now = new Date().toISOString();

  // 1) Per-reader pointer (coach_inbox unread badge for this coach).
  const { error: ue } = await db.from("message_reads").upsert(
    { tenant_id: ctx.tenantId, client_id: clientId, reader_user_id: ctx.createdBy, last_read_at: now },
    { onConflict: "tenant_id,client_id,reader_user_id" },
  );
  if (ue) throw new MarkThreadReadError(`failed to advance the read pointer: ${ue.message}`);

  // 2) Aggregate stamp on currently-unread client messages in this thread
  //    (list_inbox / get_support_queue / rm_* read models). read_at IS NULL
  //    filter means inbound arriving after this call stays unread.
  const { data: stamped, error: se } = await db.from("messages")
    .update({ read_at: now })
    .eq("tenant_id", ctx.tenantId)
    .eq("client_id", clientId)
    .eq("sender_role", "client")
    .is("read_at", null)
    .select("id");
  if (se) throw new MarkThreadReadError(`read pointer advanced but stamping read_at failed: ${se.message} — retry mark_thread_read`);

  return { marked: true, client_id: clientId, reader_user_id: ctx.createdBy, stamped_messages: (stamped ?? []).length };
}
