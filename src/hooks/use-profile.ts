import { useEffect, useState } from "react";
import { useAuth } from "./use-auth";
import { can, type Permission } from "@/lib/finance/permissions";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";

/**
 * The signed-in FinServe identity: user + workspace profile + effective
 * permissions, plus helpers the whole app shares.
 */
export function useProfile() {
  const data = useQuery(api.profiles.me);
  const { isLoading: authLoading, isAuthenticated, signOut, signIn } = useAuth();
  const profile = data?.profile ?? null;
  const loading = authLoading || data === undefined;

  return {
    loading,
    isAuthenticated,
    user: data?.user ?? null,
    profile,
    branch: profile?.branch ?? null,
    permissions: data?.permissions ?? [],
    role: profile?.role ?? null,
    status: profile?.status ?? null,
    joiningDate: profile?.joiningDate ?? null,
    personaLoaded: profile?.personaLoaded ?? false,
    can: (permission: Permission) => can(profile, permission),
    signOut,
    signIn,
  };
}

/** Negotiates the current app session state. (Unused legacy helper.) */
export function useSession() {
  const { isAuthenticated, signOut } = useAuth();
  const data = useQuery(api.profiles.me);
  const profile = data?.profile ?? null;

  const active =
    isAuthenticated &&
    profile &&
    (profile.status === "ACTIVE" || profile.status === "CLIENT");

  return {
    active,
    profile,
    role: profile?.role ?? null,
    isAuthenticated,
    signOut,
    canJoinWorkspace: isAuthenticated && !profile,
    needWorkspaceSelection:
      isAuthenticated && !profile && !!signOut,
  };
}

/**
 * Demo seeding has been permanently disabled: the dashboard boots straight
 * into the real workspace (which may be empty) and never creates sample
 * users, clients, loans, wallets or transactions.
 */
export function useSeed() {
  return "ready" as const;
}

/** True while the browser is offline (used by the field-sync banner). */
export function useOnline() {
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}
