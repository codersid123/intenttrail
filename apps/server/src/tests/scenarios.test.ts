import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJws, signJws } from "../crypto/jws";
import { getPrivateJwk } from "../crypto/keys";
import { openDb, type DB } from "../db/db";
import { available } from "../budget/ledger";
import { cartViolations } from "../mandates/cart-check";
import { signCart } from "../merchant/merchant";
import { MockProvider } from "../paypal/mock";
import type { CreateOrderArgs } from "../paypal/types";
import { getEvents, verifyChain } from "../provenance/log";
import { buildMandateTree, DEMO, ensureDemoPrincipals } from "../agents/orchestrator";
import { runScenario } from "../agents/scenarios";
import { purchase } from "../agents/subagent";
import type { MandatePayload, SignedCart } from "@intenttrail/shared";

const types = (db: DB, runId: string) => getEvents(db, runId).map((e) => e.type);
const txn = (db: DB, id: string) => db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as any;

async function setup() {
  const db = openDb(":memory:");
  const runId = "run-unit";
  await ensureDemoPrincipals(db);
  const tree = await buildMandateTree(db, runId);
  return { db, runId, tree };
}

test("A: refundable $250 hotel → captured, chain intact, budget committed", async () => {
  const db = openDb(":memory:");
  const r = await runScenario(db, new MockProvider(), "A");
  assert.equal(r.ok, true);
  assert.equal(r.capturedAmount, 250);
  assert.equal(r.cartTotal, 250);
  assert.equal(r.chain.ok, true);
  assert.equal(txn(db, r.transactionId!).status, "captured");
  assert.equal(txn(db, r.transactionId!).is_mock, 1);
  const t = types(db, r.runId);
  for (const ev of ["MANDATE_ISSUED", "CART_SIGNED", "BUDGET_RESERVED", "PAYPAL_ORDER_CREATED", "PAYPAL_AUTHORIZED", "PAYPAL_CAPTURED"]) {
    assert.ok(t.includes(ev as any), `missing ${ev}`);
  }
  const spend = db.prepare("SELECT status FROM budget_ledger WHERE kind = 'spend'").get() as { status: string };
  assert.equal(spend.status, "committed");
  const run = db.prepare("SELECT status, fault_injection FROM runs WHERE id = ?").get(r.runId) as any;
  assert.equal(run.status, "completed");
  assert.equal(run.fault_injection, null);
});

test("B: fault-injected agent buys non-refundable; cart provably violates the mandate", async () => {
  const db = openDb(":memory:");
  const r = await runScenario(db, new MockProvider(), "B");
  assert.equal(r.ok, true);
  assert.equal(r.capturedAmount, 220);
  assert.ok(r.faultInjection?.agent?.skipChecks?.includes("refundableOnly"));

  // What the Day 4 verifier will do: signed cart vs leaf mandate
  const t = txn(db, r.transactionId!);
  const leaf = decodeJws<MandatePayload>((db.prepare("SELECT jws FROM mandates WHERE mid = ?").get(t.mid) as { jws: string }).jws);
  const cart = decodeJws<SignedCart>(t.signed_cart_jws);
  assert.deepEqual(cartViolations(leaf.constraints, cart).map((v) => v.rule), ["refundableOnly"]);
  // the fault label is kept out of the hash-chained evidence
  assert.ok(!JSON.stringify(getEvents(db, r.runId)).includes("skipChecks"));
});

