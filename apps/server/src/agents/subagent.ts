// Sub-agent purchase flow (scripted mode). Order of operations:
//   verify own mandate chain → verify merchant cart signature → check cart against mandate
//   → register transaction (single-use cart) → reserve budget
//   → PayPal: create order → (buyer approval if no vault) → authorize → merchant captures
//   → commit budget.  Any failure: void the hold + release the budget.
import { randomUUID } from "node:crypto";
import type { SignedCart } from "@intenttrail/shared";
import type { DB } from "../db/db";
import { verifyMandateChain } from "../mandates/verify";
import { cartViolations, type Rule } from "../mandates/cart-check";
import { verifyCart } from "../merchant/merchant";
import { appendEvent } from "../provenance/log";
import { commitSpend, releaseSpend, reserveSpend, toCents } from "../budget/ledger";
import { isPayPalIssue, PayPalApiError } from "../paypal/errors";
import type { AuthorizationInfo, CaptureInfo, PaymentProvider } from "../paypal/types";

/** Explicit, labelled fault injection (design rule 7). Never inferred, always set by a scenario. */
export type FaultInjection = {
  description: string;
  agent?: {
    skipChecks?: Rule[]; // the agent's mandate check is "buggy" and doesn't test these rules
    skipOrderAmountCheck?: boolean; // agent pays a PayPal order even if it differs from the signed cart
  };
  merchant?: {
    captureAmount?: number; // merchant captures this instead of the cart total
    inflateOrderIfOvercaptureRejected?: boolean; // roadmap 7.3 fallback for scenario C
  };
};

export type PurchaseHooks = { onApprovalRequired?: (approveUrl: string, orderId: string) => void };

export type PurchaseResult =
  | {
      ok: true;
      transactionId: string;
      orderId: string;
      authorizationId: string;
      captureId: string;
      capturedAmount: number;
      cartTotal: number;
      usedInflatedOrderFallback: boolean;
    }
  | { ok: false; transactionId?: string; reason: string };

class AgentAbort extends Error {}

const ALL_RULES: Rule[] = ["currency", "categories", "merchantAllowlist", "maxAmount", "refundableOnly", "expiresAt"];

