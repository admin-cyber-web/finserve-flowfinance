/**
 * Normal-app device gate.
 *
 * This is the polite UI for a server-side decision. The browser proves
 * possession of its non-exportable device key over a fresh challenge; the
 * backend checks the signature and the device status. `requireProfile` repeats
 * the authorization check on every protected API call, so hiding this screen is
 * never enough to use the workspace.
 */
import { api } from "@/convex/_generated/api";
import { useSecurityDevice } from "@/hooks/use-security-device";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "convex/react";
import {
  Loader2,
  LogOut,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

type GateState =
  | { kind: "checking" }
  | { kind: "open" }
  | { kind: "blocked"; status: string; message: string; enrollmentId?: string }
  | { kind: "error"; message: string; enrollmentId?: string };

export function RequireDevice({ children }: { children: ReactNode }) {
  const me = useQuery(api.profiles.me);
  const { signOut } = useAuth();
  const { enroll, verify } = useSecurityDevice();
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const running = useRef(false);

  const staffId = me?.profile?.staffId ?? null;

  const check = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const verified = await verify();
      if (verified.status === "AUTHORIZED") {
        setState({ kind: "open" });
        return;
      }
      if (
        (verified.status === "NOT_ENROLLED" || verified.status === "UNKNOWN") &&
        staffId
      ) {
        const created = await enroll({ staffId });
        setState(
          created.status === "AUTHORIZED"
            ? { kind: "open" }
            : {
                kind: "blocked",
                status: created.status,
                message: created.message,
                enrollmentId: created.enrollmentId,
              },
        );
        return;
      }
      setState({
        kind: "blocked",
        status: verified.status,
        message: verified.message,
        enrollmentId: verified.enrollmentId,
      });
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error
            ? err.message
            : "Device verification failed.",
      });
    } finally {
      running.current = false;
    }
  }, [enroll, staffId, verify]);

  useEffect(() => {
    if (!me) return; // still resolving the signed-in profile
    // The client portal is not a staff workspace and does not use device
    // authorization.
    if (me.profile?.role === "CLIENT") {
      setState({ kind: "open" });
      return;
    }
    // The SUPER_ADMIN / app owner registers and approves devices for everyone
    // else; their own sign-in never waits on device approval.
    if (me.profile?.role === "SUPER_ADMIN") {
      setState({ kind: "open" });
      return;
    }
    void check();
  }, [check, me]);

  // While pending, re-check so an approval takes effect without a reload.
  useEffect(() => {
    if (state.kind !== "blocked" || state.status !== "PENDING") return;
    const timer = setInterval(() => void check(), 15_000);
    return () => clearInterval(timer);
  }, [check, state]);

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
        {"enrollmentId" in state && state.enrollmentId && (
          <p className="mt-3 border-2 border-ink bg-sky px-2 py-1.5 font-mono text-[11px] font-black">
            {state.enrollmentId}
          </p>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          Device approval is handled by authorized Security Operators and SUPER_ADMIN.
          This browser must be enrolled and approved before it can sign in.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void check()}
            className="inline-flex items-center justify-center gap-2 border-2 border-ink bg-white px-4 py-2 text-xs font-black uppercase tracking-wider"
          >
            <RefreshCw className="size-3.5" />
            Check again
          </button>
          <button
            type="button"
            onClick={() => void signOut()}
            className="inline-flex items-center justify-center gap-2 border-2 border-ink bg-primary px-4 py-2 text-xs font-black uppercase tracking-wider text-primary-foreground"
          >
            <LogOut className="size-3.5" />
            Sign out
          </button>
        </div>
      </div>
    </main>
  );
}
