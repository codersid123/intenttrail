// Fake payments for tests and the eval harness ONLY (PAYMENT_MODE=mock).
// Mirrors PayPal's rules closely enough that the purchase flow is exercised end to end.
import { randomUUID } from "node:crypto";
import { toCents } from "../budget/ledger";
import { PayPalApiError } from "./errors";
import type { AuthorizationInfo, CaptureInfo, CreateOrderArgs, OrderInfo, PaymentProvider } from "./types";

type MockOrder = { id: string; amount: number; status: string; customId: string };
type MockAuth = { id: string; orderId: string; amount: number; status: "CREATED" | "CAPTURED" | "VOIDED" };

export class MockProvider implements PaymentProvider {
  readonly kind = "mock" as const;
  readonly label = "Mock payments (not PayPal)";
  private orders = new Map<string, MockOrder>();
  private auths = new Map<string, MockAuth>();

  constructor(
    private readonly opts: {
      /** true → orders need "buyer approval" (like no vault). false → authorized at creation (like vault). */
      requireApproval?: boolean;
      /** true → allow capture up to min(115%, +$75) like PayPal's documented default. false → reject any over-capture. */
      allowOvercapture?: boolean;
    } = {},
  ) {}

  async createOrder(a: CreateOrderArgs): Promise<OrderInfo> {
    const id = `MOCK-ORDER-${randomUUID().slice(0, 8).toUpperCase()}`;
    const order: MockOrder = { id, amount: a.amount, status: "PAYER_ACTION_REQUIRED", customId: a.customId };
    this.orders.set(id, order);
    if (this.opts.requireApproval) {
      return { orderId: id, status: order.status, amount: a.amount, approveUrl: `mock://approve/${id}` };
    }
    order.status = "COMPLETED";
    const auth = this.newAuth(order);
    return { orderId: id, status: order.status, amount: a.amount, authorization: auth };
  }

  async waitForApproval(orderId: string): Promise<void> {
    const o = this.mustOrder(orderId);
    if (o.status === "PAYER_ACTION_REQUIRED") o.status = "APPROVED"; // the "buyer" approves instantly
  }

  async authorizeOrder(orderId: string): Promise<AuthorizationInfo> {
    const o = this.mustOrder(orderId);
    if (o.status !== "APPROVED") throw new PayPalApiError(422, "UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED", undefined, "order not approved (mock)");
    o.status = "COMPLETED";
    return this.newAuth(o);
  }

  async captureAuthorization(authorizationId: string, amount: number): Promise<CaptureInfo> {
    const a = this.auths.get(authorizationId);
    if (!a || a.status !== "CREATED") throw new PayPalApiError(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_COMPLETED", undefined, "authorization not capturable (mock)");
    const authC = toCents(a.amount);
    const limitC = this.opts.allowOvercapture === false ? authC : Math.min(Math.floor(authC * 1.15), authC + 7500);
    if (toCents(amount) > limitC) {
      throw new PayPalApiError(422, "UNPROCESSABLE_ENTITY", "MAX_CAPTURE_AMOUNT_EXCEEDED", undefined, "Capture amount exceeds allowable limit (mock)");
    }
    a.status = "CAPTURED";
    return { captureId: `MOCK-CAP-${randomUUID().slice(0, 8).toUpperCase()}`, amount, status: "COMPLETED" };
  }

  async voidAuthorization(authorizationId: string): Promise<void> {
    const a = this.auths.get(authorizationId);
    if (a && a.status === "CREATED") a.status = "VOIDED";
  }

  private newAuth(o: MockOrder): AuthorizationInfo {
    const id = `MOCK-AUTH-${randomUUID().slice(0, 8).toUpperCase()}`;
    this.auths.set(id, { id, orderId: o.id, amount: o.amount, status: "CREATED" });
    return { authorizationId: id, amount: o.amount, status: "CREATED" };
  }

  private mustOrder(id: string): MockOrder {
    const o = this.orders.get(id);
    if (!o) throw new PayPalApiError(404, "RESOURCE_NOT_FOUND", undefined, undefined, `order ${id} not found (mock)`);
    return o;
  }
}
