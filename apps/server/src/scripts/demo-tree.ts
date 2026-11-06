import type { MandatePayload } from "@intenttrail/shared";
import { buildDemoTree, inHours } from "../tests/fixture";
import { issueChild } from "../mandates/issue";
import { verifyMandateChain } from "../mandates/verify";
import { available, reserveSpend } from "../budget/ledger";
import { decodeJws } from "../crypto/jws";
import { getEvents, verifyChain } from "../provenance/log";

const { db, runId, root, flight, hotel } = await buildDemoTree();
if (!root.ok || !flight.ok || !hotel.ok) throw new Error("tree failed");

const line = (jws: string, mid: string) => {
  const p = decodeJws<MandatePayload>(jws);
  const c = p.constraints;
  return `${p.sub.padEnd(19)} max $${String(c.maxAmount).padEnd(4)} available $${String(available(db, mid)).padEnd(4)} [${c.categories.join(", ")}]${c.refundableOnly ? " refundable-only" : ""}  (signed by ${p.iss})`;
};

console.log("\n🌳 Mandate tree");
console.log("user:priya");
console.log(" └─ " + line(root.jws, root.mid));
console.log("     ├─ " + line(flight.jws, flight.mid));
console.log("     └─ " + line(hotel.jws, hotel.mid));

console.log("\n🔏 Chain verification");
for (const [name, m] of [["flight", flight], ["hotel", hotel]] as const) {
  const v = await verifyMandateChain(db, m.jws);
  console.log(`  ${name}: ${v.ok ? "✅ valid (" + v.chain.length + " signatures checked)" : "❌ " + v.error}`);
}

console.log("\n🚫 Hotel agent tries to delegate MORE than it has ($400, non-refundable)");
const bad = await issueChild(db, {
  runId,
  parentJws: hotel.jws,
  childSub: "agent:sneaky",
  constraints: { maxAmount: 400, currency: "USD", categories: ["hotel"], refundableOnly: false, expiresAt: inHours(24) },
  task: "Book anything",
});
if (!bad.ok) bad.reasons.forEach((r) => console.log("  ❌ " + r));

console.log("\n💸 Two $200 hotel bookings at the same time (budget $300)");
const results = await Promise.all([200, 200].map(async (amt) => reserveSpend(db, { runId, mid: hotel.mid, amount: amt })));
results.forEach((r, i) => console.log(`  booking ${i + 1}: ${r.ok ? "✅ reserved" : "❌ denied — " + r.reason}`));
console.log(`  hotel available now: $${available(db, hotel.mid)}`);

const chain = verifyChain(db, runId);
console.log(`\n🔗 Provenance log: ${getEvents(db, runId).length} events, hash chain ${chain.ok ? "✅ intact" : "❌ broken at seq " + chain.brokenSeq}\n`);
