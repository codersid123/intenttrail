import { randomUUID } from "node:crypto";
import { ConstraintsSchema, type Constraints, type MandatePayload } from "@intenttrail/shared";
import type { DB } from "../db/db";
import { sha256, signJws } from "../crypto/jws";
import { getKind, getPrivateJwk } from "../crypto/keys";
import { appendEvent } from "../provenance/log";
import { available, toCents } from "../budget/ledger";
import { attenuationViolations } from "./attenuation";
import { verifyMandateChain } from "./verify";

export type IssueResult = { ok: true; mid: string; jws: string } | { ok: false; reasons: string[] };

const now = () => Math.floor(Date.now() / 1000);

function insertMandate(db: DB, runId: string, p: MandatePayload, jws: string) {
  db.prepare(
    "INSERT INTO mandates (mid, parent_mid, run_id, iss, sub, jws, max_amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(p.mid, p.parentMid, runId, p.iss, p.sub, jws, p.constraints.maxAmount, Date.now());
}

/** The user signs the top-level mandate for the orchestrator agent. */
export async function issueRoot(
  db: DB,
  args: { runId: string; userId: string; agentId: string; constraints: Constraints; task: string }
): Promise<IssueResult> {
  const constraints = ConstraintsSchema.parse(args.constraints);
  if (getKind(db, args.userId) !== "user") return { ok: false, reasons: [`${args.userId} is not a user`] };

  const payload: MandatePayload = {
    mid: randomUUID(),
    parentMid: null,
    iss: args.userId,
    sub: args.agentId,
    constraints,
    task: args.task,
    iat: now(),
    nonce: randomUUID(),
    parentHash: null,
  };
  const jws = await signJws(payload, getPrivateJwk(db, args.userId));

  db.transaction(() => {
    insertMandate(db, args.runId, payload, jws);
    appendEvent(db, args.runId, args.userId, "MANDATE_ISSUED", { mid: payload.mid, sub: payload.sub, constraints, task: args.task });
  })();
  return { ok: true, mid: payload.mid, jws };
}

/** A parent agent delegates a NARROWER mandate to a child agent. */
export async function issueChild(
  db: DB,
  args: { runId: string; parentJws: string; childSub: string; constraints: Constraints; task: string }
): Promise<IssueResult> {
  const requested = ConstraintsSchema.parse(args.constraints);

  const reject = (actor: string, reasons: string[]): IssueResult => {
    appendEvent(db, args.runId, actor, "MANDATE_REJECTED", { childSub: args.childSub, requested, reasons });
    return { ok: false, reasons };
  };

  // 1. The parent itself must be valid (signatures, links, not revoked/expired)
  const chain = await verifyMandateChain(db, args.parentJws);
  if (!chain.ok) return reject("system", [`parent invalid: ${chain.error}`]);
  const parent = chain.chain[0];

  // 2. Child must be narrower on every axis + fit in the parent's remaining budget
  const reasons = attenuationViolations(parent.constraints, requested);
  const avail = available(db, parent.mid);
  if (requested.maxAmount <= parent.constraints.maxAmount && toCents(requested.maxAmount) > toCents(avail)) {
    reasons.push(`maxAmount: ${requested.maxAmount} > parent's remaining budget ${avail}`);
  }
  if (reasons.length) return reject(parent.sub, reasons);

  // 3. Sign with the PARENT's subject key (the agent that holds the parent mandate)
  const payload: MandatePayload = {
    mid: randomUUID(),
    parentMid: parent.mid,
    iss: parent.sub,
    sub: args.childSub,
    constraints: requested,
    task: args.task,
    iat: now(),
    nonce: randomUUID(),
    parentHash: sha256(args.parentJws),
  };
  const jws = await signJws(payload, getPrivateJwk(db, parent.sub));

  // 4. Insert mandate + carve-out atomically (re-check budget inside the transaction)
  const ok = db.transaction(() => {
    if (toCents(requested.maxAmount) > toCents(available(db, parent.mid))) return false;
    insertMandate(db, args.runId, payload, jws);
    db.prepare(
      "INSERT INTO budget_ledger (id, mid, kind, amount, status, ref, created_at) VALUES (?, ?, 'carve_out', ?, 'reserved', ?, ?)"
    ).run(randomUUID(), parent.mid, requested.maxAmount, payload.mid, Date.now());
    appendEvent(db, args.runId, parent.sub, "MANDATE_ISSUED", {
      mid: payload.mid,
      parentMid: parent.mid,
      sub: payload.sub,
      constraints: requested,
      task: args.task,
    });
    return true;
  })();

  if (!ok) return reject(parent.sub, ["parent budget changed while issuing (concurrent carve-out)"]);
  return { ok: true, mid: payload.mid, jws };
}
