import { useEffect, useRef, useState } from "react";
import { useAuth } from "./use-auth";
import { can, type Permission } from "@/lib/finance/permissions";
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { useConvex, useQuery } from "convex/react";

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
    can: (permission: Permission) => can(profile, permission),
    signOut,
    signIn,
  };
}

/** Negotiates the current app session for demo + real sign-in. */
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

/** Idempotent demo-dataset bootstrap — runs once per browser session. */
export function useSeed() {
  const convex = useConvex();
  const [state, setState] = useState<"idle" | "seeding" | "ready" | "error">(
    "idle",
  );
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (sessionStorage.getItem("finserve-seeded") === "1") {
      setState("ready");
      return;
    }
    setState("seeding");
    (async () => {
      try {
        await convex.mutation(api.seed.seedOrgPhase, {});
        await convex.mutation(api.seed.seedActivityPhase, {});
        sessionStorage.setItem("finserve-seeded", "1");
        setState("ready");
      } catch (err) {
        console.error("Seed failed", err);
        setState("error");
      }
    })();
  }, [convex]);

  return state;
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
