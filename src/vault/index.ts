/**
 * Encrypted vault subsystem — app-agnostic.
 *
 * Wraps tauri-plugin-stronghold (credential store + a per-device document
 * encryption key), AES-256-GCM document-blob sealing, and an on-disk encrypted
 * blob store. Everything is created through {@link createVault} with an injected
 * {@link VaultConfig} — there is NO module-level state, so two apps can hold
 * independent vaults in the same process.
 *
 * ──────────────────────────────────────────────────────────────────────────
 *  ⚠️  PER-APP SECRET — DO NOT GENERALISE INTO THIS LIBRARY  ⚠️
 *  The Argon2id snapshot-key derivation (salt + params) lives on the RUST side
 *  (each app's `src-tauri/src/lib.rs` Stronghold builder), NOT here. It is
 *  PER-APP and MUST NEVER CHANGE for an existing app — changing the salt/params
 *  bricks every existing user's vault (their snapshot becomes undecryptable).
 *  This TS wrapper only needs the app's `clientName` + `snapshotFile`; the
 *  key-derivation secret stays in the app's Rust shell. See CONTRACT.md.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { isTauri } from "../env/index.js";

/** A stored credential blob. Generic enough to reuse; apps may store any JSON. */
export interface Credential {
  label: string;
  username: string;
  password: string;
  notes?: string;
}

export interface VaultConfig {
  /** Stronghold client name, e.g. "myfinance". App-specific, stable. */
  clientName: string;
  /** Snapshot file name under appDataDir, e.g. "vault.stronghold". App-specific, stable. */
  snapshotFile: string;
  /** Stronghold record holding the 256-bit document encryption key. Default "doc-master-key-v1". */
  docKeyRecord?: string;
  /** Subdir under appDataDir for encrypted blob files. Default "documents". */
  documentsSubdir?: string;
}

export interface Vault {
  /** Open (and create on first use) the vault. Throws on wrong password. */
  unlock(password: string): Promise<void>;
  isUnlocked(): boolean;
  lock(): Promise<void>;
  saveSnapshot(): Promise<void>;
  putCredential(key: string, cred: Credential): Promise<void>;
  getCredential(key: string): Promise<Credential | null>;
  removeCredential(key: string): Promise<void>;
  newCredentialKey(): string;
  /** Read/lazily-create the per-device document encryption key (DEK). Requires unlock. */
  getOrCreateDocumentKey(): Promise<Uint8Array>;
  /** Seal bytes with this vault's DEK (versioned + optional AAD). Requires unlock. */
  sealBytes(plain: Uint8Array, aad?: string): Promise<Uint8Array>;
  /** Open bytes sealed by {@link sealBytes} (pass the same AAD). Requires unlock. */
  openBytes(sealed: Uint8Array, aad?: string): Promise<Uint8Array>;
  /** Encrypt bytes and write under a fresh uuid file name (returned). Desktop only. */
  saveBlob(bytes: Uint8Array): Promise<string>;
  /** Read + decrypt a stored blob. Desktop only, requires unlock. */
  readBlob(fileName: string): Promise<Uint8Array>;
  /** Delete a stored blob; ignores an already-gone file. */
  deleteBlob(fileName: string): Promise<void>;
}

const IV_BYTES = 12;
const SEAL_ENC = new TextEncoder();

/**
 * Sealed-blob format version (v1): `magic("SCV1") || iv(12) || ciphertext`, with the
 * magic (plus any caller AAD) bound as AES-GCM Additional Authenticated Data so a
 * blob can be tied to its context (e.g. its filename) and not swapped. Legacy blobs
 * have NO magic (`iv(12) || ciphertext`, no AAD) and stay readable. See THREAT_MODEL.md §5.
 */
