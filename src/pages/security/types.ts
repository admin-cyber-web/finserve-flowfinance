import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { SecurityPermission } from "@/lib/security/permissions";

export type SecSession = NonNullable<
  FunctionReturnType<typeof api.security.session>
>;

export type SecOperator = NonNullable<SecSession["operator"]>;

export function canSecurity(
  session: SecSession,
  permission: string,
): boolean {
  return !!session.operator?.permissions.includes(
    permission as SecurityPermission,
  );
}
