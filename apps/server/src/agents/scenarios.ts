// Demo scenarios A–D (scripted mode: fixed choices, no LLM calls, reliable on the free tier).
// E (revocation) is a Day 5 stretch.
import { randomUUID } from "node:crypto";
import type { FaultCode } from "@intenttrail/shared";
import type { DB } from "../db/db";
import { appendEvent, verifyChain, type ChainCheck } from "../provenance/log";
import { getItem, searchCatalog, signCart } from "../merchant/merchant";
import type { PaymentProvider } from "../paypal/types";
import { buildMandateTree, DEMO, ensureDemoPrincipals } from "./orchestrator";
import { purchase, type FaultInjection, type PurchaseHooks } from "./subagent";

export const SCENARIO_IDS = ["A", "B", "C", "D"] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export type Scenario = {
  id: ScenarioId;
  title: string;
  story: string;
  expectedVerdict: FaultCode;
  itemId: string; // what the hotel agent buys
  reasoning: string; // the agent's (scripted) explanation for its choice
  fault: FaultInjection | null;
  tamperAfterPurchase?: boolean;
};

const B_FAULT: FaultInjection = {
  description: "Hotel agent's mandate check is broken: it never checks refundableOnly.",
  agent: { skipChecks: ["refundableOnly"] },
};

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  A: {
    id: "A",
    title: "User regret",
    story: "Hotel agent books a refundable $250 hotel. Priya disputes anyway.",
    expectedVerdict: "USER_WITHIN_MANDATE",
    itemId: "ht-palm-grove",
    reasoning: "Beachfront, free cancellation, within the $300 hotel budget.",
    fault: null,
  },
  B: {
    id: "B",
    title: "Agent error",
    story: "Hotel agent books a NON-refundable $220 hotel even though Priya said refundable only.",
    expectedVerdict: "AGENT_EXCEEDED_MANDATE",
    itemId: "ht-sunset-bay",
    reasoning: "Good reviews and $30 cheaper than the closest beachfront option.",
    fault: B_FAULT,
  },
  C: {
    id: "C",
    title: "Merchant error",
    story: "The merchant-signed cart says $190, but the merchant captures $215.",
    expectedVerdict: "MERCHANT_CART_MISMATCH",
    itemId: "ht-casa-calangute",
    reasoning: "Cheapest refundable hotel in budget.",
    fault: {
      description:
        "Merchant captures $215 against a $190 signed cart. If PayPal rejects the over-capture, the merchant re-creates " +
        "the PayPal order at $215 instead, and the agent's order-amount check is switched off.",
      merchant: { captureAmount: 215, inflateOrderIfOvercaptureRejected: true },
      agent: { skipOrderAmountCheck: true },
    },
  },
  D: {
    id: "D",
    title: "Tampered log",
    story: "Same purchase as B. Afterwards someone edits the stored evidence so the hotel looks refundable.",
    expectedVerdict: "INSUFFICIENT_EVIDENCE",
    itemId: "ht-sunset-bay",
    reasoning: "Good reviews and $30 cheaper than the closest beachfront option.",
    fault: { ...B_FAULT, description: B_FAULT.description + " After the purchase, the CART_SIGNED log entry is edited to say refundable: true." },
    tamperAfterPurchase: true,
  },
};

export type RunResult = {
  runId: string;
  scenario: ScenarioId;
  title: string;
  expectedVerdict: FaultCode;
  paymentMode: string;
  faultInjection: FaultInjection | null;
  ok: boolean;
  reason?: string;
  transactionId?: string;
  cartTotal?: number;
  capturedAmount?: number;
  paypal?: { orderId: string; authorizationId: string; captureId: string };
  usedInflatedOrderFallback?: boolean;
  tampered?: { seq: number; field: string; from: unknown; to: unknown };
  chain: ChainCheck;
};

export const newRunId = (id: ScenarioId) => `run-${id.toLowerCase()}-${randomUUID().slice(0, 8)}`;

