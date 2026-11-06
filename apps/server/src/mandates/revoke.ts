import type { DB } from "../db/db";
import { appendEvent } from "../provenance/log";

/** Revoke a mandate. Every descendant becomes invalid too, because all checks walk ancestors. */
export function revokeMandate(db: DB, args: { runId: string; mid: string; by: string; reason?: string }): boolean {
  const info = db.prepare("UPDATE mandates SET revoked_at = ? WHERE mid = ? AND revoked_at IS NULL").run(Date.now(), args.mid);
  if (info.changes === 0) return false; // unknown or already revoked
  appendEvent(db, args.runId, args.by, "MANDATE_REVOKED", { mid: args.mid, reason: args.reason ?? null });
  return true;
}
