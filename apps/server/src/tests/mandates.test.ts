import { test } from "node:test";
import assert from "node:assert/strict";
import type { MandatePayload } from "@intenttrail/shared";
import { buildDemoTree, inHours } from "./fixture";
import { issueChild } from "../mandates/issue";
import { verifyMandateChain } from "../mandates/verify";
import { revokeMandate } from "../mandates/revoke";
import { available } from "../budget/ledger";
import { decodeJws, signJws } from "../crypto/jws";
import { getPrivateJwk } from "../crypto/keys";
import { getEvents } from "../provenance/log";

const hotelSub = (maxAmount: number, extra: object = {}) => ({
  maxAmount,
  currency: "USD" as const,
  categories: ["hotel"],
  refundableOnly: true,
  expiresAt: inHours(24),
  ...extra,
});

test("valid 3-level tree verifies, and carve-outs use the whole root budget", async () => {
  const { db, root, hotel } = await buildDemoTree();
  const res = await verifyMandateChain(db, hotel.ok ? hotel.jws : "");
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(res.chain.map((m) => m.sub), ["agent:hotel", "agent:orchestrator"]);
  assert.equal(available(db, root.ok ? root.mid : ""), 0);
});

test("rejects child bigger than parent's remaining budget (siblings can't overspend)", async () => {
  const { db, runId, root } = await buildDemoTree();
  if (!root.ok) throw new Error();
  const r = await issueChild(db, { runId, parentJws: root.jws, childSub: "agent:sneaky", constraints: hotelSub(1), task: "x" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reasons.join(), /remaining budget/);
});

test("rejects maxAmount larger than parent", async () => {
  const { db, runId, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  const r = await issueChild(db, { runId, parentJws: hotel.jws, childSub: "agent:sneaky", constraints: hotelSub(400), task: "x" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reasons.join(), /maxAmount: 400 > parent 300/);
});

test("rejects a category the parent doesn't allow", async () => {
  const { db, runId, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  const r = await issueChild(db, {
    runId, parentJws: hotel.jws, childSub: "agent:sneaky", constraints: hotelSub(100, { categories: ["hotel", "car"] }), task: "x",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reasons.join(), /categories: \[car\]/);
});

test("rejects dropping refundableOnly", async () => {
  const { db, runId, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  const r = await issueChild(db, {
    runId, parentJws: hotel.jws, childSub: "agent:sneaky", constraints: hotelSub(100, { refundableOnly: false }), task: "x",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reasons.join(), /refundableOnly/);
});

test("rejects expiry later than parent", async () => {
  const { db, runId, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  const r = await issueChild(db, {
    runId, parentJws: hotel.jws, childSub: "agent:sneaky", constraints: hotelSub(100, { expiresAt: inHours(48) }), task: "x",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reasons.join(), /outlives parent/);
});

test("rejects widening a merchant allowlist", async () => {
  const { db, runId, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  // First narrow to one merchant (allowed)...
  const narrow = await issueChild(db, {
    runId, parentJws: hotel.jws, childSub: "agent:sneaky", constraints: hotelSub(100, { merchantAllowlist: ["merchant:goa-stays"] }), task: "x",
  });
  assert.equal(narrow.ok, true);
  if (!narrow.ok) throw new Error();
  // ...then try to widen it again (not allowed)
  const wide = await issueChild(db, {
    runId, parentJws: narrow.jws, childSub: "agent:hotel", constraints: hotelSub(50), task: "x",
  });
  assert.equal(wide.ok, false);
  if (!wide.ok) assert.match(wide.reasons.join(), /merchantAllowlist/);
});

test("revoking the orchestrator invalidates the hotel agent too", async () => {
  const { db, runId, root, hotel } = await buildDemoTree();
  if (!root.ok || !hotel.ok) throw new Error();
  revokeMandate(db, { runId, mid: root.mid, by: "user:priya", reason: "changed my mind" });
  const v = await verifyMandateChain(db, hotel.jws);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /revoked/);
  const r = await issueChild(db, { runId, parentJws: hotel.jws, childSub: "agent:sneaky", constraints: hotelSub(50), task: "x" });
  assert.equal(r.ok, false);
});

test("rejects an expired parent", async () => {
  const { db, root } = await buildDemoTree();
  if (!root.ok) throw new Error();
  const v = await verifyMandateChain(db, root.jws, Date.now() + 25 * 3600 * 1000); // 25h later
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /expired/);
});

test("detects a forged mandate (signed with the wrong key)", async () => {
  const { db, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  // The hotel agent tries to rewrite its own mandate to $1000 and sign it itself
  const p = decodeJws<MandatePayload>(hotel.jws);
  const forged = await signJws({ ...p, constraints: { ...p.constraints, maxAmount: 1000 } }, getPrivateJwk(db, "agent:hotel"));
  const v = await verifyMandateChain(db, forged);
  assert.equal(v.ok, false);
  if (!v.ok) assert.match(v.error, /bad signature/);
});

test("every rejection is written to the provenance log", async () => {
  const { db, runId, hotel } = await buildDemoTree();
  if (!hotel.ok) throw new Error();
  await issueChild(db, { runId, parentJws: hotel.jws, childSub: "agent:sneaky", constraints: hotelSub(999), task: "x" });
  const rejected = getEvents(db, runId).filter((e) => e.type === "MANDATE_REJECTED");
  assert.equal(rejected.length, 1);
});
