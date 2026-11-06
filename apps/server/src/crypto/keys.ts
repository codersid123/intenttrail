import { exportJWK, generateKeyPair, type JWK } from "jose";
import type { DB } from "../db/db";

export type PrincipalKind = "user" | "agent" | "merchant";

/** Create a principal with a fresh Ed25519 key pair (no-op if it already exists). */
export async function createPrincipal(db: DB, id: string, kind: PrincipalKind): Promise<void> {
  const exists = db.prepare("SELECT 1 FROM principals WHERE id = ?").get(id);
  if (exists) return;
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  db.prepare("INSERT INTO principals (id, kind, public_jwk, private_jwk) VALUES (?, ?, ?, ?)").run(
    id,
    kind,
    JSON.stringify(await exportJWK(publicKey)),
    JSON.stringify(await exportJWK(privateKey))
  );
}

type Row = { kind: PrincipalKind; public_jwk: string; private_jwk: string };

function getRow(db: DB, id: string): Row {
  const row = db.prepare("SELECT kind, public_jwk, private_jwk FROM principals WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw new Error(`Unknown principal: ${id}`);
  return row;
}

export const getPublicJwk = (db: DB, id: string): JWK => JSON.parse(getRow(db, id).public_jwk);
export const getPrivateJwk = (db: DB, id: string): JWK => JSON.parse(getRow(db, id).private_jwk);
export const getKind = (db: DB, id: string): PrincipalKind => getRow(db, id).kind;
