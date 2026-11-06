// Run one demo scenario from the terminal and print its provenance log.
//   npm run scenario B
import type { ProvenanceEvent } from "@intenttrail/shared";
import { env } from "../config";
import { openDb } from "../db/db";
import { makeProvider } from "../paypal/make-provider";
import { startStandaloneReturnPages } from "../paypal/return-page";
import { runScenario, SCENARIO_IDS, SCENARIOS, type ScenarioId } from "../agents/scenarios";
import { getEvents } from "../provenance/log";

const id = (process.argv[2] ?? "").toUpperCase() as ScenarioId;
if (!SCENARIO_IDS.includes(id)) {
  console.log("Usage: npm run scenario <A|B|C|D>\n");
  for (const s of Object.values(SCENARIOS)) console.log(`  ${s.id}  ${s.title.padEnd(15)} ${s.story}`);
  process.exit(1);
}

const s = SCENARIOS[id];
const db = openDb(env.DATABASE_PATH);
const provider = makeProvider();
const stopPages = startStandaloneReturnPages(env.PORT);

console.log(`\n▶ Scenario ${id}: ${s.title}`);
console.log(`  ${s.story}`);
console.log(`  payments: ${provider.label}`);
if (s.fault) console.log(`  ⚠️  FAULT INJECTED (on purpose): ${s.fault.description}`);

const t0 = Date.now();
const r = await runScenario(db, provider, id, {
  hooks: {
    onApprovalRequired: (url) => {
      console.log(`\n👉 Open this link, log in as the sandbox BUYER, and approve:\n   ${url}\n   waiting (up to 10 min) ...`);
    },
  },
});
stopPages();

const usd = (v: unknown) => `$${Number(v).toFixed(2)}`;
const summary = (e: ProvenanceEvent): string => {
  const d = e.data as any;
  switch (e.type) {
    case "MANDATE_ISSUED":
      return `${d.sub} max ${usd(d.constraints.maxAmount)} [${d.constraints.categories}]${d.constraints.refundableOnly ? " refundable-only" : ""}`;
    case "AGENT_DECISION":
      return `${d.action}${d.chosen ? ` → ${d.chosen}` : ""}${d.reason ? ` (${d.reason})` : ""}${d.checksRun ? ` checks: ${d.checksRun.join(",")}` : ""}`;
    case "CART_SIGNED":
      return `${d.items.map((i: any) => `${i.id} ${usd(i.price)} refundable=${i.refundable}`).join("; ")} total ${usd(d.total)}`;
    case "BUDGET_RESERVED":
    case "BUDGET_RELEASED":
      return `${usd(d.amount)}${d.reason ? ` (${d.reason})` : ""}`;
    case "BUDGET_RESERVE_DENIED":
      return d.reason;
    case "PAYPAL_ORDER_CREATED":
      return `order ${d.orderId} ${usd(d.amount)} status ${d.status}`;
    case "PAYPAL_APPROVAL_REQUIRED":
      return `order ${d.orderId} waiting for buyer`;
    case "PAYPAL_AUTHORIZED":
      return `auth ${d.authorizationId} ${usd(d.amount)}`;
    case "PAYPAL_CAPTURED":
      return `capture ${d.captureId} ${usd(d.amount)} ${d.status}`;
    case "PAYPAL_VOIDED":
      return `auth ${d.authorizationId} (${d.reason})`;
    case "PAYPAL_ERROR":
      return `${d.step}: ${d.issue ?? d.name ?? ""} ${d.message ?? ""}`.trim();
    default:
      return JSON.stringify(d).slice(0, 80);
  }
};

console.log(`\n📜 Provenance (${r.runId})`);
for (const e of getEvents(db, r.runId)) {
  console.log(`  ${String(e.seq).padStart(4)}  ${e.type.padEnd(24)} ${e.actor.padEnd(21)} ${summary(e)}`);
}

console.log("");
if (r.ok) {
  console.log(`✅ Purchase complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`   signed cart ${usd(r.cartTotal)} | captured ${usd(r.capturedAmount)}${r.capturedAmount !== r.cartTotal ? "  ⚠️ MISMATCH" : ""}`);
  console.log(`   PayPal order ${r.paypal!.orderId} | auth ${r.paypal!.authorizationId} | capture ${r.paypal!.captureId}`);
  if (r.usedInflatedOrderFallback) console.log("   ℹ️  PayPal rejected the over-capture → used the inflated-order fallback (roadmap 7.3)");
} else {
  console.log(`❌ Purchase did not complete: ${r.reason}`);
}
if (r.tampered) console.log(`🕵️  Tampered seq ${r.tampered.seq}: ${r.tampered.field} ${r.tampered.from} → ${r.tampered.to} (hashes NOT updated)`);
console.log(`🔗 Hash chain: ${r.chain.ok ? `intact (${r.chain.count} events)` : `BROKEN at seq ${r.chain.brokenSeq}: ${r.chain.reason}`}`);
console.log(`🎯 Expected verdict (Day 4 verifier): ${r.expectedVerdict}\n`);
process.exit(r.ok ? 0 : 1);
