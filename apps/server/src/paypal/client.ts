import { randomUUID } from "node:crypto";
import { env } from "../config";
import { PayPalApiError } from "./errors";

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
    signal: AbortSignal.timeout(30_000),
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

type RequestOpts = {
  body?: unknown; // JSON body
  form?: FormData; // multipart body (disputes); fetch sets the boundary header itself
  requestId?: string; // PayPal-Request-Id; auto-generated for POSTs if omitted
  headers?: Record<string, string>;
};

/** Call the PayPal REST API. Returns parsed JSON; throws PayPalApiError on non-2xx. */
export async function paypalRequest<T = any>(method: "GET" | "POST" | "PATCH", path: string, opts: RequestOpts = {}): Promise<T> {
  const { token } = await getAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Prefer: "return=representation",
    ...opts.headers,
  };
  if (method !== "GET") headers["PayPal-Request-Id"] = opts.requestId ?? randomUUID();
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${env.PAYPAL_BASE_URL}${path}`, {
    method,
    headers,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    signal: AbortSignal.timeout(30_000),
  });

  const text = await res.text();
  const json = text ? safeJson(text) : {};
  if (!res.ok) {
    const issue = json?.details?.[0]?.issue as string | undefined;
    const desc = json?.details?.[0]?.description ?? json?.message ?? text.slice(0, 300);
    throw new PayPalApiError(
      res.status,
      json?.name ?? `HTTP_${res.status}`,
      issue,
      json?.debug_id ?? res.headers.get("paypal-debug-id") ?? undefined,
      `${method} ${path} → ${res.status} ${json?.name ?? ""}${issue ? ` / ${issue}` : ""}: ${desc}`,
      json,
    );
  }
  return json as T;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** PayPal amounts are strings with 2 decimals. */
export const money = (usd: number) => ({ currency_code: "USD", value: usd.toFixed(2) });