export async function purchase(
  ctx: { db: DB; provider: PaymentProvider; runId: string; hooks?: PurchaseHooks },
  args: { agentId: string; mandateJws: string; cartJws: string; fault?: FaultInjection | null },
): Promise<PurchaseResult> {
  const { db, provider, runId } = ctx;
  const { agentId, fault } = args;
  const decide = (data: object) => appendEvent(db, runId, agentId, "AGENT_DECISION", data);
  const abort = (reason: string, extra: object = {}): PurchaseResult => {
    decide({ action: "abort_purchase", reason, ...extra });
    return { ok: false, reason };
  };

  // 1. Is my own authority valid? (signatures, chain links, not revoked/expired)
  const chain = await verifyMandateChain(db, args.mandateJws);
  if (!chain.ok) return abort(`my mandate is invalid: ${chain.error}`);
  const leaf = chain.chain[0];
  if (leaf.sub !== agentId) return abort(`mandate ${leaf.mid} was granted to ${leaf.sub}, not ${agentId}`);

  // 2. Is the cart really signed by the merchant it claims?
  const cc = await verifyCart(db, args.cartJws);
  if (!cc.ok) return abort(cc.error);
  const cart: SignedCart = cc.cart;

  // 3. Does the cart fit my mandate? (a fault-injected agent skips some checks)
  const skip = new Set(fault?.agent?.skipChecks ?? []);
  const checksRun = ALL_RULES.filter((r) => !skip.has(r));
  const violations = cartViolations(leaf.constraints, cart).filter((v) => !skip.has(v.rule));
  if (violations.length) return abort("cart violates my mandate", { mid: leaf.mid, cartId: cart.cartId, violations });

  // 4. Register the transaction. cart_id is UNIQUE → a replayed cart is rejected here.
  const txnId = randomUUID();
  try {
    db.prepare(
      `INSERT INTO transactions (id, run_id, mid, cart_id, merchant_id, signed_cart_jws, is_mock, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'created')`,
    ).run(txnId, runId, leaf.mid, cart.cartId, cart.merchantId, args.cartJws, provider.kind === "mock" ? 1 : 0);
  } catch (err) {
    if (/UNIQUE/i.test(String(err))) return abort("cart already used (replay blocked)", { cartId: cart.cartId });
    throw err;
  }
  decide({ action: "purchase", mid: leaf.mid, transactionId: txnId, cartId: cart.cartId, merchantId: cart.merchantId, total: cart.total, checksRun, result: "pass" });

  const setTxn = (sql: string, ...params: unknown[]) => db.prepare(`UPDATE transactions SET ${sql} WHERE id = ?`).run(...params, txnId);

  // 5. Reserve budget atomically on my (leaf) mandate
  const reserve = reserveSpend(db, { runId, mid: leaf.mid, amount: cart.total, ref: txnId });
  if (!reserve.ok) {
    setTxn("status = 'failed'");
    return { ok: false, transactionId: txnId, reason: reserve.reason };
  }

  // 6. Pay through PayPal
  let step = "create_order";
  let attempt = 1; // 2 only in scenario C's inflated-order fallback
  let auth: AuthorizationInfo | undefined;

  const payAttempt = async (orderAmount: number, attempt: number): Promise<AuthorizationInfo> => {
    step = "create_order";
    const order = await provider.createOrder({
      amount: orderAmount,
      customId: txnId,
      description: `IntentTrail: ${cart.items.map((i) => i.name).join("; ")}`,
      requestId: `${txnId}-order-${attempt}`,
    });
    appendEvent(db, runId, cart.merchantId, "PAYPAL_ORDER_CREATED", {
      transactionId: txnId,
      orderId: order.orderId,
      amount: order.amount,
      status: order.status,
      customId: txnId,
      attempt,
      provider: provider.label,
    });
    setTxn("paypal_order_id = ?", order.orderId);

    // The agent checks the merchant's PayPal order against the signed cart before paying
    if (toCents(order.amount) !== toCents(cart.total) && !fault?.agent?.skipOrderAmountCheck) {
      throw new AgentAbort(`PayPal order is for $${order.amount}, but the signed cart says $${cart.total}`);
    }

    let a = order.authorization; // vaulted wallet: PayPal may authorize at creation
    if (!a) {
      if (order.status === "PAYER_ACTION_REQUIRED" || (order.status === "CREATED" && order.approveUrl)) {
        if (!order.approveUrl) throw new Error(`order ${order.orderId} needs buyer approval but has no approve link`);
        step = "buyer_approval";
        appendEvent(db, runId, "system", "PAYPAL_APPROVAL_REQUIRED", { transactionId: txnId, orderId: order.orderId, approveUrl: order.approveUrl });
        ctx.hooks?.onApprovalRequired?.(order.approveUrl, order.orderId);
        await provider.waitForApproval(order.orderId);
      }
      step = "authorize";
      a = await provider.authorizeOrder(order.orderId, `${txnId}-auth-${attempt}`);
    }
    appendEvent(db, runId, agentId, "PAYPAL_AUTHORIZED", {
      transactionId: txnId,
      orderId: order.orderId,
      authorizationId: a.authorizationId,
      amount: a.amount,
      status: a.status,
    });
    setTxn("paypal_authorization_id = ?, status = 'authorized'", a.authorizationId);
    return a;
  };

  const capture = async (a: AuthorizationInfo, amount: number, attempt: number): Promise<CaptureInfo> => {
    step = "capture";
    const c = await provider.captureAuthorization(a.authorizationId, amount, `${txnId}-capture-${attempt}`);
    appendEvent(db, runId, cart.merchantId, "PAYPAL_CAPTURED", {
      transactionId: txnId,
      authorizationId: a.authorizationId,
      captureId: c.captureId,
      amount: c.amount,
      status: c.status,
    });
    return c;
  };

  const voidHold = async (a: AuthorizationInfo, reason: string, attempt: number) => {
    await provider.voidAuthorization(a.authorizationId, `${txnId}-void-${attempt}`);
    appendEvent(db, runId, "system", "PAYPAL_VOIDED", { transactionId: txnId, authorizationId: a.authorizationId, reason });
  };

  const logError = (err: unknown, note?: string) =>
    appendEvent(db, runId, "system", "PAYPAL_ERROR", {
      transactionId: txnId,
      step,
      ...(err instanceof PayPalApiError ? err.toJSON() : { message: err instanceof Error ? err.message : String(err) }),
      ...(note ? { note } : {}),
    });

  try {
    const captureAmount = fault?.merchant?.captureAmount ?? cart.total;
    let usedFallback = false;
    auth = await payAttempt(cart.total, attempt);
    let cap: CaptureInfo;
    try {
      cap = await capture(auth, captureAmount, attempt);
    } catch (err) {
      if (!(isPayPalIssue(err, "MAX_CAPTURE_AMOUNT_EXCEEDED") && fault?.merchant?.inflateOrderIfOvercaptureRejected)) throw err;
      // Roadmap 7.3 fallback: PayPal refused the over-capture, so the (faulty) merchant
      // re-issues the PayPal order at the inflated amount instead.
      logError(err, "over-capture rejected by PayPal; merchant re-creates the order at the inflated amount");
      await voidHold(auth, "over-capture rejected; order re-created", attempt);
      auth = undefined;
      usedFallback = true;
      attempt = 2;
      auth = await payAttempt(captureAmount, attempt);
      cap = await capture(auth, captureAmount, attempt);
    }

    commitSpend(db, reserve.ledgerId, cap.captureId);
    setTxn("paypal_capture_id = ?, captured_amount = ?, status = 'captured'", cap.captureId, cap.amount);
    const row = db.prepare("SELECT paypal_order_id FROM transactions WHERE id = ?").get(txnId) as { paypal_order_id: string };
    return {
      ok: true,
      transactionId: txnId,
      orderId: row.paypal_order_id,
      authorizationId: auth.authorizationId,
      captureId: cap.captureId,
      capturedAmount: cap.amount,
      cartTotal: cart.total,
      usedInflatedOrderFallback: usedFallback,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof AgentAbort) decide({ action: "abort_purchase", reason, transactionId: txnId });
    else logError(err);
    if (auth) {
      try {
        await voidHold(auth, reason, attempt);
      } catch (voidErr) {
        logError(voidErr, "void after failure also failed");
      }
    }
    releaseSpend(db, runId, reserve.ledgerId, reason);
    setTxn(`status = '${auth ? "voided" : "failed"}'`);
    return { ok: false, transactionId: txnId, reason };
  }
}
