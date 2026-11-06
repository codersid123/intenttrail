import { CompactSign, compactVerify, decodeJwt, importJWK, type JWK } from "jose";
import { createHash } from "node:crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Sign any JSON object as a compact JWS (EdDSA / Ed25519). */
export async function signJws(payload: object, privateJwk: JWK): Promise<string> {
  const key = await importJWK(privateJwk, "EdDSA");
  return new CompactSign(enc.encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "EdDSA" })
    .sign(key);
}

/** Verify signature; returns the payload. Throws if the signature is bad. */
export async function verifyJws<T>(jws: string, publicJwk: JWK): Promise<T> {
  const key = await importJWK(publicJwk, "EdDSA");
  const { payload } = await compactVerify(jws, key, { algorithms: ["EdDSA"] });
  return JSON.parse(dec.decode(payload)) as T;
}

/** Read the payload WITHOUT checking the signature (for display / lookups only). */
export function decodeJws<T>(jws: string): T {
  return decodeJwt(jws) as T;
}
