// Day 3 de-risk: can we see sandbox disputes through the API?
//   npm run disputes                                   → list disputes on the merchant account
//   npm run disputes get PP-D-12345                    → full details + matching IntentTrail transaction
//   npm run disputes create <buyerTxnId> <buyerEmail> <amount>   → SANDBOX ONLY: open one by API (fallback)
//   npm run disputes seller-response PP-D-12345        → SANDBOX ONLY: UNDER_REVIEW → WAITING_FOR_SELLER_RESPONSE
import { env } from "../config";
import { openDb } from "../db/db";
import { createSandboxDispute, getDispute, listDisputes, requireSellerEvidence } from "../paypal/disputes";
import { PayPalApiError } from "../paypal/errors";

const [cmd = "list", ...args] = process.argv.slice(2);

try {
  if (cmd === "list") {
    const items = await listDisputes();
    if (!items.length) {
      console.log("No disputes yet on this merchant account.");
      console.log("→ Open one: sandbox.paypal.com → log in as the BUYER → Activity → pick the IntentTrail payment → Report a problem.");
    }
    for (const d of items) {
      console.log(`${d.dispute_id.padEnd(16)} ${d.status.padEnd(28)} ${d.reason.padEnd(40)} $${d.dispute_amount?.value ?? "?"}  ${d.create_time}`);
    }
  } else if (cmd === "get" && args[0]) {
    const d = await getDispute(args[0]);
    const txs = (d.disputed_transactions ?? []) as any[];
    console.log(`dispute  ${d.dispute_id}  status ${d.status}  stage ${d.dispute_life_cycle_stage ?? "?"}  reason ${d.reason}`);
    console.log(`amount   $${d.dispute_amount?.value}`);
    const db = openDb(env.DATABASE_PATH);
    for (const t of txs) {
      console.log(`txn      seller ${t.seller_transaction_id ?? "-"} | buyer ${t.buyer_transaction_id ?? "-"} | custom ${t.custom ?? "-"}`);
      const ours = db
        .prepare("SELECT id, run_id, captured_amount FROM transactions WHERE paypal_capture_id = ? OR id = ?")
        .get(t.seller_transaction_id ?? "", t.custom ?? "") as { id: string; run_id: string; captured_amount: number } | undefined;
      console.log(ours ? `✅ matches IntentTrail transaction ${ours.id} (run ${ours.run_id}, captured $${ours.captured_amount})` : "⚠️  no matching IntentTrail transaction in this DB");
    }
    console.log(`actions  ${(d.links ?? []).map((l: any) => l.rel).join(", ")}`);
  } else if (cmd === "create" && args.length >= 3) {
    const res = await createSandboxDispute({ buyerTransactionId: args[0], buyerEmail: args[1], amount: Number(args[2]) });
    console.log("✅ Created. Response:", JSON.stringify(res, null, 2));
    console.log("Wait a few minutes, then: npm run disputes");
  } else if (cmd === "seller-response" && args[0]) {
    await requireSellerEvidence(args[0]);
    console.log(`✅ ${args[0]} → WAITING_FOR_SELLER_RESPONSE`);
  } else {
    console.log("Usage: npm run disputes [list | get <id> | create <buyerTxnId> <buyerEmail> <amount> | seller-response <id>]");
    process.exitCode = 1;
  }
} catch (err) {
  console.error("❌", err instanceof Error ? err.message : err);
  if (err instanceof PayPalApiError) console.error("   debug_id:", err.debugId, "\n   body:", JSON.stringify(err.body));
  process.exitCode = 1;
}
