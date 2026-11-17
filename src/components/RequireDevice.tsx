/**
 * Normal-app device gate.
 *
 * Runs once per dashboard mount, registers this browser with the independent
 * Security Department and holds the workspace back unless the device is
 * authorized. The backend repeats the check on every authorized API call, so
 * this screen is only the polite version of a server-side decision.
 */
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { deviceDescriptor } from "@/lib/security/client";
import { useMutation } from "convex/react";
import { Loader2, LogOut, ShieldAlert, ShieldCheck } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

type GateState =
  | { kind: "checking" }
  | { kind: "open" }
  | { kind: "blocked"; status: string; message: string }
  | { kind: "error"; message: string };

export function RequireDevice({ children }: { children: ReactNode }) {
  const register = useMutation(api.security.registerDevice);
  const { signOut } = useAuth();
  const [state, setState] = useState<GateState>({ kind: "checking" });

  useEffect(() => {
    let alive = true;
    const descriptor = deviceDescriptor();
    register({
      fingerprint: descriptor.fingerprint,
      label: descriptor.label,
      platform: descriptor.platform,
      userAgent: descriptor.userAgent,
    })
      .then((result) => {
        if (!alive) return;
        if (result.status === "AUTHORIZED" || result.status === "NOT_APPLICABLE" || result.status === "UNKNOWN") {
          setState({ kind: "open" });
          return;
        }
        setState({
          kind: "blocked",
          status: String(result.status),
          message: result.message ?? "This device is not authorized.",
        });
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Device verification failed.",
        });
      });
    return () => {
      alive = false;
    };
  }, [register]);

  if (state.kind === "open") return <>{children}</>;

  if (state.kind === "checking") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex items-center gap-3 text-xs font-black uppercase tracking-widest text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Verifying device authorization
        </div>
      </main>
    );
  }

  const blocked = state.kind === "blocked";
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md border-2 border-ink bg-card p-6 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
          {blocked ? (
            <ShieldAlert className="size-6 text-destructive" />
          ) : (
            <ShieldCheck className="size-6 text-muted-foreground" />
          )}
        </div>
        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">
          Independent Security Department
        </p>
        <h1 className="mt-2 text-lg font-black uppercase tracking-wide">
          {blocked ? "Device not authorized" : "Device check failed"}
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">{state.message}</p>
        <p className="mt-3 text-[11px] text-muted-foreground">
          {blocked
            ? "Device approval is handled only by Security Operators. SUPER_ADMIN cannot approve, block or revoke devices."
            : "Try again from a supported browser, or contact the Security Department."}
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          className="mt-5 inline-flex items-center gap-2 border-2 border-ink bg-primary px-4 py-2 text-xs font-black uppercase tracking-wider text-primary-foreground"
        >
          <LogOut className="size-3.5" />
          Sign out
        </button>
      </div>
    </main>
  );
}
