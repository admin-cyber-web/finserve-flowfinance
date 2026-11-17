/**
 * Security Department authorization model — deliberately separate from the
 * KMC staff permission model in `src/lib/finance/permissions.ts`.
 *
 * Nothing here is derived from a staff profile or an `effectiveRole`. A normal
 * SUPER_ADMIN holds none of these permissions: they live only on
 * `securityOperators` rows and are re-read from the database on every security
 * query/mutation (never from the client).
 */
export const SECURITY_PERMISSIONS = [
  "security.portal.access",
  "security.devices.read",
  "security.devices.approve",
  "security.devices.block",
  "security.devices.revoke",
  "security.devices.replace",
  "security.events.read",
  "security.incidents.manage",
  "security.settings.update",
  "security.operators.manage",
  "security.credentials.rotate",
] as const;

export type SecurityPermission = (typeof SECURITY_PERMISSIONS)[number];

export const SECURITY_PERMISSION_LABELS: Record<SecurityPermission, string> = {
  "security.portal.access": "Open the Security Department portal",
  "security.devices.read": "View registered and pending devices",
  "security.devices.approve": "Approve or reject device requests",
  "security.devices.block": "Block or unblock devices",
  "security.devices.revoke": "Revoke device credentials",
  "security.devices.replace": "Execute emergency device replacement",
  "security.events.read": "Read security events and audit history",
  "security.incidents.manage": "Open and investigate security incidents",
  "security.settings.update": "Change security configuration and session policy",
  "security.operators.manage": "Create, modify and disable security operators",
  "security.credentials.rotate": "Rotate security PIN and recovery credentials",
};

export const SECURITY_ROLES = [
  "SECURITY_ADMIN",
  "SECURITY_OFFICER",
  "SECURITY_AUDITOR",
] as const;

export type SecurityRole = (typeof SECURITY_ROLES)[number];

export const SECURITY_ROLE_LABELS: Record<SecurityRole, string> = {
  SECURITY_ADMIN: "Security Administrator",
  SECURITY_OFFICER: "Security Officer",
  SECURITY_AUDITOR: "Security Auditor (read only)",
};

export const SECURITY_ROLE_PERMISSIONS: Record<
  SecurityRole,
  SecurityPermission[]
> = {
  SECURITY_ADMIN: [...SECURITY_PERMISSIONS],
  SECURITY_OFFICER: [
    "security.portal.access",
    "security.devices.read",
    "security.devices.approve",
    "security.devices.block",
    "security.devices.revoke",
    "security.devices.replace",
    "security.events.read",
    "security.incidents.manage",
  ],
  SECURITY_AUDITOR: [
    "security.portal.access",
    "security.devices.read",
    "security.events.read",
  ],
};

/** Least privilege: a permission must be explicitly present on the operator. */
export function hasSecurityPermission(
  operator: { permissions: readonly string[] },
  permission: SecurityPermission,
): boolean {
  return operator.permissions.includes(permission);
}

/** Operator credentials: 10–72 chars, letters AND digits. */
export function credentialPolicyError(credential: string): string | null {
  const value = credential.trim();
  if (value.length < 10) return "Credential must be at least 10 characters.";
  if (value.length > 72) return "Credential must be at most 72 characters.";
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return "Credential must contain both letters and numbers.";
  }
  return null;
}

/**
 * Department PIN policy after activation: six digits, no repeats, no runs,
 * never the one-time bootstrap code.
 */
export function pinPolicyError(pin: string, bootstrapPin = "9560"): string | null {
  if (!/^\d{6}$/.test(pin)) return "New PIN must be exactly 6 digits.";
  if (pin === bootstrapPin) return "That is the one-time activation PIN.";
  if (/^(\d)\1{5}$/.test(pin)) return "PIN cannot be a single repeated digit.";
  const digits = pin.split("").map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  if (ascending || descending) return "PIN cannot be a sequence like 123456.";
  if (["000000", "111111", "123123", "121212"].includes(pin)) {
    return "Choose a less predictable PIN.";
  }
  return null;
}

/** Where each module lives, for the command-center navigation. */
export const SECURITY_MODULES = [
  { key: "overview", label: "Command Center", permission: "security.portal.access" },
  { key: "devices", label: "Device Authorization", permission: "security.devices.read" },
  { key: "events", label: "Security Monitoring", permission: "security.events.read" },
  { key: "incidents", label: "Incidents", permission: "security.events.read" },
  { key: "operators", label: "Operators", permission: "security.operators.manage" },
  { key: "audit", label: "Audit History", permission: "security.events.read" },
  { key: "settings", label: "Configuration", permission: "security.settings.update" },
] as const;
