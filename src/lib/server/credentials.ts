const SALT = "finserve-credential-v1";

export type CredentialKind = "PIN" | "PASSWORD";

export function normalizeCredential(value: string): string {
  return value.trim();
}

export async function hashCredential(pin: string): Promise<string> {
  const payload = new TextEncoder().encode(`${SALT}:${pin}`);
  const buf = await globalThis.crypto.subtle.digest("SHA-256", payload);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex.slice(0, 64);
}

export async function verifyCredential(verified: string, hash: string): Promise<boolean> {
  return (await hashCredential(verified)) === hash;
}