test("honest agent refuses a non-refundable cart (no transaction, budget untouched)", async () => {
  const { db, runId, tree } = await setup();
  const { jws } = await signCart(db, { runId, merchantId: "merchant:goa-stays", itemIds: ["ht-sunset-bay"] });
  const p = await purchase({ db, provider: new MockProvider(), runId }, { agentId: DEMO.hotelAgent, mandateJws: tree.hotel.jws, cartJws: jws });
  assert.equal(p.ok, false);
  if (!p.ok) assert.match(p.reason, /violates/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM transactions").get() as { n: number }).n, 0);
  assert.equal(available(db, tree.hotel.mid), 300);
});

test("C: merchant captures $215 on a $190 cart (over-capture allowed)", async () => {
  const db = openDb(":memory:");
  const r = await runScenario(db, new MockProvider(), "C");
  assert.equal(r.ok, true);
  assert.equal(r.cartTotal, 190);
  assert.equal(r.capturedAmount, 215);
  assert.equal(r.usedInflatedOrderFallback, false);
});

test("C fallback: over-capture rejected → void, re-create order at $215, capture $215", async () => {
  const db = openDb(":memory:");
  const r = await runScenario(db, new MockProvider({ allowOvercapture: false }), "C");
  assert.equal(r.ok, true);
  assert.equal(r.usedInflatedOrderFallback, true);
  assert.equal(r.capturedAmount, 215);
  const ev = getEvents(db, r.runId);
  const orders = ev.filter((e) => e.type === "PAYPAL_ORDER_CREATED").map((e) => (e.data as any).amount);
  assert.deepEqual(orders, [190, 215]);
  assert.ok(ev.some((e) => e.type === "PAYPAL_VOIDED"));
  assert.ok(ev.some((e) => e.type === "PAYPAL_ERROR" && (e.data as any).issue === "MAX_CAPTURE_AMOUNT_EXCEEDED"));
  assert.equal(r.chain.ok, true);
});

test("D: tampering with CART_SIGNED breaks the hash chain at that exact seq", async () => {
  const db = openDb(":memory:");
  const r = await runScenario(db, new MockProvider(), "D");
  assert.equal(r.ok, true);
  assert.equal(r.tampered?.from, false);
  assert.equal(r.chain.ok, false);
  if (!r.chain.ok) assert.equal(r.chain.brokenSeq, r.tampered!.seq);
  const cartEvent = getEvents(db, r.runId).find((e) => e.type === "CART_SIGNED")!;
  assert.equal((cartEvent.data as any).items[0].refundable, true); // the lie an LLM reading logs would see
});

test("no vault: purchase waits for buyer approval, then authorizes", async () => {
  const db = openDb(":memory:");
  const urls: string[] = [];
  const r = await runScenario(db, new MockProvider({ requireApproval: true }), "A", { hooks: { onApprovalRequired: (u) => urls.push(u) } });
  assert.equal(r.ok, true);
  assert.equal(urls.length, 1);
  assert.ok(types(db, r.runId).includes("PAYPAL_APPROVAL_REQUIRED"));
  const run = db.prepare("SELECT approve_url FROM runs WHERE id = ?").get(r.runId) as { approve_url: string };
  assert.equal(run.approve_url, urls[0]);
});

test("replay: the same signed cart can't be bought twice", async () => {
  const { db, runId, tree } = await setup();
  const provider = new MockProvider();
  const { jws } = await signCart(db, { runId, merchantId: "merchant:goa-stays", itemIds: ["ht-casa-calangute"] });
  const args = { agentId: DEMO.hotelAgent, mandateJws: tree.hotel.jws, cartJws: jws };
  assert.equal((await purchase({ db, provider, runId }, args)).ok, true);
  const second = await purchase({ db, provider, runId }, args);
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.reason, /replay/);
  assert.equal(available(db, tree.hotel.mid), 110); // only charged once
});

test("forged cart (not signed by the merchant's key) is refused", async () => {
  const { db, runId, tree } = await setup();
  const fake: SignedCart = {
    cartId: "fake-cart",
    merchantId: "merchant:goa-stays",
    items: [{ id: "ht-palm-grove", name: "Palm Grove", price: 1, refundable: true, category: "hotel" }],
    total: 1,
    currency: "USD",
    iat: Math.floor(Date.now() / 1000),
  };
  const forged = await signJws(fake, getPrivateJwk(db, DEMO.hotelAgent));
  const p = await purchase({ db, provider: new MockProvider(), runId }, { agentId: DEMO.hotelAgent, mandateJws: tree.hotel.jws, cartJws: forged });
  assert.equal(p.ok, false);
  if (!p.ok) assert.match(p.reason, /signature/);
});

test("honest agent refuses a PayPal order that doesn't match the signed cart", async () => {
  const { db, runId, tree } = await setup();
  class InflatingMerchant extends MockProvider {
    override createOrder(a: CreateOrderArgs) {
      return super.createOrder({ ...a, amount: a.amount + 25 });
    }
  }
  const { jws } = await signCart(db, { runId, merchantId: "merchant:goa-stays", itemIds: ["ht-casa-calangute"] });
  const p = await purchase({ db, provider: new InflatingMerchant() as MockProvider, runId }, { agentId: DEMO.hotelAgent, mandateJws: tree.hotel.jws, cartJws: jws });
  assert.equal(p.ok, false);
  if (!p.ok) assert.match(p.reason, /signed cart says \$190/);
  assert.equal(available(db, tree.hotel.mid), 300); // reservation released
  assert.ok(types(db, runId).includes("BUDGET_RELEASED"));
});

test("failed capture → hold voided, budget released, transaction marked voided", async () => {
  const { db, runId, tree } = await setup();
  const { jws } = await signCart(db, { runId, merchantId: "merchant:goa-stays", itemIds: ["ht-casa-calangute"] });
  const p = await purchase(
    { db, provider: new MockProvider({ allowOvercapture: false }), runId },
    { agentId: DEMO.hotelAgent, mandateJws: tree.hotel.jws, cartJws: jws, fault: { description: "test", merchant: { captureAmount: 400 } } },
  );
  assert.equal(p.ok, false);
  assert.equal(txn(db, p.transactionId!).status, "voided");
  assert.equal(available(db, tree.hotel.mid), 300);
  assert.equal(verifyChain(db, runId).ok, true);
});
