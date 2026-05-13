import bs58 from "bs58";
import { NATIVE_MINT } from "@solana/spl-token";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";

function toKeypair(secretKey: Uint8Array): Keypair {
  if (secretKey.length === 64) {
    return Keypair.fromSecretKey(secretKey);
  }

  if (secretKey.length === 32) {
    return Keypair.fromSeed(secretKey);
  }

  throw new Error(`unsupported secret key length: ${secretKey.length}. Expected 32 or 64 bytes.`);
}

function looksLikeJsonArray(value: string): boolean {
  return value.startsWith("[") && value.endsWith("]");
}

function parseJsonSecretKey(value: string): Uint8Array {
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("wallet secret JSON must be an array");
  }

  for (const item of parsed) {
    if (!Number.isInteger(item) || item < 0 || item > 255) {
      throw new Error("wallet secret JSON array must contain integers between 0 and 255");
    }
  }

  return Uint8Array.from(parsed);
}

function decodeBase64Strict(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("wallet secret is not valid base64");
  }

  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) {
    throw new Error("wallet secret base64 decoded to empty buffer");
  }

  return Uint8Array.from(decoded);
}

export function loadKeypairFromSecret(secret: string): Keypair {
  const trimmed = secret.trim();

  if (looksLikeJsonArray(trimmed)) {
    return toKeypair(parseJsonSecretKey(trimmed));
  }

  try {
    return toKeypair(bs58.decode(trimmed));
  } catch (bs58Error) {
    try {
      return toKeypair(decodeBase64Strict(trimmed));
    } catch (base64Error) {
      throw new Error(
        `wallet secret must be valid bs58 or base64: ${
          bs58Error instanceof Error ? bs58Error.message : String(bs58Error)
        }; ${base64Error instanceof Error ? base64Error.message : String(base64Error)}`
      );
    }
  }
}

export function isNativeMintAddress(mint: string | PublicKey): boolean {
  const value = typeof mint === "string" ? mint : mint.toBase58();
  return value === NATIVE_MINT.toBase58();
}

export function getTransactionSignatureBase58(transaction: Transaction | VersionedTransaction): string {
  const signature = transaction instanceof VersionedTransaction ? transaction.signatures[0] : transaction.signature;
  if (!signature) {
    throw new Error("transaction signature missing");
  }

  return bs58.encode(Buffer.from(signature));
}