export const SEAL_FORMAT_VERSION = 1;
const SEAL_MAGIC = SEAL_ENC.encode("SCV1"); // 4 bytes
const asSrc = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function hasSealMagic(b: Uint8Array): boolean {
  if (b.length < SEAL_MAGIC.length + IV_BYTES) return false;
  for (let i = 0; i < SEAL_MAGIC.length; i++) if (b[i] !== SEAL_MAGIC[i]) return false;
  return true;
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asSrc(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Seal plaintext with a raw 256-bit key → v1 `magic || iv(12) || ciphertext`. Pure
 * crypto, no vault dependency — exposed standalone so the format is testable by
 * injecting a key. Optional `aad` is bound as AAD (callers pass e.g. a record id /
 * filename so the blob can't be relocated to a different context).
 */
export async function sealWithKey(raw: Uint8Array, plain: Uint8Array, aad?: string): Promise<Uint8Array> {
  const key = await importAesKey(raw);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const additional = aad ? concatBytes(SEAL_MAGIC, SEAL_ENC.encode(aad)) : SEAL_MAGIC;
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: asSrc(additional) }, key, asSrc(plain)),
  );
  return concatBytes(SEAL_MAGIC, iv, ct);
}

/** Open bytes sealed by {@link sealWithKey} (v1 or legacy) with the same raw key + AAD. */
export async function openWithKey(raw: Uint8Array, sealed: Uint8Array, aad?: string): Promise<Uint8Array> {
  const key = await importAesKey(raw);
  if (hasSealMagic(sealed)) {
    const iv = sealed.slice(SEAL_MAGIC.length, SEAL_MAGIC.length + IV_BYTES);
    const ct = sealed.slice(SEAL_MAGIC.length + IV_BYTES);
    const additional = aad ? concatBytes(SEAL_MAGIC, SEAL_ENC.encode(aad)) : SEAL_MAGIC;
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: asSrc(additional) }, key, asSrc(ct)),
    );
  }
  // Legacy: iv(12) || ciphertext, no AAD.
  if (sealed.length <= IV_BYTES) throw new Error("Sealed blob is too short to be valid.");
  const iv = sealed.slice(0, IV_BYTES);
  const ct = sealed.slice(IV_BYTES);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, asSrc(ct)),
  );
}

interface StrongholdSession {
  store: {
    insert(key: string, value: number[]): Promise<void>;
    get(key: string): Promise<Uint8Array | null>;
    remove(key: string): Promise<Uint8Array | null>;
  };
  save: () => Promise<void>;
  unloadStronghold: () => Promise<void>;
}

/**
 * Build a vault bound to one app's config. State (the unlocked session + the
 * op-chain) is closed over locally, so this is safe to call once per app and the
 * returned methods can be freely destructured (they are closures, not `this`-bound).
 */
