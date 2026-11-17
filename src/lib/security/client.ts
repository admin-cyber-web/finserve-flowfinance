/**
 * Browser-side helpers for the independent Security Department portal.
 *
 * The security session token is a bearer value kept under its own storage key.
 * It is deliberately NOT the Convex Auth session: losing it (or clearing the
 * key) never grants anything, and a compromised KMC staff login cannot mint
 * one — only `/security/login` can, and only with the department PIN plus an
 * operator credential.
 */
const TOKEN_KEY = "kmc.security.session";
const DEVICE_KEY = "kmc.device.fingerprint";

export type SecurityLoginResponse = {
  ok: boolean;
  message?: string;
  token?: string;
  expiresAt?: number;
  mustRotateCredential?: boolean;
  operator?: { operatorId: string; name: string; role: string };
};

export function getStoredSecurityToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeSecurityToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage disabled — the session simply won't persist */
  }
}

function siteUrl(): string {
  const base = (import.meta.env.VITE_CONVEX_URL as string | undefined) ?? "";
  return base.replace(/\.convex\.cloud\/?$/, ".convex.site").replace(/\/$/, "");
}

/**
 * Sign-in through the deployment edge, which attaches the real client IP to
 * the attempt record. Falls back to the Convex mutation if the edge endpoint
 * is unreachable (e.g. a local preview without the site URL).
 */
export async function securityLogin(
  input: { operatorId: string; credential: string; pin: string },
  fallback: (args: {
    operatorId: string;
    credential: string;
    pin: string;
    userAgent?: string;
  }) => Promise<SecurityLoginResponse>,
): Promise<SecurityLoginResponse> {
  try {
    const response = await fetch(`${siteUrl()}/security/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    const json = (await response.json()) as SecurityLoginResponse;
    if (typeof json?.ok === "boolean") return json;
  } catch {
    /* fall through */
  }
  return await fallback({ ...input, userAgent: navigator.userAgent });
}

/** Stable per-browser device fingerprint (a random UUID, not a browser probe). */
export function deviceFingerprint(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && /^[A-Za-z0-9:_-]{16,128}$/.test(existing)) return existing;
    const generated =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    localStorage.setItem(DEVICE_KEY, generated);
    return generated;
  } catch {
    return "unknown-device-000000000000";
  }
}

export function deviceDescriptor(): {
  fingerprint: string;
  label: string;
  platform: string;
  userAgent: string;
} {
  const ua = navigator.userAgent;
  const platform =
    /Android/i.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/i.test(ua)
        ? "iOS"
        : /Mac/i.test(ua)
          ? "macOS"
          : /Windows/i.test(ua)
            ? "Windows"
            : "Web";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Safari\//.test(ua)
        ? "Safari"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : "Browser";
  return {
    fingerprint: deviceFingerprint(),
    label: `${browser} · ${platform}`,
    platform,
    userAgent: ua.slice(0, 300),
  };
}
