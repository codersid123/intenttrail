import { z } from "zod";

export const CartItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number().positive(),
  refundable: z.boolean(),
  category: z.string(),
});
export type CartItem = z.infer<typeof CartItemSchema>;

/** Payload of a merchant-signed cart (compact JWS, EdDSA, merchant's key). */
export const SignedCartSchema = z.object({
  cartId: z.string(), // single use: one transaction per cart (DB unique constraint)
  merchantId: z.string(),
  items: z.array(CartItemSchema).min(1),
  total: z.number().positive(),
  currency: z.literal("USD"),
  iat: z.number().int(), // unix seconds
});
export type SignedCart = z.infer<typeof SignedCartSchema>;
