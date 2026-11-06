import { env } from "../config";

type TokenResponse = {
  access_token: string;
  expires_in: number; // seconds
  scope: string; // space-separated permissions
  app_id: string;
};

let cached: { token: string; expiresAt: number; scope: string } | null = null;

export async function getAccessToken() {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached;

  const basic = Buffer.from(
    `${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await fetch(`${env.PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok)
    throw new Error(`PayPal OAuth failed (${res.status}): ${await res.text()}`);

  const data = (await res.json()) as TokenResponse;
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  };
  return cached;
}
