import type { Constraints } from "@intenttrail/shared";

/** A child may only NARROW its parent. Returns a list of violations (empty = OK).
 *  Amount vs remaining budget is checked separately by the ledger. */
export function attenuationViolations(parent: Constraints, child: Constraints): string[] {
  const v: string[] = [];
  if (child.currency !== parent.currency) v.push(`currency: ${child.currency} ≠ parent ${parent.currency}`);
  if (child.maxAmount > parent.maxAmount) v.push(`maxAmount: ${child.maxAmount} > parent ${parent.maxAmount}`);

  const extraCats = child.categories.filter((c) => !parent.categories.includes(c));
  if (extraCats.length) v.push(`categories: [${extraCats.join(", ")}] not allowed by parent`);

  if (parent.merchantAllowlist) {
    if (!child.merchantAllowlist) v.push("merchantAllowlist: parent restricts merchants, child allows any");
    else {
      const extra = child.merchantAllowlist.filter((m) => !parent.merchantAllowlist!.includes(m));
      if (extra.length) v.push(`merchantAllowlist: [${extra.join(", ")}] not allowed by parent`);
    }
  }

  if (child.expiresAt > parent.expiresAt) v.push("expiresAt: child outlives parent");
  if (parent.refundableOnly && !child.refundableOnly) v.push("refundableOnly: parent requires true, child set false");
  return v;
}
