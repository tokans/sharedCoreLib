// Clean fixture source: HTTPS only, strong KDF, CSPRNG. Used by `npm run selftest`.
export const FEED = "https://updates.example.com/suite";
export const PBKDF2_ITERATIONS = 600000;

/** A versioned sealed-blob header so the format can evolve (FORMAT_VERSION present). */
export const FORMAT_VERSION = 1;

export function newId(): string {
  return crypto.randomUUID();
}
