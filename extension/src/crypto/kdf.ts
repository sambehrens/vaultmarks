import { argon2id } from "@noble/hashes/argon2.js";

// Matches OWASP's minimum recommended Argon2id parameters (2023).
const ARGON2_PARAMS = {
  p: 1,   // parallelism
  t: 3,   // time cost (iterations)
  m: 65536, // memory (KB) — 64 MB
  dkLen: 32,
} as const;

export interface DerivedKeyMaterial {
  /** Base64-encoded key sent to the server for authentication. Never the master password. */
  authKey: string;
  /**
   * Raw 32-byte key used to encrypt/decrypt the Protected Symmetric Key (PSK).
   * The PSK is a random AES-256-GCM key stored on the server, encrypted with
   * this wrapping key. Changing the master password only re-wraps the PSK —
   * all encrypted data remains valid because the underlying symmetric key is
   * unchanged.
   */
  wrappingKeyBytes: Uint8Array;
}

/**
 * Derives auth and wrapping key material from the master password and email.
 * Must be called from a page context (popup), not a service worker.
 *
 * Pipeline:
 *   masterPassword + email → Argon2id → masterKeyBytes
 *   masterKeyBytes → HKDF("aegis-auth-v1")     → authKey (base64)
 *   masterKeyBytes → HKDF("aegis-wrapping-v1") → wrappingKeyBytes (Uint8Array)
 */
export async function deriveKeys(masterPassword: string, email: string): Promise<DerivedKeyMaterial> {
  const enc = new TextEncoder();

  const masterKeyBytes = argon2id(
    enc.encode(masterPassword),
    enc.encode(email.toLowerCase() + ":aegis-salt-v1"),
    ARGON2_PARAMS,
  );

  const keyMaterial = await crypto.subtle.importKey("raw", masterKeyBytes, { name: "HKDF" }, false, ["deriveBits"]);

  const [authKeyBits, wrappingKeyBits] = await Promise.all([
    crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode("aegis-auth-v1") },
      keyMaterial,
      256,
    ),
    crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode("aegis-wrapping-v1") },
      keyMaterial,
      256,
    ),
  ]);

  return {
    authKey: btoa(String.fromCharCode(...new Uint8Array(authKeyBits))),
    wrappingKeyBytes: new Uint8Array(wrappingKeyBits),
  };
}
