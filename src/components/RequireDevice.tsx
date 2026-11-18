/**
 * Device gate — disconnected from the normal authentication flow.
 *
 * Mandatory device verification has been removed: staff sign in with Staff ID +
 * PIN and reach the dashboard directly. This component is kept (the security
 * modules and tables still exist) but no longer performs any challenge,
 * enrollment or approval, so it simply renders its children.
 */
import type { ReactNode } from "react";

export function RequireDevice({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
