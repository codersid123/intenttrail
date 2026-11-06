import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db/db";
import { appendEvent, verifyChain } from "../provenance/log";

function seed() {
  const db = openDb(":memory:");
  appendEvent(db, "run-1", "user:priya", "MANDATE_ISSUED", { mid: "m1" });
  const cartSeq = appendEvent(db, "run-1", "merchant:goa-stays", "CART_SIGNED", { cartId: "c1", refundable: false, total: 220 });
  appendEvent(db, "run-1", "agent:hotel", "PAYPAL_CAPTURED", { amount: 220 });
  appendEvent(db, "run-2", "user:priya", "MANDATE_ISSUED", { mid: "m9" }); // a different run
  return { db, cartSeq };
}

test("untouched chain verifies", () => {
  const { db } = seed();
  assert.deepEqual(verifyChain(db, "run-1"), { ok: true, count: 3 });
});

test("editing one entry is detected at the exact seq (Scenario D)", () => {
  const { db, cartSeq } = seed();
  // Attacker hides the fault: refundable false → true
  db.prepare("UPDATE provenance SET data = ? WHERE seq = ?").run(JSON.stringify({ cartId: "c1", refundable: true, total: 220 }), cartSeq);
  const r = verifyChain(db, "run-1");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.brokenSeq, cartSeq);
});

test("deleting an entry is detected", () => {
  const { db, cartSeq } = seed();
  db.prepare("DELETE FROM provenance WHERE seq = ?").run(cartSeq);
  const r = verifyChain(db, "run-1");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.brokenSeq, cartSeq + 1);
});

test("recomputing the edited hash still breaks the NEXT link", () => {
  const { db, cartSeq } = seed();
  // A smarter attacker also fixes the hash of the row they edited...
  db.prepare("UPDATE provenance SET data = ?, hash = 'forged' WHERE seq = ?").run("{}", cartSeq);
  const r = verifyChain(db, "run-1");
  assert.equal(r.ok, false);
});

test("tampering one run doesn't affect another run", () => {
  const { db, cartSeq } = seed();
  db.prepare("UPDATE provenance SET data = '{}' WHERE seq = ?").run(cartSeq);
  assert.equal(verifyChain(db, "run-2").ok, true);
});
