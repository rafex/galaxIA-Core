/**
 * Identidad de nodo FHS: Ed25519 keypair → PeerId libp2p + DID did:key:z...
 * La misma clave sirve para ambos — no hay dos identidades distintas.
 */

import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { fromString, toString } from "uint8arrays";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { PrivateKey } from "@libp2p/interface";
import type { PeerId } from "@libp2p/interface";

const ED25519_MULTICODEC_PREFIX = Uint8Array.from([0xed, 0x01]);
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let value = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let out = "";
  while (value > 0n) {
    const remainder = value % 58n;
    out = BASE58_ALPHABET[Number(remainder)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) out = BASE58_ALPHABET[0] + out;
    else break;
  }
  return out;
}

/** Deriva un `did:key:z...` a partir de los 32 bytes crudos de la clave pública Ed25519. */
export function publicKeyRawToDid(rawPublicKey: Uint8Array): string {
  const prefixed = Uint8Array.from([...ED25519_MULTICODEC_PREFIX, ...rawPublicKey]);
  return `did:key:z${base58Encode(prefixed)}`;
}

export interface FhsIdentity {
  /** did:key:z... derivado de la clave pública Ed25519 del nodo. */
  did: string;
  /** PeerId libp2p derivado de la misma clave. */
  peerId: PeerId;
  /** Clave privada en formato libp2p (para firmar y para createFhsNode). */
  privateKey: PrivateKey;
}

/** Genera una nueva identidad Ed25519. */
export async function generateFhsIdentity(): Promise<FhsIdentity> {
  const privateKey = await generateKeyPair("Ed25519");
  const peerId = peerIdFromPrivateKey(privateKey);
  const did = publicKeyRawToDid(privateKey.publicKey.raw);
  return { did, peerId, privateKey };
}

/**
 * Carga la identidad desde un archivo JSON o genera una nueva y la persiste.
 * El archivo almacena la clave privada como base64pad (formato protobuf libp2p).
 * NUNCA incluir este archivo en git — debe estar en .gitignore.
 */
export async function loadOrCreateFhsIdentity(keyPath: string): Promise<FhsIdentity> {
  if (existsSync(keyPath)) {
    const raw = JSON.parse(readFileSync(keyPath, "utf-8")) as { key: string };
    const bytes = fromString(raw.key, "base64pad");
    const privateKey = privateKeyFromProtobuf(bytes);
    const peerId = peerIdFromPrivateKey(privateKey);
    const did = publicKeyRawToDid(privateKey.publicKey.raw);
    return { did, peerId, privateKey };
  }
  const identity = await generateFhsIdentity();
  const bytes = privateKeyToProtobuf(identity.privateKey);
  writeFileSync(keyPath, JSON.stringify({ key: toString(bytes, "base64pad") }), "utf-8");
  return identity;
}
