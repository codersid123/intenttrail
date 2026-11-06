import type { EventType, ProvenanceEvent } from "@intenttrail/shared";
import type { DB } from "../db/db";
import { sha256 } from "../crypto/jws";

const GENESIS = "GENESIS";

function computeHash(prev: string, actor: string, type: string, data: string, ts: number): string {
  return sha256(`${prev}|${actor}|${type}|${data}|${ts}`);
}

/** Append one event to a run's hash chain. Returns its seq number. */
export function appendEvent(db: DB, runId: string, actor: string, type: EventType, data: unknown): number {
  const last = db
    .prepare("SELECT hash FROM provenance WHERE run_id = ? ORDER BY seq DESC LIMIT 1")
    .get(runId) as { hash: string } | undefined;
  const prev = last?.hash ?? GENESIS;
  const json = JSON.stringify(data);
  const ts = Date.now();
  const hash = computeHash(prev, actor, type, json, ts);
  const info = db
    .prepare("INSERT INTO provenance (run_id, actor, type, data, ts, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(runId, actor, type, json, ts, prev, hash);
  return Number(info.lastInsertRowid);
}

type Row = { seq: number; run_id: string; actor: string; type: string; data: string; ts: number; prev_hash: string; hash: string };

export function getEvents(db: DB, runId: string): ProvenanceEvent[] {
  const rows = db.prepare("SELECT * FROM provenance WHERE run_id = ? ORDER BY seq").all(runId) as Row[];
  return rows.map((r) => ({
    seq: r.seq,
    runId: r.run_id,
    actor: r.actor,
    type: r.type as EventType,
    data: JSON.parse(r.data),
    ts: r.ts,
    prevHash: r.prev_hash,
    hash: r.hash,
  }));
}

export type ChainCheck = { ok: true; count: number } | { ok: false; brokenSeq: number; reason: string };

/** Recompute every hash in order. Reports the FIRST entry that doesn't match. */
export function verifyChain(db: DB, runId: string): ChainCheck {
  const rows = db.prepare("SELECT * FROM provenance WHERE run_id = ? ORDER BY seq").all(runId) as Row[];
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev) {
      return { ok: false, brokenSeq: r.seq, reason: "prev_hash does not link to the previous entry (entry deleted or reordered)" };
    }
    if (computeHash(r.prev_hash, r.actor, r.type, r.data, r.ts) !== r.hash) {
      return { ok: false, brokenSeq: r.seq, reason: "content was edited after it was logged" };
    }
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}