export function createVault(cfg: VaultConfig): Vault {
  const docKeyRecord = cfg.docKeyRecord ?? "doc-master-key-v1";
  const documentsSubdir = cfg.documentsSubdir ?? "documents";

  let session: StrongholdSession | null = null;

  /**
   * All Stronghold operations are serialized through this promise chain.
   * tauri-plugin-stronghold's snapshot writer is not safe against overlapping
   * save() calls or two load handles open on the same snapshot at once; queuing
   * guarantees exactly one vault operation runs at a time so the app cannot
   * deadlock itself. Each link continues regardless of the previous op's outcome.
   */
  let opChain: Promise<unknown> = Promise.resolve();
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = opChain.then(fn, fn);
    opChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function snapshotPath(): Promise<string> {
    const { appDataDir } = await import("@tauri-apps/api/path");
    const dir = await appDataDir();
    return `${dir}/${cfg.snapshotFile}`;
  }

  async function unlockInner(password: string): Promise<void> {
    if (!isTauri()) throw new Error("Vault requires the desktop app.");
    // Lock any existing session first so the new password is validated against
    // the snapshot rather than silently inheriting the previous session.
    if (session) await lockInner();

    const { Stronghold, Client } = await import("@tauri-apps/plugin-stronghold");
    void Client; // keep import for type compatibility
    const path = await snapshotPath();
    const stronghold = await Stronghold.load(path, password);

    let client;
    try {
      client = await stronghold.loadClient(cfg.clientName);
    } catch {
      client = await stronghold.createClient(cfg.clientName);
    }
    const store = client.getStore();

    session = {
      store: {
        insert: (key, value) => store.insert(key, value),
        get: (key) => store.get(key) as Promise<Uint8Array | null>,
        remove: (key) => store.remove(key) as Promise<Uint8Array | null>,
      },
      save: () => stronghold.save(),
      unloadStronghold: async () => {
        await stronghold.save();
        await stronghold.unload();
      },
    };
  }

  async function lockInner(): Promise<void> {
    if (!session) return;
    try {
      await session.unloadStronghold();
    } finally {
      session = null;
    }
  }

  function requireSession(): StrongholdSession {
    if (!session) throw new Error("Vault is locked. Unlock it first.");
    return session;
  }

  async function getOrCreateDocumentKey(): Promise<Uint8Array> {
    return withLock(async () => {
      const s = requireSession();
      const existing = await s.store.get(docKeyRecord);
      if (existing && existing.length === 32) return existing;
      const key = new Uint8Array(32);
      crypto.getRandomValues(key);
      await s.store.insert(docKeyRecord, Array.from(key));
      await s.save();
      return key;
    });
  }

  async function docDir(): Promise<string> {
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    return join(await appDataDir(), documentsSubdir);
  }
  async function filePath(fileName: string): Promise<string> {
    const { join } = await import("@tauri-apps/api/path");
    return join(await docDir(), fileName);
  }

  const sealBytes = async (plain: Uint8Array, aad?: string) =>
    sealWithKey(await getOrCreateDocumentKey(), plain, aad);
  const openBytes = async (sealed: Uint8Array, aad?: string) =>
    openWithKey(await getOrCreateDocumentKey(), sealed, aad);

  return {
    unlock: (password) => withLock(() => unlockInner(password)),
    isUnlocked: () => session != null,
    lock: () => withLock(lockInner),
    saveSnapshot: () =>
      withLock(async () => {
        if (!session) return;
        await session.save();
      }),
    putCredential: (key, cred) =>
      withLock(async () => {
        const s = requireSession();
        const bytes = Array.from(new TextEncoder().encode(JSON.stringify(cred)));
        await s.store.insert(key, bytes);
        await s.save();
      }),
    getCredential: (key) =>
      withLock(async () => {
        const s = requireSession();
        const bytes = await s.store.get(key);
        if (!bytes || bytes.length === 0) return null;
        return JSON.parse(new TextDecoder().decode(bytes)) as Credential;
      }),
    removeCredential: (key) =>
      withLock(async () => {
        const s = requireSession();
        await s.store.remove(key);
        await s.save();
      }),
    newCredentialKey: () => `cred-${crypto.randomUUID()}`,
    getOrCreateDocumentKey,
    sealBytes,
    openBytes,
    saveBlob: async (bytes) => {
      if (!isTauri()) throw new Error("Documents require the desktop app.");
      const { mkdir, writeFile, exists } = await import("@tauri-apps/plugin-fs");
      const dir = await docDir();
      if (!(await exists(dir))) await mkdir(dir, { recursive: true });
      const fileName = crypto.randomUUID();
      // Bind the blob to its filename (AAD) so a sealed file can't be relocated.
      const sealed = await sealBytes(bytes, fileName);
      await writeFile(await filePath(fileName), sealed);
      return fileName;
    },
    readBlob: async (fileName) => {
      if (!isTauri()) throw new Error("Documents require the desktop app.");
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const sealed = await readFile(await filePath(fileName));
      return openBytes(sealed, fileName);
    },
    deleteBlob: async (fileName) => {
      if (!isTauri()) return;
      const { remove, exists } = await import("@tauri-apps/plugin-fs");
      const path = await filePath(fileName);
      if (await exists(path)) await remove(path);
    },
  };
}
