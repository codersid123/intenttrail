// Payment provider interface. Two implementations:
//   PayPalProvider (paypal/provider.ts) → real sandbox calls (demo scenarios)
//   MockProvider   (paypal/mock.ts)     → local fake (tests + eval harness only)

export type AuthorizationInfo = { authorizationId: string; amount: number; status: string };

export type OrderInfo = {
  orderId: string;
  status: string; // CREATED | PAYER_ACTION_REQUIRED | APPROVED | COMPLETED | VOIDED
  amount: number; // what PayPal says the order is for
  approveUrl?: string; // set when the buyer must approve in a browser
  authorization?: AuthorizationInfo; // set when PayPal authorized immediately (vaulted wallet)
};

export type CaptureInfo = { captureId: string; amount: number; status: string };

export type CreateOrderArgs = {
  amount: number;
  customId: string; // IntentTrail transaction id (links PayPal ↔ mandate)
  description: string;
  requestId: string; // PayPal-Request-Id (idempotency)
};

export interface PaymentProvider {
  readonly kind: "paypal" | "mock";
  /** Human-readable label for logs/UI, e.g. "PayPal sandbox (vaulted wallet)". */
  readonly label: string;
  createOrder(args: CreateOrderArgs): Promise<OrderInfo>;
  /** Resolves once the buyer has approved the order (polls). Throws on timeout/cancel. */
  waitForApproval(orderId: string): Promise<void>;
  authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationInfo>;
  captureAuthorization(authorizationId: string, amount: number, requestId: string): Promise<CaptureInfo>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<void>;
}
