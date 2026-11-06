// Orchestrator agent (scripted mode): turns Priya's root mandate into narrower child mandates.
// Live LLM mode (stretch) will replace the fixed budget split with Gemini's reasoning.
import type { Constraints } from "@intenttrail/shared";
import type { DB } from "../db/db";
import { createPrincipal } from "../crypto/keys";
import { issueChild, issueRoot, type IssueResult } from "../mandates/issue";
import { appendEvent } from "../provenance/log";
import { ensureMerchants } from "../merchant/merchant";

export const DEMO = {
  user: "user:priya",
  orchestrator: "agent:orchestrator",
  flightAgent: "agent:flight",
  hotelAgent: "agent:hotel",
  task: "Book a Goa trip, total under $500, refundable hotels only",
} as const;

const inHours = (h: number) => Math.floor(Date.now() / 1000) + h * 3600;

/** Idempotent: creates Priya, the three agents and the merchants (each with its own Ed25519 key). */
export async function ensureDemoPrincipals(db: DB): Promise<void> {
  await createPrincipal(db, DEMO.user, "user");
  for (const a of [DEMO.orchestrator, DEMO.flightAgent, DEMO.hotelAgent]) await createPrincipal(db, a, "agent");
  await ensureMerchants(db);
}

type OkIssue = Extract<IssueResult, { ok: true }>;
export type MandateTree = { root: OkIssue; flight: OkIssue; hotel: OkIssue };

/** Priya → orchestrator ($500) → flight agent ($200) + hotel agent ($300). */
export async function buildMandateTree(db: DB, runId: string): Promise<MandateTree> {
  const expiresAt = inHours(24);
  const rootC: Constraints = { maxAmount: 500, currency: "USD", categories: ["flight", "hotel"], refundableOnly: true, expiresAt };

  const root = await issueRoot(db, { runId, userId: DEMO.user, agentId: DEMO.orchestrator, constraints: rootC, task: DEMO.task });
  if (!root.ok) throw new Error(`root mandate rejected: ${root.reasons.join("; ")}`);

  appendEvent(db, runId, DEMO.orchestrator, "AGENT_DECISION", {
    action: "plan_budget",
    mode: "scripted",
    split: { [DEMO.flightAgent]: 200, [DEMO.hotelAgent]: 300 },
    reasoning:
      "Mumbai→Goa flights cost $85–$210 and 2-night hotels $60–$340, so the hotel agent gets the larger share. " +
      "Priya's refundable-only rule is passed down to both sub-agents.",
  });

  const flight = await issueChild(db, {
    runId,
    parentJws: root.jws,
    childSub: DEMO.flightAgent,
    constraints: { maxAmount: 200, currency: "USD", categories: ["flight"], refundableOnly: true, expiresAt },
    task: "Book a refundable Mumbai → Goa flight",
  });
  const hotel = await issueChild(db, {
    runId,
    parentJws: root.jws,
    childSub: DEMO.hotelAgent,
    constraints: { maxAmount: 300, currency: "USD", categories: ["hotel"], refundableOnly: true, expiresAt },
    task: "Book a refundable hotel in Goa for 2 nights",
  });
  if (!flight.ok) throw new Error(`flight mandate rejected: ${flight.reasons.join("; ")}`);
  if (!hotel.ok) throw new Error(`hotel mandate rejected: ${hotel.reasons.join("; ")}`);
  return { root, flight, hotel };
}
