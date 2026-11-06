import { MandatePayloadSchema, type MandatePayload } from "@intenttrail/shared";
import type { DB } from "../db/db";
import { decodeJws, sha256, verifyJws } from "../crypto/jws";
import { getKind, getPublicJwk } from "../crypto/keys";

type MandateRow = { mid: string; parent_mid: string | null; jws: string; revoked_at: number | null };

export function getMandateRow(db: DB, mid: string): MandateRow | undefined {
  return db.prepare("SELECT mid, parent_mid, jws, revoked_at FROM mandates WHERE mid = ?").get(mid) as MandateRow | undefined;
}

/** Fast, synchronous check used inside DB transactions:
 *  walks this mandate and ALL ancestors for revocation and expiry. */
export function checkActive(db: DB, mid: string, nowMs = Date.now()): string | null {
  let cur: string | null = mid;
  while (cur) {
    const row = getMandateRow(db, cur);
    if (!row) return `mandate ${cur} not found`;
    if (row.revoked_at !== null) return `mandate ${cur} was revoked`;
    const p = decodeJws<MandatePayload>(row.jws);
    if (p.constraints.expiresAt * 1000 <= nowMs) return `mandate ${cur} has expired`;
    cur = row.parent_mid;
  }
  return null;
}

export type ChainResult =
  | { ok: true; chain: MandatePayload[] } // leaf first, root last
  | { ok: false; error: string };

/** Full check of a mandate chain: signatures, parentHash links, issuer = parent's subject,
 *  root issued by a user, nothing revoked or expired. */
export async function verifyMandateChain(db: DB, jws: string, nowMs = Date.now()): Promise<ChainResult> {
  const chain: MandatePayload[] = [];
  let currentJws: string | null = jws;

  while (currentJws) {
    const parsed = MandatePayloadSchema.safeParse(decodeJws(currentJws));
    if (!parsed.success) return { ok: false, error: "mandate payload is malformed" };
    const p = parsed.data;

    try {
      await verifyJws(currentJws, getPublicJwk(db, p.iss));
    } catch {
      return { ok: false, error: `bad signature on mandate ${p.mid} (claimed issuer ${p.iss})` };
    }

    const row = getMandateRow(db, p.mid);
    if (!row) return { ok: false, error: `mandate ${p.mid} is not registered` };
    if (row.revoked_at !== null) return { ok: false, error: `mandate ${p.mid} was revoked` };
    if (p.constraints.expiresAt * 1000 <= nowMs) return { ok: false, error: `mandate ${p.mid} has expired` };

    chain.push(p);

    if (p.parentMid === null) {
      if (getKind(db, p.iss) !== "user") return { ok: false, error: `root mandate ${p.mid} not issued by a user` };
      currentJws = null;
    } else {
      const parentRow = getMandateRow(db, p.parentMid);
      if (!parentRow) return { ok: false, error: `parent mandate ${p.parentMid} not found` };
      if (sha256(parentRow.jws) !== p.parentHash) return { ok: false, error: `parentHash mismatch on mandate ${p.mid}` };
      const parent = decodeJws<MandatePayload>(parentRow.jws);
      if (parent.sub !== p.iss) return { ok: false, error: `mandate ${p.mid} issued by ${p.iss}, but parent was granted to ${parent.sub}` };
      currentJws = parentRow.jws;
    }
  }
  return { ok: true, chain };
}
