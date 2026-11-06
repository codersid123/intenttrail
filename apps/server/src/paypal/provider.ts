import * as orders from "./orders";
import type { CreateOrderArgs, OrderInfo, PaymentProvider } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real PayPal sandbox payments. With a vault id, orders are paid from Priya's saved wallet
 *  (she approved once, at setup). Without one, each order needs a browser approval click. */
export class PayPalProvider implements PaymentProvider {
  readonly kind = "paypal" as const;
  readonly label: string;

  constructor(
    private readonly opts: {
      vaultId?: string;
      returnUrl: string;
      cancelUrl: string;
      approvalTimeoutMs?: number; // default 10 minutes
      pollMs?: number; // default 3 seconds
    },
  ) {
    this.label = opts.vaultId ? "PayPal sandbox (vaulted wallet)" : "PayPal sandbox (manual buyer approval)";
  }

  createOrder(a: CreateOrderArgs): Promise<OrderInfo> {
    return orders.createOrder({ ...a, vaultId: this.opts.vaultId, returnUrl: this.opts.returnUrl, cancelUrl: this.opts.cancelUrl });
  }

  async waitForApproval(orderId: string): Promise<void> {
    const deadline = Date.now() + (this.opts.approvalTimeoutMs ?? 10 * 60_000);
    while (Date.now() < deadline) {
      const o = await orders.getOrder(orderId);
      if (o.status === "APPROVED" || o.status === "COMPLETED") return;
      if (o.status === "VOIDED") throw new Error(`order ${orderId} was voided/cancelled by the buyer`);
      await sleep(this.opts.pollMs ?? 3000);
    }
    throw new Error(`buyer did not approve order ${orderId} in time`);
  }

  authorizeOrder(orderId: string, requestId: string) {
    return orders.authorizeOrder(orderId, requestId);
  }

  captureAuthorization(authorizationId: string, amount: number, requestId: string) {
    return orders.captureAuthorization(authorizationId, amount, requestId);
  }

  voidAuthorization(authorizationId: string, requestId: string) {
    return orders.voidAuthorization(authorizationId, requestId);
  }
}
