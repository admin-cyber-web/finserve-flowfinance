/**
 * Cryptography for the independent Security Department.
 *
 * Runs on Web Crypto (`crypto.subtle`) so the same code works in the Convex
 * V8 runtime and in tests. Nothing here imports Node built-ins or the staff
 * credential helpers: staff PINs keep their existing hashing, and security
 * secrets never share a salt, format or code path with them.
 */

const HASH_ITERATIONS = 120_000;
const PBKDF2_PREFIX = "pbkdf2-sha256";

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return new Uint8Array();
    out[i] = byte;
  }
  return out;
}

export function randomHex(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

/** Constant-time string comparison (equal length inputs; hex digests). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function pbkdf2(secret: string, saltHex: string, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: fromHex(saltHex) as unknown as BufferSource,
      iterations,
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Salted PBKDF2-HMAC-SHA256. Stored format:
 * `pbkdf2-sha256$<iterations>$<saltHex>$<derivedHex>` — never a bare digest.
 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomHex(16);
  const derived = await pbkdf2(secret, salt, HASH_ITERATIONS);
  return `${PBKDF2_PREFIX}$${HASH_ITERATIONS}$${salt}$${toHex(derived)}`;
}

export async function verifySecret(
  secret: string,
  stored: string | undefined | null,
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== PBKDF2_PREFIX) return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isFinite(iterations) || iterations < 10_000) return false;
  if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }
  const derived = await pbkdf2(secret, salt, iterations);
  return timingSafeEqualHex(toHex(derived), expected);
}

export async function sha256Hex(value: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return toHex(new Uint8Array(buf));
}

/** Session/recovery tokens are 256-bit random values; only their hash is stored. */
export async function newSessionToken(): Promise<{
  token: string;
  tokenHash: string;
}> {
  const token = randomHex(32);
  return { token, tokenHash: await sha256Hex(`security-session:${token}`) };
}

export async function hashSessionToken(token: string): Promise<string> {
  return await sha256Hex(`security-session:${token}`);
}

/**
 * Human-transcribable emergency recovery code. Not derived from the PIN and
 * never stored in plaintext — only its PBKDF2 hash is persisted.
 */
export function newRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = (n: number) => {
    const buf = new Uint8Array(n);
    crypto.getRandomValues(buf);
    let out = "";
    for (let i = 0; i < n; i += 1) out += alphabet[buf[i] % alphabet.length];
    return out;
  };
  return `KMC-${pick(4)}-${pick(4)}-${pick(4)}`;
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

/**
 * Append-only audit integrity: each entry commits to the previous hash, so a
 * removed or edited row is detectable by recomputing the chain.
 */
export function auditPayload(entry: {
  seq: number;
  ref: string;
  operatorId: string;
  operatorName: string;
  action: string;
  targetType: string;
  targetId: string;
  previousState: string;
  newState: string;
  reason: string;
  eventRef: string;
  ip: string;
  at: number;
}): string {
  return [
    entry.seq,
    entry.ref,
    entry.operatorId,
    entry.operatorName,
    entry.action,
    entry.targetType,
    entry.targetId,
    entry.previousState,
    entry.newState,
    entry.reason,
    entry.eventRef,
    entry.ip,
    entry.at,
  ].join("\u0001");
}

export function auditHash(prevHash: string, payload: string): Promise<string> {
  return sha256Hex(`${prevHash}\u0002${payload}`);
}

export const SECURITY_HASH_ITERATIONS = HASH_ITERATIONS;
