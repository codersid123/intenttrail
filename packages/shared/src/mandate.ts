import { z } from "zod";

export const ConstraintsSchema = z.object({
  maxAmount: z.number().positive(),
  currency: z.literal("USD"),
  categories: z.array(z.string()).min(1),
  merchantAllowlist: z.array(z.string()).optional(), // undefined = any merchant
  refundableOnly: z.boolean(),
  expiresAt: z.number().int(), // unix seconds
});
export type Constraints = z.infer<typeof ConstraintsSchema>;

export const MandatePayloadSchema = z.object({
  mid: z.string(),
  parentMid: z.string().nullable(),
  iss: z.string(), // who signed (gives authority)
  sub: z.string(), // who receives authority
  constraints: ConstraintsSchema,
  task: z.string(),
  iat: z.number().int(),
  nonce: z.string(),
  parentHash: z.string().nullable(), // sha256 of the parent JWS
});
export type MandatePayload = z.infer<typeof MandatePayloadSchema>;
