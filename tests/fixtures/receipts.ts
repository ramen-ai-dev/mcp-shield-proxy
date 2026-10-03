/**
 * Signed Schema V5 receipts for tests.
 *
 * A generated Ed25519 key stands in for ramen_pk_v1, whose private half is
 * not available. Pass TEST_PUBLIC_KEYS as `publicKeys` so the proxy verifies
 * against it.
 */

const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;

export const TEST_PUBLIC_KEYS: Record<string, string> = {
  ramen_pk_v1: Buffer.from(await crypto.subtle.exportKey("spki", keyPair.publicKey)).toString("base64"),
};

export const RECEIPT_ID = "8d1f2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

export interface TestReceipt {
  id: string;
  schema_version: string;
  kid: string;
  signature: string;
  canonical_payload: string;
}

export async function signedReceipt(options: { verdict?: 0 | 1; id?: string; tamper?: boolean } = {}): Promise<TestReceipt> {
  const id = options.id ?? RECEIPT_ID;
  const canonical = JSON.stringify({
    id,
    schema_version: "5.0",
    kid: "ramen_pk_v1",
    verdict: options.verdict ?? 1,
    payload_hash: "covered-by-receiptVerified",
  });
  const signature = await crypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(canonical));
  return {
    id,
    schema_version: "5.0",
    kid: "ramen_pk_v1",
    signature: Buffer.from(signature).toString("base64url"),
    canonical_payload: options.tamper ? canonical.replace('"verdict":1', '"verdict":0') : canonical,
  };
}
