import type { Constraints, SignedCart } from "@intenttrail/shared";
import { toCents } from "../budget/ledger";

export type Rule = "currency" | "categories" | "merchantAllowlist" | "maxAmount" | "refundableOnly" | "expiresAt";
export type RuleViolation = { rule: Rule; expected: unknown; actual: unknown };

/** Does a signed cart fit a (leaf) mandate? Used by the sub-agent BEFORE buying,
 *  and by the Day 4 verifier (step 7) AFTER a dispute, at the recorded purchase time. */
export function cartViolations(c: Constraints, cart: SignedCart, purchaseTimeMs = Date.now()): RuleViolation[] {
  const v: RuleViolation[] = [];
  if (cart.currency !== c.currency) v.push({ rule: "currency", expected: c.currency, actual: cart.currency });

  const badCats = cart.items.filter((i) => !c.categories.includes(i.category)).map((i) => i.category);
  if (badCats.length) v.push({ rule: "categories", expected: c.categories, actual: [...new Set(badCats)] });

  if (c.merchantAllowlist && !c.merchantAllowlist.includes(cart.merchantId)) {
    v.push({ rule: "merchantAllowlist", expected: c.merchantAllowlist, actual: cart.merchantId });
  }

  if (toCents(cart.total) > toCents(c.maxAmount)) v.push({ rule: "maxAmount", expected: `≤ ${c.maxAmount}`, actual: cart.total });

  const nonRefundable = cart.items.filter((i) => !i.refundable).map((i) => i.id);
  if (c.refundableOnly && nonRefundable.length) {
    v.push({ rule: "refundableOnly", expected: true, actual: false });
  }

  if (c.expiresAt * 1000 <= purchaseTimeMs) {
    v.push({ rule: "expiresAt", expected: `before ${new Date(c.expiresAt * 1000).toISOString()}`, actual: new Date(purchaseTimeMs).toISOString() });
  }
  return v;
}
