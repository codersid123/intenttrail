import type { Constraints } from "@intenttrail/shared";
import { openDb } from "../db/db";
import { createPrincipal } from "../crypto/keys";
import { issueChild, issueRoot } from "../mandates/issue";

export const inHours = (h: number) => Math.floor(Date.now() / 1000) + h * 3600;

export const rootConstraints = (): Constraints => ({
  maxAmount: 500,
  currency: "USD",
  categories: ["flight", "hotel"],
  refundableOnly: true,
  expiresAt: inHours(24),
});

/** Builds the demo tree: Priya → orchestrator ($500) → flight ($200) + hotel ($300). */
export async function buildDemoTree() {
  const db = openDb(":memory:");
  const runId = "run-test";
  await createPrincipal(db, "user:priya", "user");
  for (const a of ["agent:orchestrator", "agent:flight", "agent:hotel", "agent:sneaky"]) await createPrincipal(db, a, "agent");

  const root = await issueRoot(db, {
    runId,
    userId: "user:priya",
    agentId: "agent:orchestrator",
    constraints: rootConstraints(),
    task: "Book a Goa trip, total under $500, refundable hotels only",
  });
  if (!root.ok) throw new Error("root failed");

  const flight = await issueChild(db, {
    runId,
    parentJws: root.jws,
    childSub: "agent:flight",
    constraints: { maxAmount: 200, currency: "USD", categories: ["flight"], refundableOnly: true, expiresAt: inHours(24) },
    task: "Book a flight to Goa",
  });
  const hotel = await issueChild(db, {
    runId,
    parentJws: root.jws,
    childSub: "agent:hotel",
    constraints: { maxAmount: 300, currency: "USD", categories: ["hotel"], refundableOnly: true, expiresAt: inHours(24) },
    task: "Book a refundable hotel in Goa",
  });
  if (!flight.ok || !hotel.ok) throw new Error("children failed");
  return { db, runId, root, flight, hotel };
}