function setRun(db: DB, runId: string, fields: { status?: string; approveUrl?: string | null; result?: RunResult }) {
  db.prepare(
    `UPDATE runs SET status = COALESCE(?, status), approve_url = COALESCE(?, approve_url),
       result = COALESCE(?, result), updated_at = ? WHERE id = ?`,
  ).run(fields.status ?? null, fields.approveUrl ?? null, fields.result ? JSON.stringify(fields.result) : null, Date.now(), runId);
}

/** Runs one scenario end to end. The runs row is created synchronously, so callers can poll it right away. */
export async function runScenario(
  db: DB,
  provider: PaymentProvider,
  id: ScenarioId,
  opts: { runId?: string; hooks?: PurchaseHooks } = {},
): Promise<RunResult> {
  const s = SCENARIOS[id];
  const runId = opts.runId ?? newRunId(id);
  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, scenario, payment_mode, fault_injection, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`,
  ).run(runId, id, provider.label, s.fault ? JSON.stringify(s.fault) : null, now, now);

  const base = { runId, scenario: id, title: s.title, expectedVerdict: s.expectedVerdict, paymentMode: provider.label, faultInjection: s.fault };
  try {
    await ensureDemoPrincipals(db);
    const tree = await buildMandateTree(db, runId);

    // Hotel agent shops (scripted choice)
    const item = getItem(s.itemId);
    const candidates = searchCatalog({ category: "hotel", maxPrice: 300 });
    appendEvent(db, runId, DEMO.hotelAgent, "AGENT_DECISION", {
      action: "select_item",
      mode: "scripted",
      candidates: candidates.map((c) => ({ id: c.id, price: c.price, refundable: c.refundable })),
      chosen: item.id,
      reasoning: s.reasoning,
    });
    const { jws: cartJws } = await signCart(db, { runId, merchantId: item.merchantId, itemIds: [item.id] });

    const p = await purchase(
      {
        db,
        provider,
        runId,
        hooks: {
          onApprovalRequired: (url, orderId) => {
            setRun(db, runId, { status: "awaiting_approval", approveUrl: url });
            opts.hooks?.onApprovalRequired?.(url, orderId);
          },
        },
      },
      { agentId: DEMO.hotelAgent, mandateJws: tree.hotel.jws, cartJws, fault: s.fault },
    );

    const tampered = s.tamperAfterPurchase && p.ok ? tamperCartEvidence(db, runId) : undefined;
    const result: RunResult = p.ok
      ? {
          ...base,
          ok: true,
          transactionId: p.transactionId,
          cartTotal: p.cartTotal,
          capturedAmount: p.capturedAmount,
          paypal: { orderId: p.orderId, authorizationId: p.authorizationId, captureId: p.captureId },
          usedInflatedOrderFallback: p.usedInflatedOrderFallback,
          tampered,
          chain: verifyChain(db, runId),
        }
      : { ...base, ok: false, reason: p.reason, transactionId: p.transactionId, chain: verifyChain(db, runId) };

    setRun(db, runId, { status: result.ok ? "completed" : "failed", result });
    return result;
  } catch (err) {
    const result: RunResult = { ...base, ok: false, reason: err instanceof Error ? err.message : String(err), chain: verifyChain(db, runId) };
    setRun(db, runId, { status: "failed", result });
    return result;
  }
}

/** Scenario D's "attacker": silently edits a past log entry WITHOUT touching hashes,
 *  flipping the hotel to refundable so the agent's fault disappears from the evidence. */
export function tamperCartEvidence(db: DB, runId: string): RunResult["tampered"] {
  const row = db
    .prepare("SELECT seq, data FROM provenance WHERE run_id = ? AND type = 'CART_SIGNED' ORDER BY seq LIMIT 1")
    .get(runId) as { seq: number; data: string } | undefined;
  if (!row) throw new Error(`no CART_SIGNED event in ${runId}`);
  const data = JSON.parse(row.data);
  const from = data.items[0].refundable;
  data.items[0].refundable = true;
  db.prepare("UPDATE provenance SET data = ? WHERE seq = ?").run(JSON.stringify(data), row.seq);
  return { seq: row.seq, field: "items[0].refundable", from, to: true };
}
