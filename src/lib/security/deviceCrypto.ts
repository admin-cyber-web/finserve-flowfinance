/**
 * Browser-side cryptographic device identity.
 *
 * The device holds an ECDSA P-256 key pair generated with WebCrypto:
 *   • the PRIVATE key is re-imported as NON-EXTRACTABLE and kept in IndexedDB
 *     (CryptoKey structured clone) — JavaScript can sign with it, nothing can
 *     read it out,
 *   • only the PUBLIC JWK is sent to the Security Department.
 *
 * Clearing browser data destroys the key; the backend then refuses all
 * signatures for that enrollment, which is exactly what "new device" means.
 * A copied localStorage/device id cannot sign, so it cannot authenticate.
 */

const DB_NAME = "kmc-security-device";
const DB_VERSION = 1;
const STORE = "keys";
const KEYPAIR_ID = "device-keypair";
const IDENTITY_KEY = "kmc.security.device.identity";

export interface DeviceIdentity {
  enrollmentId: string;
  staffId: string;
  publicKeyFingerprint?: string;
}

export interface StoredKeyPair {
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbSet(key: string, value: unknown): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export function getStoredIdentity(): DeviceIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DeviceIdentity;
    if (!parsed?.enrollmentId || !parsed?.staffId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function storeIdentity(identity: DeviceIdentity | null): void {
  try {
    if (identity) localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
    else localStorage.removeItem(IDENTITY_KEY);
  } catch {
    /* storage disabled — the enrollment simply won't persist */
  }
}

function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i += 1) out += String.fromCharCode(view[i]);
  return btoa(out);
}

/**
 * Load — or create — this browser's device key pair.
 * The returned private key is non-extractable.
 */
export async function ensureDeviceKey(): Promise<StoredKeyPair> {
  const stored = await idbGet<StoredKeyPair>(KEYPAIR_ID);
  if (stored?.privateKey && stored.publicKeyJwk) return stored;

  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  // Re-import WITHOUT extractability: the stored key can sign but never be
  // exported again.
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const next: StoredKeyPair = { privateKey, publicKeyJwk };
  const persisted = await idbSet(KEYPAIR_ID, next);
  if (!persisted) {
    throw new Error(
      "This browser cannot store the device key (IndexedDB unavailable). Device authorization cannot be completed.",
    );
  }
  return next;
}

/** Sign the server's challenge with the non-exportable device key. */
export async function signChallenge(challenge: string): Promise<string> {
  const { privateKey } = await ensureDeviceKey();
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(challenge),
  );
  return base64(signature);
}

/** Human-readable device descriptor (reported, not verified hardware). */
export function deviceDescriptor(): {
  label: string;
  platform: string;
  userAgent: string;
  browser: string;
  browserVersion: string;
  os: string;
  category: string;
} {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const version = (re: RegExp) => re.exec(ua)?.[1] ?? "";
  const os = /Windows NT/i.test(ua)
    ? "Windows"
    : /Android/i.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/i.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/i.test(ua)
          ? "macOS"
          : /CrOS/i.test(ua)
            ? "ChromeOS"
            : /Linux/i.test(ua)
              ? "Linux"
              : "Unknown";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const browserVersion =
    browser === "Safari"
      ? version(/Version\/([\d.]+)/)
      : version(/(?:Edg|OPR|Chrome|Firefox)\/([\d.]+)/);
  const category = /iPad|Tablet|PlayBook|Silk/i.test(ua)
    ? "Tablet"
    : /Mobi|Android|iPhone|iPod/i.test(ua)
      ? "Mobile"
      : /Macintosh|Mac OS X/i.test(ua)
        ? "Laptop"
        : "Desktop";
  return {
    label: `${browser} · ${os}`.slice(0, 80),
    platform: os,
    userAgent: ua.slice(0, 300),
    browser,
    browserVersion,
    os,
    category,
  };
}
