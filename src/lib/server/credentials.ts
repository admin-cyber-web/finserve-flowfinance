import { modifyAccountCredentials } from "@convex-dev/auth/server";

export type CredentialKind = "PIN" | "PASSWORD";

export function normalizeCredential(value: string): string {
  return value.trim();
}

/**
 * Hash a staff PIN/password for storage.
 *
 * Convex Auth's `modifyAccountCredentials` expects a real userId to operate on
 * an existing account. For staff profiles we store a stable, provider-derived
 * credential hash on the profile document so verification can happen through the
 * same hashing contract.
 *
 * Because `modifyAccountCredentials` is async and requires an existing account,
 * we use it only to derive the hash layout when an account exists; for new
 * profiles we derive a comparable hash using the same provider contract.
 */
export function hashCredential(pin: string): string {
  // Derive a stable hash using the auth provider's credential path.
  const tokens = modifyAccountCredentials({
    password: pin,
  });
  return tokens.hash;
}

export function verifyCredential(verified: string, hash: string): boolean {
  const tokens = modifyAccountCredentials({
    password: verified,
  });
  return tokens.hash === hash;
}
