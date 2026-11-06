import { randomUUID } from "node:crypto";
import type { DB } from "../db/db";
import { checkActive, getMandateRow } from "../mandates/verify";
import { appendEvent } from "../provenance/log";
import { decodeJws } from "../crypto/jws";
import type { MandatePayload } from "@intenttrail/shared";

// Work in whole cents so 0.1 + 0.2 problems can't happen
export const toCents = (usd: number) => Math.round(usd * 100);
export const toUsd = (cents: number) => cents / 100;

/** available = maxAmount − active carve-outs − reserved/committed spends */
export function available(db: DB, mid: string): number {
  const m = db.prepare("SELECT max_amount FROM mandates WHERE mid = ?").get(mid) as { max_amount: number } | undefined;
  if (!m) throw new Error(`mandate ${mid} not found`);
  const used = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS used FROM budget_ledger
       WHERE mid = ? AND status IN ('reserved', 'committed')`
    )
    .get(mid) as { used: number };
  return toUsd(toCents(m.max_amount) - toCents(used.used));
}

export type ReserveResult = { ok: true; ledgerId: string } | { ok: false; reason: string };

/** Atomically reserve a spend on a (leaf) mandate. All checks + insert happen in ONE transaction. */
export function reserveSpend(db: DB, args: { runId: string; mid: string; amount: number; ref?: string }): ReserveResult {
  const row = getMandateRow(db, args.mid);
  const actor = row ? decodeJws<MandatePayload>(row.jws).sub : "unknown";

  const tx = db.transaction((): ReserveResult => {
    const inactive = checkActive(db, args.mid);
    if (inactive) return { ok: false, reason: inactive };
    const avail = available(db, args.mid);
    if (toCents(args.amount) > toCents(avail)) {
      return { ok: false, reason: `amount $${args.amount} exceeds available $${avail}` };
    }
    const ledgerId = randomUUID();
    db.prepare(
      "INSERT INTO budget_ledger (id, mid, kind, amount, status, ref, created_at) VALUES (?, ?, 'spend', ?, 'reserved', ?, ?)"
    ).run(ledgerId, args.mid, args.amount, args.ref ?? null, Date.now());
    appendEvent(db, args.runId, actor, "BUDGET_RESERVED", { mid: args.mid, amount: args.amount, ledgerId });
    return { ok: true, ledgerId };
  });

  const result = tx();
  if (!result.ok) {
    appendEvent(db, args.runId, actor, "BUDGET_RESERVE_DENIED", { mid: args.mid, amount: args.amount, reason: result.reason });
  }
  return result;
}

/** Called after a successful PayPal capture. */
export function commitSpend(db: DB, ledgerId: string, ref?: string): void {
  db.prepare("UPDATE budget_ledger SET status = 'committed', ref = COALESCE(?, ref) WHERE id = ? AND status = 'reserved'").run(
    ref ?? null,
    ledgerId
  );
}

/** Called after a void or failed payment: gives the money back to the mandate. */
export function releaseSpend(db: DB, runId: string, ledgerId: string, reason: string): void {
  const row = db.prepare("SELECT mid, amount FROM budget_ledger WHERE id = ?").get(ledgerId) as { mid: string; amount: number } | undefined;
  if (!row) throw new Error(`ledger row ${ledgerId} not found`);
  db.prepare("UPDATE budget_ledger SET status = 'released' WHERE id = ? AND status = 'reserved'").run(ledgerId);
  appendEvent(db, runId, "system", "BUDGET_RELEASED", { mid: row.mid, amount: row.amount, ledgerId, reason });
}
