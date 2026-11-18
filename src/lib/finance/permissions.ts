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

/* ----------------------- Backend SUPER_ADMIN grants ----------------------- */

/**
 * Accounts that hold the FULL SUPER_ADMIN power set while keeping their own
 * displayed designation (role).
 *
 * The grant is keyed on the immutable backend identity of one exact profile
 * (`_id` + the backend-generated staff number). Nothing the browser can send
 * — role, email, permissions list, localStorage — is ever consulted, so the
 * grant cannot be forged, and it never matches "any BRANCH_MANAGER": every
 * other profile keeps exactly the permissions its own role defines.
 *
 * The stored `role` field is NOT modified. `effectiveRole()` is what the
 * server authorizes with; the stored role keeps being what the UI shows as
 * the person's designation.
 */
export interface SuperAdminGrant {
  /** Convex profile id — immutable, unique to this one account. */
  profileId: string;
  /** Backend-generated staff number — immutable, never re-issued. */
  staffId: string;
  /** Designation that must keep displaying in the UI. */
  designation: string;
}

export const SUPER_ADMIN_GRANTS: SuperAdminGrant[] = [
  {
    profileId: "p574ae493kw1d8xcwsmqq262498ga2pc", // Pankaj Tiwari
    staffId: "0002", // System ID 10002 (legacy BM10002)
    designation: "Branch Manager",
  },
];

/** Anything shaped like a profile — full document or a partial test double. */
export interface GrantSubject {
  _id?: string;
  staffId?: string | null;
  role: string;
  permissions?: string[] | null;
}

/** True only for the exact accounts listed in `SUPER_ADMIN_GRANTS`. */
export function hasSuperAdminGrant(
  profile: GrantSubject | null | undefined,
): boolean {
  if (!profile?._id || !profile.staffId) return false;
  return SUPER_ADMIN_GRANTS.some(
    (g) => g.profileId === profile._id && g.staffId === profile.staffId,
  );
}

/**
 * The application owner: either a backend-granted account (see
 * `SUPER_ADMIN_GRANTS`) or an account whose stored role is literally
 * `SUPER_ADMIN`. Owners are the authority that registers and approves devices
 * for everyone else, so no device approval is required for them.
 */
export function hasOwnerAuthority(
  profile: GrantSubject | null | undefined,
): boolean {
  if (!profile) return false;
  return hasSuperAdminGrant(profile) || profile.role === "SUPER_ADMIN";
}

/**
 * The role the SERVER authorizes with: `SUPER_ADMIN` for granted accounts,
 * the stored role for everyone else. Display code must use the stored role
 * (`designationRole`) so the granted account keeps its own designation.
 */
export function effectiveRole(profile: GrantSubject): string {
  return hasSuperAdminGrant(profile) ? "SUPER_ADMIN" : profile.role;
}

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

/**
 * Effective permissions.
 *
 * A backend SUPER_ADMIN grant always returns the complete set — it can never
 * be narrowed by a stored per-user override. Otherwise explicit per-user
 * overrides win over role defaults.
 */
export function effectivePermissions(profile: GrantSubject): Permission[] {
  if (hasSuperAdminGrant(profile)) return ALL;
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
