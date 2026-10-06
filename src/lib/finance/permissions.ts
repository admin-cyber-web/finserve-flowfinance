import type { FsRole } from "./types";

/**
 * Role based access control.
 *
 * The SERVER enforces these permissions on every mutation/query
 * (`requirePermission` in convex/helpers.ts). The UI only uses `can()` to hide
 * actions the user could never perform — never as the sole guard.
 */

export const PERMISSIONS = [
  "view_clients",
  "create_client",
  "edit_client",
  "view_loans",
  "create_loan",
  "approve_loan",
  "disburse_loan",
  "collect_payment",
  "cash_handover",
  "wallet_management",
  "reports",
  "accounting",
  "staff_management",
  "block_staff",
  "audit_logs",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<Permission, string> = {
  view_clients: "View clients",
  create_client: "Create client",
  edit_client: "Edit client",
  view_loans: "View loans",
  create_loan: "Create loan application",
  approve_loan: "Approve loan",
  disburse_loan: "Disburse loan",
  collect_payment: "Collect payment",
  cash_handover: "Cash handover",
  wallet_management: "Wallet management",
  reports: "Reports",
  accounting: "Accounting",
  staff_management: "Staff management",
  block_staff: "Block / suspend staff",
  audit_logs: "Audit logs",
};

const ALL = [...PERMISSIONS];

/** Default effective permissions per role (admins can override per user). */
export const ROLE_PERMISSIONS: Record<FsRole, Permission[]> = {
  SUPER_ADMIN: ALL,
  BRANCH_MANAGER: [
    "view_clients",
    "create_client",
    "edit_client",
    "view_loans",
    "create_loan",
    "approve_loan",
    "disburse_loan",
    "collect_payment",
    "cash_handover",
    "wallet_management",
    "reports",
  ],
  FIELD_STAFF: [
    "view_clients",
    "create_client",
    "edit_client",
    "view_loans",
    "create_loan",
    "disburse_loan",
    "collect_payment",
    "cash_handover",
    "reports",
  ],
  ACCOUNTANT: [
    "view_clients",
    "view_loans",
    "wallet_management",
    "reports",
    "accounting",
    "audit_logs",
  ],
  CLIENT: ["view_loans"],
};

/** Effective permissions: explicit per-user overrides win over role defaults. */
export function effectivePermissions(profile: {
  role: string;
  permissions?: string[] | null;
}): Permission[] {
  if (profile.permissions && profile.permissions.length > 0) {
    return profile.permissions.filter((p): p is Permission =>
      (PERMISSIONS as readonly string[]).includes(p),
    );
  }
  return ROLE_PERMISSIONS[profile.role as FsRole] ?? [];
}

/** UI helper — the server re-checks everything. */
export function can(
  profile: { role: string; permissions?: string[] | null } | null | undefined,
  permission: Permission,
): boolean {
  if (!profile) return false;
  return effectivePermissions(profile).includes(permission);
}

export function canAny(
  profile: { role: string; permissions?: string[] | null } | null | undefined,
  ...permissions: Permission[]
): boolean {
  return permissions.some((p) => can(profile, p));
}
