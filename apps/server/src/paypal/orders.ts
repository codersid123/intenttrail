// Orders v2 + Payments v2 (authorize → capture / void). Raw REST, no SDK.
import { money, paypalRequest } from "./client";
import type { AuthorizationInfo, CaptureInfo, OrderInfo } from "./types";

type Link = { href: string; rel: string; method?: string };
type PayPalOrder = {
  id: string;
  status: string;
  links?: Link[];
  purchase_units?: Array<{
    amount?: { value: string };
    payments?: { authorizations?: Array<{ id: string; status: string; amount: { value: string } }> };
  }>;
};

export type CreateOrderRequest = {
  amount: number;
  customId: string;
  description: string;
  requestId: string;
  /** Vaulted PayPal wallet (payment token id). If set, no buyer approval should be needed. */
  vaultId?: string;
  /** Used when not vaulted: where PayPal sends the buyer after approving / cancelling. */
  returnUrl: string;
  cancelUrl: string;
};

/** POST /v2/checkout/orders with intent AUTHORIZE. */
export async function createOrder(r: CreateOrderRequest): Promise<OrderInfo> {
  const paymentSource = r.vaultId
    ? { paypal: { vault_id: r.vaultId } }
    : {
        paypal: {
          experience_context: {
            brand_name: "IntentTrail Demo",
            user_action: "PAY_NOW",
            shipping_preference: "NO_SHIPPING",
            return_url: r.returnUrl,
            cancel_url: r.cancelUrl,
          },
        },
      };

  const order = await paypalRequest<PayPalOrder>("POST", "/v2/checkout/orders", {
    requestId: r.requestId,
    body: {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: r.customId,
          custom_id: r.customId, // max 127 chars; links this PayPal order to the IntentTrail transaction
          description: r.description.slice(0, 127),
          amount: money(r.amount),
        },
      ],
      payment_source: paymentSource,
    },
  });
  return toOrderInfo(order);
}

/** GET /v2/checkout/orders/{id} */
export async function getOrder(orderId: string): Promise<OrderInfo> {
  return toOrderInfo(await paypalRequest<PayPalOrder>("GET", `/v2/checkout/orders/${orderId}`));
}

/** POST /v2/checkout/orders/{id}/authorize → a real funds hold. Order must be APPROVED. */
export async function authorizeOrder(orderId: string, requestId: string): Promise<AuthorizationInfo> {
  const order = await paypalRequest<PayPalOrder>("POST", `/v2/checkout/orders/${orderId}/authorize`, { requestId, body: {} });
  const auth = firstAuthorization(order);
  if (!auth) throw new Error(`authorize returned no authorization for order ${orderId} (status ${order.status})`);
  return auth;
}

/** POST /v2/payments/authorizations/{id}/capture */
export async function captureAuthorization(authorizationId: string, amount: number, requestId: string): Promise<CaptureInfo> {
  const cap = await paypalRequest<{ id: string; status: string; amount: { value: string } }>(
    "POST",
    `/v2/payments/authorizations/${authorizationId}/capture`,
    { requestId, body: { amount: money(amount), final_capture: true } },
  );
  return { captureId: cap.id, amount: Number(cap.amount?.value ?? amount), status: cap.status };
}

/** POST /v2/payments/authorizations/{id}/void → releases the hold. */
export async function voidAuthorization(authorizationId: string, requestId: string): Promise<void> {
  await paypalRequest("POST", `/v2/payments/authorizations/${authorizationId}/void`, { requestId });
}

function firstAuthorization(order: PayPalOrder): AuthorizationInfo | undefined {
  const a = order.purchase_units?.[0]?.payments?.authorizations?.[0];
  return a ? { authorizationId: a.id, amount: Number(a.amount.value), status: a.status } : undefined;
}

function toOrderInfo(order: PayPalOrder): OrderInfo {
  const approve = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
  return {
    orderId: order.id,
    status: order.status,
    amount: Number(order.purchase_units?.[0]?.amount?.value ?? NaN),
    approveUrl: approve?.href,
    authorization: firstAuthorization(order),
  };
}
