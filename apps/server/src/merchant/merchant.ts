// Mock merchants (catalog is fake, signatures and PayPal payments are real).
// Both merchants share the one PayPal sandbox business account as payee; each has its own Ed25519 signing key.
import { randomUUID } from "node:crypto";
import { SignedCartSchema, type CartItem, type SignedCart } from "@intenttrail/shared";
import type { DB } from "../db/db";
import { createPrincipal, getKind, getPrivateJwk, getPublicJwk } from "../crypto/keys";
import { decodeJws, sha256, signJws, verifyJws } from "../crypto/jws";
import { appendEvent } from "../provenance/log";
import { toCents, toUsd } from "../budget/ledger";
import catalog from "./catalog.json" with { type: "json" };

export type CatalogItem = CartItem & { merchantId: string };

export const CATALOG: CatalogItem[] = catalog;
export const MERCHANT_IDS = [...new Set(CATALOG.map((i) => i.merchantId))];

export async function ensureMerchants(db: DB): Promise<void> {
  for (const id of MERCHANT_IDS) await createPrincipal(db, id, "merchant");
}

export function getItem(id: string): CatalogItem {
  const item = CATALOG.find((i) => i.id === id);
  if (!item) throw new Error(`unknown catalog item ${id}`);
  return item;
}

export function searchCatalog(f: { category: string; maxPrice?: number; refundableOnly?: boolean }): CatalogItem[] {
  return CATALOG.filter(
    (i) =>
      i.category === f.category &&
      (f.maxPrice === undefined || i.price <= f.maxPrice) &&
      (!f.refundableOnly || i.refundable),
  ).sort((a, b) => a.price - b.price);
}

/** Merchant quotes a single-use cart and signs it with its own key. Logged as CART_SIGNED. */
export async function signCart(
  db: DB,
  args: { runId: string; merchantId: string; itemIds: string[] },
): Promise<{ cartId: string; jws: string; cart: SignedCart }> {
  const items: CartItem[] = args.itemIds.map((id) => {
    const { merchantId, ...item } = getItem(id);
    if (merchantId !== args.merchantId) throw new Error(`${id} is not sold by ${args.merchantId}`);
    return item;
  });
  const cart: SignedCart = {
    cartId: randomUUID(),
    merchantId: args.merchantId,
    items,
    total: toUsd(items.reduce((sum, i) => sum + toCents(i.price), 0)),
    currency: "USD",
    iat: Math.floor(Date.now() / 1000),
  };
  const jws = await signJws(cart, getPrivateJwk(db, args.merchantId));
  appendEvent(db, args.runId, args.merchantId, "CART_SIGNED", { ...cart, cartJwsHash: sha256(jws) });
  return { cartId: cart.cartId, jws, cart };
}

export type CartCheck = { ok: true; cart: SignedCart } | { ok: false; error: string };

/** Check a cart's signature against the key of the merchant it claims to come from. */
export async function verifyCart(db: DB, jws: string): Promise<CartCheck> {
  const parsed = SignedCartSchema.safeParse(decodeJws(jws));
  if (!parsed.success) return { ok: false, error: "cart payload is malformed" };
  const { merchantId } = parsed.data;
  try {
    if (getKind(db, merchantId) !== "merchant") return { ok: false, error: `${merchantId} is not a merchant` };
    await verifyJws(jws, getPublicJwk(db, merchantId));
  } catch {
    return { ok: false, error: `bad or unknown merchant signature on cart (claimed ${merchantId})` };
  }
  return { ok: true, cart: parsed.data };
}
