// AES-256-GCM encrypt / decrypt via the Web Crypto API.
// Wire format: [12-byte IV] || [ciphertext + 16-byte GCM tag]

/** Encrypts `plaintext` with `key`. Returns IV-prepended ciphertext as base64. */
export async function encrypt(key: CryptoKey, plaintext: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const result = new Uint8Array(12 + ciphertext.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(ciphertext), 12);
  return toBase64(result);
}

/** Decrypts a base64 blob produced by `encrypt`. */
export async function decrypt(key: CryptoKey, blob: string): Promise<Uint8Array> {
  const data = fromBase64(blob);
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new Uint8Array(plaintext);
}

export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function fromBase64(b64: string): Uint8Array {
  return new Uint8Array([...atob(b64)].map((c) => c.charCodeAt(0)));
}
