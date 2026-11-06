// Vault v3: save Priya's PayPal wallet once ("save without purchase"),
// so later agent purchases can be authorized without a browser click.
import { paypalRequest } from "./client";

type Link = { href: string; rel: string };

export async function createSetupToken(args: { returnUrl: string; cancelUrl: string }) {
  const res = await paypalRequest<{ id: string; status: string; links?: Link[]; customer?: { id: string } }>(
    "POST",
    "/v3/vault/setup-tokens",
    {
      body: {
        payment_source: {
          paypal: {
            description: "IntentTrail demo: let your AI agents pay within the mandates you sign",
            usage_pattern: "IMMEDIATE",
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            permit_multiple_payment_tokens: false,
            experience_context: {
              brand_name: "IntentTrail Demo",
              locale: "en-US",
              shipping_preference: "NO_SHIPPING",
              return_url: args.returnUrl,
              cancel_url: args.cancelUrl,
            },
          },
        },
      },
    },
  );
  return {
    setupTokenId: res.id,
    status: res.status,
    approveUrl: res.links?.find((l) => l.rel === "approve")?.href,
    customerId: res.customer?.id,
  };
}

export async function getSetupToken(id: string) {
  return paypalRequest<{ id: string; status: string }>("GET", `/v3/vault/setup-tokens/${id}`);
}

/** Exchange an APPROVED setup token for a permanent payment token (= the vault id used in orders). */
export async function createPaymentToken(setupTokenId: string) {
  const res = await paypalRequest<{ id: string; customer?: { id: string } }>("POST", "/v3/vault/payment-tokens", {
    body: { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } },
  });
  return { paymentTokenId: res.id, customerId: res.customer?.id };
}
