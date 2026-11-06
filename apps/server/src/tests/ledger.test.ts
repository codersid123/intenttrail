import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDemoTree } from "./fixture";
import { available, releaseSpend, reserveSpend, commitSpend } from "../budget/ledger";
import { revokeMandate } from "../mandates/revoke";

test("reserve within budget reduces available", async () => {
  const { db, runId, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  const r = reserveSpend(db, { runId, mid: hotel.mid, amount: 250 });
  assert.equal(r.ok, true);
  assert.equal(available(db, hotel.mid), 50);
});

test("reserve over budget is denied", async () => {
  const { db, runId, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  const r = reserveSpend(db, { runId, mid: hotel.mid, amount: 300.01 });
  assert.equal(r.ok, false);
});

test("concurrency: two $200 buys on a $300 mandate → exactly one succeeds", async () => {
  const { db, runId, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  const results = await Promise.all([
    Promise.resolve().then(() => reserveSpend(db, { runId, mid: hotel.mid, amount: 200 })),
    Promise.resolve().then(() => reserveSpend(db, { runId, mid: hotel.mid, amount: 200 })),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 1);
  assert.equal(available(db, hotel.mid), 100);
});

test("no spending after an ancestor is revoked", async () => {
  const { db, runId, root, hotel } = await buildDemoTree();
  if (!root.ok || !hotel.ok) throw new Error();
  revokeMandate(db, { runId, mid: root.mid, by: "user:priya" });
  const r = reserveSpend(db, { runId, mid: hotel.mid, amount: 10 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /revoked/);
});

test("release gives money back; commit keeps it spent", async () => {
  const { db, runId, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  const a = reserveSpend(db, { runId, mid: hotel.mid, amount: 100 });
  const b = reserveSpend(db, { runId, mid: hotel.mid, amount: 100 });
  if (!a.ok || !b.ok) throw new Error();
  releaseSpend(db, runId, a.ledgerId, "payment voided");
  commitSpend(db, b.ledgerId, "AUTH-123");
  assert.equal(available(db, hotel.mid), 200);
});

test("floating point safe: 0.1 + 0.2 style amounts", async () => {
  const { db, runId, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  reserveSpend(db, { runId, mid: hotel.mid, amount: 299.7 });
  const r = reserveSpend(db, { runId, mid: hotel.mid, amount: 0.3 });
  assert.equal(r.ok, true);
  assert.equal(available(db, hotel.mid), 0);
});
