import { env } from "../config";
import { MockProvider } from "./mock";
import { PayPalProvider } from "./provider";
import type { PaymentProvider } from "./types";

/** PAYMENT_MODE=paypal → real sandbox; PAYMENT_MODE=mock → fake (eval harness only). */
export function makeProvider(): PaymentProvider {
  if (env.PAYMENT_MODE === "mock") return new MockProvider();
  const base = `http://localhost:${env.PORT}/api/paypal`;
  return new PayPalProvider({
    vaultId: env.PAYPAL_VAULT_ID || undefined,
    returnUrl: `${base}/return`,
    cancelUrl: `${base}/cancel`,
  });
}
