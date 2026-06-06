// Deliberately insecure fixture source — trips kdf-floor and tls-only.
export const PBKDF2_ITERS = 1000; // far below the 600k floor
export const FEED = "http://updates.example.com/suite"; // plaintext

export function weakToken(): string {
  const token = "tok-" + Math.random().toString(36); // non-CSPRNG secret
  return token;
}

export async function seal(key: CryptoKey, iv: Uint8Array, data: Uint8Array) {
  // AES-GCM with no format/version header.
  return crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
}
